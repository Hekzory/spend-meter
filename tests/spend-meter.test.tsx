import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage, TurnStepResult } from 'claude-code'

import { areaCells } from '../hooks/art'
import { addToSeries, barsOf, burnPerMin, EMPTY_SERIES, fmtUsd, pace, PALETTE } from '../hooks/ledger'
import { catalogId, partsTotal, priceUsage } from '../hooks/pricing'
import type { Parts } from '../hooks/pricing'

const NOW = Date.parse('2026-10-12T20:00:00Z')

const usageOf = (usd: number): SessionUsage => ({
  startedAt: NOW - 60_000,
  context: { tokens: 200_000, window: 1_000_000, percent: 20 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-12T23:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 31 },
  ],
  cost: { usd },
})

const STEP_USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 100_000,
  cache_creation_input_tokens: 10_000,
}

/** The engine beneath the plugin: a session that has cost `bill.usd` so far. */
function engine(on: On, bill: { usd: number }) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nowhere', TERM: 'xterm-256color' })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/tmp' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: usageOf(bill.usd) }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.spawn', ($, e) => ({ model: 'claude-haiku-5-5', agentId: e.description === 'scan' ? 'wf-1' : 'a-1' }))
  on('turn.step', async function* ($, e) {
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { ...STEP_USAGE, model: e.model },
    }
    return result
  })
}

async function step($: Engine, model: string, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 3, agentId })
  for await (const _ of stream) {
    // drained
  }
  return stream.result
}

/** Whole micro-dollars, so float noise cannot fail a price check. */
const micro = (usd: number | Parts | undefined) =>
  usd === undefined ? undefined : Math.round((typeof usd === 'number' ? usd : partsTotal(usd)) * 1e6)

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'spend', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

const PANE_PROPS = (placement: 'dock' | 'inline', bodyColumns: number, bodyRows: number) => ({
  title: 'Spend',
  isFocused: false,
  bodyColumns,
  placement,
  scroll: { offset: 0, bodyRows },
  view: {},
})

const spawnArgs = (description: string, workflow?: { runId: string; agentIndex: number }) => ({
  tool_use_id: 'toolu_1',
  prompt: 'look around',
  description,
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
  ...(workflow === undefined ? {} : { workflow }),
})

