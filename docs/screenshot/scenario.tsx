// The README's screenshot: a made-up but ordinary session driven through the
// real mod under the engine's test kit, its pane printed as the engine hands it
// to the terminal. render.sh copies this into plugin/tests/, runs it and paints the
// result; it is not one of the mod's tests.

import { mock, test } from 'claude-code/testing'
import type { ModelUsage, SessionUsage, TurnStepResult } from 'claude-code'

import { partsTotal, priceUsage } from '../hooks/pricing'

const MIN = 60_000
const TICK = 15_000
const TICKS = 136 // 34 minutes
const END = Date.parse('2026-10-12T20:00:00Z')
const START = END - TICKS * TICK
const RUN = 'wf_7c41e9a2d0'
const REVIEWERS = ['bugs', 'perf', 'api', 'docs', 'tests']
const DONE_AT: Record<string, number> = { bugs: 124, docs: 128, tests: 131 } // perf and api still running

// A gentle wave, so no two steps cost the same.
const wave = (i: number) => 0.5 + 0.5 * Math.sin(i * 1.7) * Math.cos(i * 0.37)

test('screenshot', { timeoutMs: 120_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  mock.env(on, { HOME: '/nowhere', TERM: 'xterm-256color' })
  const s = { usd: 0, ctx: 42_000, five: 37, isCompacted: false }
  on('session.id', () => ({ value: 'screenshot' }))
  on('session.cwd', () => ({ value: '/tmp' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: s.isCompacted ? { window: 1_000_000 } : { tokens: s.ctx, window: 1_000_000, percent: s.ctx / 10_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: s.five, resetsAt: new Date(END + 134 * MIN).toISOString() },
        { kind: 'seven_day', percentUsed: 23.8, resetsAt: new Date(END + (3 * 24 + 9) * 60 * MIN).toISOString() },
      ],
      cost: { usd: s.usd },
    } satisfies SessionUsage,
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // The engine reports no context from a compaction until the next main response.
  on('session.compact', () => {
    s.ctx = 48_000
    s.isCompacted = true
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('agent.spawn', ($, e) => ({
    model: e.subagentType === 'Explore' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5',
    agentId: e.workflow !== undefined ? `rv-${REVIEWERS[e.workflow.agentIndex - 1]}` : e.subagentType === 'Explore' ? 'explore' : 'port',
  }))
  on('turn.step', async function* ($, e) {
    if (e.agentId === undefined) s.isCompacted = false
    const w = wave(e.index)
    const usage: ModelUsage =
      e.agentId === undefined
        ? { input_tokens: 420, output_tokens: Math.round(900 + 2600 * w), cache_read_input_tokens: s.ctx, cache_creation_input_tokens: Math.round(3500 + 9000 * w) }
        : e.agentId === 'explore' || e.agentId === 'port'
          ? { input_tokens: 300, output_tokens: Math.round(500 + 900 * w), cache_read_input_tokens: 30_000 + e.index * 1400, cache_creation_input_tokens: 5200 }
          : { input_tokens: 260, output_tokens: Math.round(1100 + 1500 * w), cache_read_input_tokens: 38_000 + (e.index % 40) * 900, cache_creation_input_tokens: Math.round(8000 + 6000 * w) }
    if (e.turnId === 'live') {
      // Still streaming when the pane is drawn.
      yield { kind: 'text', index: 0, text: 'x'.repeat(e.agentId === undefined ? 5400 : 1700) } as never
      await clock.sleep(5000)
    }
    const parts = priceUsage(e.model, usage, e.agentId === undefined ? '1h' : '5m')
    s.usd += (parts === undefined ? 0 : partsTotal(parts)) + (e.agentId === undefined ? 0.0035 : 0)
    if (e.agentId === undefined) s.ctx += usage.cache_creation_input_tokens
    const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, ...usage } }
    return result
  })

  const step = async (model: string, index: number, agentId?: string) => {
    for await (const _ of $.turn.step({ turnId: 't', index, model, messageCount: 3, agentId })) {
      // drained
    }
  }
  const spawn = (description: string, subagentType: string, workflow?: { runId: string; agentIndex: number }) =>
    $.agent.spawn({
      tool_use_id: workflow === undefined ? `tu_${subagentType}` : 'tu_review',
      prompt: 'p',
      description,
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
      workflow,
    })

  const began = performance.now()
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'spend', args: 'budget 25', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  await $.turn.start({ text: 'refactor', turnId: 't' })
  for (let t = 0; t < TICKS; t++) {
    await clock.advance(TICK)
    s.five += 0.075
    const isReview = t >= 104
    if (t === 6) await spawn('map the auth flow', 'Explore')
    if (t >= 6 && t <= 30) await step('claude-haiku-5-5', t, 'explore')
    if (t === 31) await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'explore', reason: 'answer' })
    if (t === 62) await spawn('port the token cache', 'general-purpose')
    if (t >= 62 && t <= 80) await step('claude-sonnet-5-5', t, 'port')
    if (t === 81) await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'port', reason: 'answer' })
    if (t === 84) await $.session.compact({ trigger: 'auto', messages: [{ role: 'user' as const, text: 'hello', toolUses: [] }] })
    if (t === 99) {
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
      await $.turn.start({ text: 'review', turnId: 't2' })
    }
    const mainEvery = isReview ? 6 : t >= 32 && t < 99 ? 2 : 3
    if (t % mainEvery === 0) await step('claude-opus-5-5', t)
    if (t === 104) {
      await $.tool.call({ tool: 'Workflow', tool_use_id: 'tu_review', name: 'review-changes' } as never)
      for (const [k, name] of REVIEWERS.entries()) await spawn(`review:${name}`, 'general-purpose', { runId: RUN, agentIndex: k + 1 })
    }
    if (isReview) {
      for (const [k, name] of REVIEWERS.entries()) {
        const done = DONE_AT[name]
        if (done !== undefined && t > done) continue
        if ((t + k) % 2 === 0) await step('claude-sonnet-5-5', t * 10 + k, `rv-${name}`)
        if (t === done) await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: `rv-${name}`, reason: 'answer' })
      }
    }
  }
  // Three requests in flight, asleep on the clock until after the pane is
  // drawn: the kit waits on open work, never on work the clock holds.
  const live = [
    $.turn.step({ turnId: 'live', index: 0, model: 'claude-opus-5-5', messageCount: 3 }),
    $.turn.step({ turnId: 'live', index: 1, model: 'claude-sonnet-5-5', messageCount: 3, agentId: 'rv-perf' }),
    $.turn.step({ turnId: 'live', index: 2, model: 'claude-sonnet-5-5', messageCount: 3, agentId: 'rv-api' }),
  ].map(stream => stream[Symbol.asyncIterator]())
  for (const it of live) await it.next()
  await clock.advance(1000)

  const props = { title: 'Spend', isFocused: false, bodyColumns: 44, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 52 }, view: {} }
  for (const [name, gfx] of [['CELLS', 'cells'], ['PIXELS', 'pixels']] as const) {
    await $.command.run({ command: 'spend', args: `gfx ${gfx}`, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    const ui = await $.ui.mount({ plugin: 'spend-meter', surface: 'terminal', component: 'Pane', requestId: 'spend', props })
    if (name === 'CELLS') await ui.press({ key: `src:wf:${RUN}` })
    console.log(`TREE_${name}${JSON.stringify(await ui.drawn())}`)
    await ui.unmount()
  }
  console.log(`TOOK ${Math.round(performance.now() - began)}ms`)
})