describe('prices', () => {
  test('dated and provider ids resolve to the catalog entry', () => {
    expect(catalogId('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(catalogId('claude-opus-5-20260101')).toBe('claude-opus-5')
    expect(catalogId('us.anthropic.claude-fable-5-1-v1:0')).toBe('claude-fable-5-1')
    expect(catalogId('claude-fable-5-1[1m]')).toBe('claude-fable-5-1')
    expect(catalogId('gpt-9')).toBeUndefined()
  })

  test('a response is priced as the catalog prices it', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 / $8 cache write (5 min / 1 h).
    expect(micro(priceUsage('claude-opus-5-5', STEP_USAGE, '1h'))).toBe(144_000)
    expect(micro(priceUsage('claude-opus-5-5', STEP_USAGE, '5m'))).toBe(114_000)
    // Haiku 5.5 prices a prompt over 100k at its long-prompt rates.
    expect(micro(priceUsage('claude-haiku-5-5', STEP_USAGE, '5m'))).toBe(500 + 5000 + 5000 + 6250)
    expect(priceUsage('mystery-model', STEP_USAGE, '5m')).toBeUndefined()
  })

  test('a price splits into what was paid for', () => {
    const p = priceUsage('claude-opus-5-5', STEP_USAGE, '1h')!
    expect([micro(p.output), micro(p.write), micro(p.read), micro(p.input)]).toEqual([40_000, 80_000, 20_000, 4000])
  })
})

describe('ledger', () => {
  test('the chart stacks main thread, subagents and workflows inside a cell', () => {
    // One bar, one cell tall: half main thread, half subagents.
    const [cell] = areaCells([{ main: 1, agents: 1, workflows: 0, isCompacted: false }], 1)
    expect(cell).toEqual([0x2584, PALETTE.main, PALETTE.agents]) // lower half: main; upper: subagents
    // An empty column where the session compacted draws the guide line.
    const cells = areaCells([{ main: 1, agents: 0, workflows: 0, isCompacted: false }, { main: 0, agents: 0, workflows: 0, isCompacted: true }], 2)
    expect(cells[1]?.[0]).toBe(0x2502)
    const s = addToSeries(EMPTY_SERIES, NOW, { main: 1, agents: 0, workflows: 0 })
    expect(barsOf(s, NOW, 3, [NOW]).map(b => b.isCompacted)).toEqual([false, false, true])
  })

  test('burn is averaged over what the session has had', () => {
    let s = addToSeries(EMPTY_SERIES, NOW, { main: 0, agents: 0, workflows: 0 })
    s = addToSeries(s, NOW + 30_000, { main: 1, agents: 0.2, workflows: 0 })
    expect(micro(burnPerMin(s, NOW + 30_000))).toBe(1_200_000)
    expect(burnPerMin(s, NOW + 20 * 60_000)).toBe(0)
  })

  test('a window climbing fast is called short before it resets', () => {
    const w = {
      first: 10,
      last: 40,
      carried: 0,
      resetsAt: new Date(NOW + 4 * 3600_000).toISOString(),
      samples: [
        [NOW - 10 * 60_000, 10],
        [NOW, 40],
      ] as [number, number][],
    }
    const p = pace(w, NOW)
    expect(micro(p?.perMin)).toBe(3_000_000)
    expect(p?.isShort).toBe(true)
    expect(fmtUsd(0.042)).toBe('$0.042')
  })
})

describe('the meter in a session', () => {
  test('main, subagent and workflow responses land on their own rows', async ($, on) => {
    const bill = { usd: 2 }
    engine(on, bill)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

    await step($, 'claude-opus-5-5')
    await $.agent.spawn(spawnArgs('find the auth flow'))
    await step($, 'claude-opus-5-5', 'a-1')
    await $.agent.spawn(spawnArgs('scan', { runId: 'wf_abc123xyz', agentIndex: 1 }))
    await step($, 'claude-haiku-5-5', 'wf-1')

    const ui = await $.ui.mount({
      plugin: 'spend-meter',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'spend',
      props: PANE_PROPS('dock', 60, 80),
    })
    expect((await ui.find({ key: 'src:main' }))?.text).toMatch(/main thread · Opus 5\.5 +\$0\.14/)
    expect((await ui.find({ key: 'src:agent:a-1' }))?.text).toMatch(/● Explore · find the auth flow +\$0\.11/)
    expect((await ui.find({ key: 'src:wf:wf_abc123xyz' }))?.text).toMatch(/workflow abc123 +\$0\.01[67]/)

    await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', agentId: 'a-1', reason: 'answer' })
    expect((await ui.find({ key: 'src:agent:a-1' }))?.text).toMatch(/^✓ Explore/)
    await ui.press({ key: 'src:wf:wf_abc123xyz' })
    expect(await ui.find({ text: /1 agent:/ })).toBeDefined()
    await ui.unmount()
  })

  test('an open workflow fits the pane at its default width', async ($, on) => {
    engine(on, { usd: 2 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.agent.spawn(spawnArgs('a reviewer with a long name', { runId: 'wf_abc123xyz', agentIndex: 1 }))
    await step($, 'claude-haiku-5-5', 'wf-1')
    const ui = await $.ui.mount({ plugin: 'spend-meter', surface: 'terminal', component: 'Pane', requestId: 'spend', props: PANE_PROPS('dock', 44, 80) })
    await ui.press({ key: 'src:wf:wf_abc123xyz' })
    // 44 columns, less the pane's padding and the details' indent: 40 for each line.
    for (const text of [/^\S+ out · \S+ cached · \S+ re-read$/, /^ +● a reviewer with.* \$[\d.]+$/, /^\$\S+ per request.*$/]) {
      const line = (await ui.find({ text }))?.text ?? ''
      expect(line.length).toBeGreaterThan(0)
      expect([...line].length).toBeLessThanOrEqual(40)
    }
    await ui.unmount()
  })

  test('the session total is the engine’s, and a late start is kept apart', async ($, on) => {
    const bill = { usd: 7.5 }
    engine(on, bill)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'spend-meter',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'spend',
      props: PANE_PROPS('dock', 44, 80),
    })
    expect(await ui.find({ text: /before the meter +\$7\.50/ })).toBeDefined()
    expect(await ui.find({ text: 'LIMITS' })).toBeDefined()
    expect(await ui.find({ text: /^5h $/ })).toBeDefined()
    await ui.unmount()
  })

  test('/spend budget sets a budget and /spend help lists the verbs', async ($, on) => {
    engine(on, { usd: 3 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const set = await run($, 'budget $25')
    expect(set.text).toBe('Budget set: $25.00 ($3.00 spent so far).')
    const bad = await run($, 'budget lots')
    expect(bad.text).toContain('Not an amount')
    const help = await run($, 'help')
    expect(help.text).toContain('/spend budget 25')
  })

  test('the pane draws on every surface that seats one, and its unit button cycles', async ($, on) => {
    engine(on, { usd: 12.47 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await step($, 'claude-opus-5-5')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'spend-meter',
        surface,
        component: 'Pane',
        requestId: 'spend',
        props: PANE_PROPS('dock', 44, 60),
        viewport: { columns: 160, rows: 60, isFullscreen: true },
      })
      expect(await ui.find({ text: /WHERE IT GOES/ })).toBeDefined()
      expect(await ui.find({ text: /main thread · Opus 5\.5/ })).toBeDefined()
      expect((await ui.find({ text: /^written by models/ }))?.text).toMatch(/written by models +2\.0k +\$0\.04/)
      expect((await ui.find({ text: /^re-read from cache/ }))?.text).toMatch(/re-read from cache +100k +\$0\.020/)
      expect(await ui.find({ text: /cache served 90% of input/ })).toBeDefined()
      // The unit is a preference: it carries from one surface's drawing to the next.
      const units = ['USD', 'tokens', 'flat whites', 'bananas', 'engineer']
      const before = (await ui.find({ key: 'caption' }))?.text ?? ''
      const at = units.findIndex(u => before.includes(u))
      expect(at).toBeGreaterThanOrEqual(0)
      await ui.press({ key: 'caption' })
      expect((await ui.find({ key: 'caption' }))?.text).toContain(units[(at + 1) % units.length]!)
      await ui.press({ key: 'caption' })
      expect((await ui.find({ key: 'caption' }))?.text).toContain(units[(at + 2) % units.length]!)
      // What the cache does is said on demand, in the session's own figures.
      expect(await ui.find({ text: /resends the whole conversation/ })).toBeUndefined()
      await ui.press({ key: 'cache' })
      expect((await ui.find({ text: /resends the whole conversation/ }))?.text).toMatch(
        /re-read it at 0\.05× on Opus 5\.5\. Without the cache, the 100k re-read tokens would have cost ≈ \$0\.40, not \$0\.020/,
      )
      await ui.press({ key: 'cache' })
      expect(await ui.find({ text: /resends the whole conversation/ })).toBeUndefined()
      // No footer: no tips, no links, nothing that only fills space.
      expect(await ui.find({ text: /tips|history/ })).toBeUndefined()
      // A row's details are a toggle, and the selection carries across surfaces too.
      const wasOpen = (await ui.find({ text: /per request/ })) !== undefined
      await ui.press({ key: 'src:main' })
      expect((await ui.find({ text: /per request/ })) !== undefined).toBe(!wasOpen)
      await ui.unmount()
    }
  })

  test('a compaction is marked by the context gauge, and nothing resets', async ($, on) => {
    engine(on, { usd: 5 })
    on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await step($, 'claude-opus-5-5')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user' as const, text: 'hello', toolUses: [] }] })
    const ui = await $.ui.mount({ plugin: 'spend-meter', surface: 'terminal', component: 'Pane', requestId: 'spend', props: PANE_PROPS('dock', 44, 80) })
    expect(await ui.find({ text: /compacted 0s ago · 200k → …/ })).toBeDefined()
    expect(await ui.find({ text: /main thread · Opus 5\.5 +\$0\.14/ })).toBeDefined()
    await ui.unmount()
  })

  test('the inline placement draws the compact meter', async ($, on) => {
    engine(on, { usd: 0.42 })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'spend-meter',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'spend',
      props: PANE_PROPS('inline', 100, 10),
    })
    expect(await ui.find({ text: '$0.42' })).toBeDefined()
    expect(await ui.find({ text: /WHERE IT GOES/ })).toBeUndefined()
    await ui.unmount()
  })
})
