import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { SpendAgentMeta, SpendCore, SpendLive, SpendPrefs } from '../types'
import {
  absorbUsage,
  addStep,
  addToSeries,
  attribute,
  EMPTY_SERIES,
  EMPTY_SOURCES,
  ensureRow,
  finishAgent,
  fmtEta,
  fmtUsd,
  pace,
} from './ledger'
import { rebuild } from './history'
import type { TranscriptFile } from './history'
import { outputRate, partsTotal, priceUsage } from './pricing'
import type { Parts } from './pricing'
import { chipText, clockText, drawPane, UNITS } from './view'

const PANE = 'spend'
const TITLE = 'Spend'
const TICK_MS = 250
const POLL_EVERY = 4 // ticks: the engine's figures once a second
// The ledger's format: a session whose ledger is older is read back from its transcripts again.
const LEDGER = 2

const DEFAULT_PREFS: SpendPrefs = { unit: 0, chip: true, eggs: true, budget: null, open: true, selected: null }
const IDLE: SpendLive = { tick: 0, inflight: 0, estUsd: 0, keys: [], flash: null }

const core = atom({ plugin: 'spend-meter', key: 'core' } as const, null)
const sources = atom({ plugin: 'spend-meter', key: 'sources' } as const, EMPTY_SOURCES)
const series = atom({ plugin: 'spend-meter', key: 'series' } as const, EMPTY_SERIES)
const prefs = atom({ plugin: 'spend-meter', key: 'prefs' } as const, DEFAULT_PREFS)
const live = atom({ plugin: 'spend-meter', key: 'live' } as const, IDLE)

const MILESTONES: readonly [number, string][] = [
  [1, 'First dollar. Frame it.'],
  [Math.PI, 'π dollars. Irrational, yet here we are.'],
  [10, 'Double digits: the meter is warming up.'],
  [42, '$42: the answer to life, the universe, and this session.'],
  [100, 'Triple digits. Worth a look at who is spending it.'],
  [256, '$256: a round number, in binary.'],
  [1000, 'Four digits. Somewhere a GPU fan spins a little faster.'],
]

const HELP = [
  '/spend              toggle the meter pane',
  '/spend budget 25    alert at 50 %, 80 % and 100 % of $25 (budget off clears it)',
  '/spend chip         the one-line meter under the prompt while the pane is closed',
  '/spend unit         cycle what the big number counts',
  '/spend milestones on|off   a toast at $1, $10, $100 and a few rounder numbers',
  '/spend gfx auto|cells|pixels   the chart as block cells, or as a kitty-protocol picture',
  '/spend rebuild      read the session back from its transcripts again',
  'In the pane: press the line under the total to change units, a row of "where it goes"',
  'for its model, tokens, cache hit and agents, and the ? by "cache served" for what it means.',
].join('\n')

type Flight = { key: string; model: string; chars: number }
type Held = { agentId?: string; model: string; usage: ModelUsage; parts: Parts | undefined; at: number }

// The module's own memory: gone on a reload, rebuilt from `$.state` where it matters.
const mem = {
  agents: {} as Record<string, SpendAgentMeta>,
  isSubscriber: false,
  isPaneOpen: false,
  chip: undefined as string | undefined,
  ticks: 0,
  isPolling: false,
  /** Set when a response finished: the total is read again at the next tick. */
  isStale: false,
  wasBusy: false,
  flashUntil: 0,
  flights: new Map<string, Flight>(),
  split: { main: 0, agents: 0, workflows: 0 },
  /** What the terminal draws a picture with: kitty-protocol pixels, or cells. */
  gfx: 'cells' as 'cells' | 'pixels',
  /** Responses that finished while the transcripts were being read back. */
  backfilling: false,
  /** What the pane last showed that moves with the clock alone; see `clockText`. */
  clock: undefined as string | undefined,
  /** The subagent whose transcript the person has on screen, as the pane was last drawn. */
  viewedAgentId: undefined as string | undefined,
  held: [] as Held[],
}

// ─── the session's past ──────────────────────────────────────────────────────

async function backfill($: EngineInterface, cwd: string, force: boolean): Promise<number> {
  const before = await read($, core)
  if (mem.backfilling || ((before?.ledger ?? 0) >= LEDGER && !force)) return -1
  mem.backfilling = true
  let found = 0
  try {
    const cutoff = await $.clock.now()
    const r = rebuild(await sessionFiles($, cwd), cutoff)
    found = r.responses
    if (r.responses > 0) {
      const s = await update($, sources, live => ({
        ...r.sources,
        agents: { ...r.sources.agents, ...live.agents },
        workflows: { ...live.workflows },
      }))
      mem.agents = s.agents
      await update($, series, () => r.series)
    }
    await update($, core, c => {
      if (c === null) return c
      const turn =
        c.turn ?? (r.turn === undefined ? null : { startedAt: r.turn.startedAt, usd0: c.usd - r.turn.usd, endedAt: r.turn.endedAt, usd1: c.usd })
      const compactions = [...r.compactions, ...(c.compactions ?? []).filter(one => one.at > cutoff)].slice(-20)
      return { ...c, ledger: LEDGER, usd0: r.responses > 0 ? 0 : c.usd0, turn, compactions }
    })
  } finally {
    mem.backfilling = false
    const held = mem.held.splice(0)
    if (held.length > 0) {
      await update($, sources, s => held.reduce((acc, one) => addStep(acc, attribute(one.agentId, acc), one.model, one.usage, one.parts, one.at), s))
    }
  }
  return found
}

const CHUNK = 3 * 1024 * 1024

/** A file's text, whole: one read under the read cap, else in `dd` chunks. */
async function readText($: EngineInterface, path: string, size: number): Promise<string> {
  if (size <= 3_900_000) return String(await $.fs.read(path))
  let text = ''
  for (let k = 0; k * CHUNK < size; k++) {
    const r = await $.process.run(['dd', `if=${path}`, `bs=${CHUNK}`, `skip=${k}`, 'count=1', 'status=none'], {
      timeoutMs: 20_000,
    })
    if (r.exitCode !== 0) break
    text += r.stdout
  }
  return text
}

async function readMeta($: EngineInterface, path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Every transcript of this session: the main thread's, its subagents', its workflows'. */
export async function sessionFiles($: EngineInterface, cwd: string): Promise<TranscriptFile[]> {
  const id = await $.session.id()
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const projects = `${config}/projects`
  let main = `${projects}/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
  if (!(await $.fs.exists(main))) {
    main = ''
    for (const dir of await $.fs.list(projects).catch(() => [])) {
      const candidate = `${projects}/${dir.name}/${id}.jsonl`
      if (dir.kind === 'dir' && (await $.fs.exists(candidate))) {
        main = candidate
        break
      }
    }
    if (main === '') return []
  }
  const root = main.slice(0, -'.jsonl'.length)
  const files: TranscriptFile[] = [{ text: await readText($, main, (await $.fs.stat(main)).size) }]

  for (const e of await $.fs.list(`${root}/subagents`).catch(() => [])) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(e.name)?.[1]
    if (e.kind !== 'file' || agentId === undefined) continue
    const meta = await readMeta($, `${root}/subagents/agent-${agentId}.meta.json`)
    const type = typeof meta['agentType'] === 'string' ? meta['agentType'] : 'agent'
    const description = typeof meta['description'] === 'string' ? meta['description'] : agentId
    files.push({
      agentId,
      meta: { label: `${type} · ${description}`, type },
      text: await readText($, `${root}/subagents/${e.name}`, e.size),
    })
  }

  // A run's name is in its saved script's file name: `<name>-<runId>.js`.
  const names: Record<string, string> = {}
  for (const e of await $.fs.list(`${root}/workflows/scripts`).catch(() => [])) {
    const m = /^(.+)-(wf_[^.]+)\.js$/.exec(e.name)
    if (m !== null) names[m[2]!] = m[1]!
  }
  for (const run of await $.fs.list(`${root}/subagents/workflows`).catch(() => [])) {
    if (run.kind !== 'dir') continue
    const runId = run.name
    const label = names[runId] ?? `workflow ${runId.slice(3, 9)}`
    for (const e of await $.fs.list(`${root}/subagents/workflows/${runId}`).catch(() => [])) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(e.name)?.[1]
      if (e.kind !== 'file' || agentId === undefined) continue
      const meta = await readMeta($, `${root}/subagents/workflows/${runId}/agent-${agentId}.meta.json`)
      const type = typeof meta['description'] === 'string' ? meta['description'] : 'agent'
      files.push({
        agentId,
        meta: { label, type, runId },
        text: await readText($, `${root}/subagents/workflows/${runId}/${e.name}`, e.size),
      })
    }
  }
  return files
}

async function detectGfx($: EngineInterface): Promise<'cells' | 'pixels'> {
  // As Claude Code decides where its Image draws pixels: kitty and Ghostty,
  // never through a multiplexer, or wherever it is told to.
  if ((await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) !== undefined) return 'pixels'
  if ((await $.env.get('TMUX')) !== undefined || (await $.env.get('STY')) !== undefined) return 'cells'
  const term = (await $.env.get('TERM')) ?? ''
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  if ((await $.env.get('KITTY_WINDOW_ID')) !== undefined || term === 'xterm-kitty' || program === 'kitty') return 'pixels'
  if (program === 'ghostty' || term === 'xterm-ghostty') return 'pixels'
  return 'cells'
}

// ─── the engine's figures ────────────────────────────────────────────────────

async function tick($: EngineInterface) {
  mem.ticks += 1
  const isBusy = mem.flights.size > 0 || mem.flashUntil > 0
  if (isBusy || mem.wasBusy) await animate($)
  mem.wasBusy = isBusy
  if ((mem.ticks % POLL_EVERY === 0 || mem.isStale) && !mem.isPolling) {
    mem.isPolling = true
    mem.isStale = false
    try {
      await measure($)
    } finally {
      mem.isPolling = false
    }
  }
}

async function measure($: EngineInterface) {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  mem.isPaneOpen = pane !== undefined && pane.isPlaced && pane.isShown
  const u = await $.session.usage()
  const now = await $.clock.now()
  const p = await read($, prefs)
  let before = await read($, core)
  if (before !== null && (u.cost?.usd ?? before.usd) < before.usd - 1e-9) {
    await resetSession($)
    before = null
  }

  // A session standing still writes nothing, so nothing is drawn again: the clock alone
  // redraws a quiet pane, when the text it moves changes (`redrawOnClock`).
  const isStill = before !== null && isQuiet(before, absorbUsage(before, u, now), p, now)
  let raised: string[] = []
  const after = isStill ? before : await update($, core, c => {
    const n = absorbUsage(c, u, now)
    raised = c === null ? [] : alertsFor(c, n, p, now)
    // Milestones already behind a session the meter joins late stay quiet.
    const quiet = c === null ? MILESTONES.filter(([m]) => n.usd >= m).map(([m]) => `m:${m}`) : []
    return { ...n, fired: [...n.fired, ...quiet, ...raised].slice(-512) }
  })
  mem.isSubscriber = after?.isSubscriber ?? false

  const parts = { ...mem.split }
  mem.split.main = mem.split.agents = mem.split.workflows = 0
  // An empty bucket is not written: the chart and the burn count the buckets since the last.
  if (parts.main + parts.agents + parts.workflows > 0) await update($, series, s => addToSeries(s, now, parts))
  // The context a compaction left, once a response has measured it.
  const last = after?.compactions?.at(-1)
  if (last !== undefined && last.to === undefined && u.context.tokens !== undefined && now - last.at > 1000) {
    const to = u.context.tokens
    await update($, core, c =>
      c === null ? c : { ...c, compactions: (c.compactions ?? []).map((one, i, all) => (i === all.length - 1 ? { ...one, to } : one)) },
    )
  }

  // A budget set below what is already spent says its highest step alone.
  const steps = raised.filter(id => id.startsWith('b:')).map(id => Number(id.split(':')[2]))
  const top = Math.max(0, ...steps)
  const said = raised.filter(id => !id.startsWith('b:') || Number(id.split(':')[2]) === top)
  if (after !== null) for (const id of said) announce($, id, after, p, now)
  await showChip($)
  if (mem.isPaneOpen) await redrawOnClock($, after, p, now)
}

/** Whether a reading differs from the last only in when it was taken, and raises nothing. */
function isQuiet(prev: SpendCore, next: SpendCore, p: SpendPrefs, now: number): boolean {
  return JSON.stringify({ ...prev, at: 0 }) === JSON.stringify({ ...next, at: 0 }) && alertsFor(prev, next, p, now).length === 0
}

/** Draws the pane again when what it shows moved with the clock alone. */
async function redrawOnClock($: EngineInterface, c: SpendCore | null, p: SpendPrefs, now: number) {
  const [se, so] = await Promise.all([read($, series), read($, sources)])
  const text = clockText({ now, core: c, series: se, sources: so, prefs: p, viewedAgentId: mem.viewedAgentId })
  if (text === mem.clock) return
  const isFirst = mem.clock === undefined
  mem.clock = text
  if (!isFirst) $.ui.invalidate('ui.render')
}

function alertsFor(prev: SpendCore, next: SpendCore, p: SpendPrefs, now: number): string[] {
  const ids: string[] = []
  const fresh = (id: string) => !next.fired.includes(id) && !ids.includes(id)
  if (p.eggs) {
    for (const [m] of MILESTONES) if (prev.usd < m && next.usd >= m && fresh(`m:${m}`)) ids.push(`m:${m}`)
  }
  if (p.budget !== null && p.budget > 0) {
    for (const step of [50, 80, 100]) {
      const id = `b:${p.budget}:${step}`
      if (next.usd >= (p.budget * step) / 100 && fresh(id)) ids.push(id)
    }
  }
  const w = next.windows['five_hour']
  const pc = w === undefined ? undefined : pace(w, now)
  if (pc?.isShort === true && pc.fullAt !== undefined && pc.fullAt - now < 3 * 3600_000) {
    const id = `p:${Math.floor(now / (20 * 60_000))}`
    if (fresh(id)) ids.push(id)
  }
  return ids
}

function announce($: EngineInterface, id: string, c: SpendCore, p: SpendPrefs, now: number) {
  if (id.startsWith('m:')) {
    const line = MILESTONES.find(([m]) => `m:${m}` === id)?.[1]
    if (line !== undefined) $.ui.toast(`${fmtUsd(c.usd)} · ${line}`)
    return
  }
  if (id.startsWith('b:') && p.budget !== null) {
    const step = Number(id.split(':')[2])
    if (step >= 100) {
      const text = `Budget of ${fmtUsd(p.budget)} reached: ${fmtUsd(c.usd)} spent this session.`
      $.ui.toast(text, { timeoutMs: 8000 })
      void $.ui.notify(text, { title: 'Spend meter' }).catch(() => undefined)
    } else {
      $.ui.toast(`${step} % of the ${fmtUsd(p.budget)} budget spent (${fmtUsd(c.usd)}).`)
    }
    return
  }
  if (id.startsWith('p:')) {
    const w = c.windows['five_hour']
    const pc = w === undefined ? undefined : pace(w, now)
    if (pc?.fullAt === undefined) return
    const reset = pc.resetAt === undefined ? '' : ` (it resets in ${fmtEta(pc.resetAt - now)})`
    $.ui.toast(`⚠ 5-hour limit: full in ~${fmtEta(pc.fullAt - now)} at this pace${reset}.`, { timeoutMs: 8000 })
  }
}

async function showChip($: EngineInterface) {
  const p = await read($, prefs)
  const text = !mem.isPaneOpen && p.chip ? chipText(await read($, core), await read($, live)) : undefined
  if (text === mem.chip) return
  mem.chip = text
  $.ui.status(text)
}

async function resetSession($: EngineInterface) {
  await update($, core, () => null)
  await update($, sources, () => EMPTY_SOURCES)
  await update($, series, () => EMPTY_SERIES)
  await update($, prefs, p => ({ ...p, selected: null }))
  mem.agents = {}
  mem.flights.clear()
}

// ─── what is streaming now ───────────────────────────────────────────────────

async function animate($: EngineInterface) {
  const now = await $.clock.now()
  if (mem.flashUntil > 0 && mem.flashUntil <= now) mem.flashUntil = 0
  let estUsd = 0
  for (const f of mem.flights.values()) estUsd += ((f.chars / 3.6) * outputRate(f.model)) / 1e6
  const keys = [...new Set([...mem.flights.values()].map(f => f.key))]
  const isBusy = mem.flights.size > 0 || mem.flashUntil > 0
  // With the pane away, the chip only needs the count now and then.
  if (isBusy && !mem.isPaneOpen && mem.ticks % POLL_EVERY !== 0) return
  await update($, live, l => ({
    tick: isBusy ? l.tick + 1 : l.tick,
    inflight: mem.flights.size,
    estUsd,
    keys,
    flash: mem.flashUntil > 0 ? { kind: 'brrr' as const, until: mem.flashUntil } : null,
  }))
}

// ─── preferences and the pane ────────────────────────────────────────────────

async function setPrefs($: EngineInterface, change: (p: SpendPrefs) => SpendPrefs): Promise<SpendPrefs> {
  const p = await update($, prefs, change)
  await $.store.set('prefs', { unit: p.unit, chip: p.chip, eggs: p.eggs, budget: p.budget, open: p.open, gfx: p.gfx ?? 'auto' })
  return p
}

async function setOpen($: EngineInterface, want: boolean | undefined): Promise<string> {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  // Open but waiting for room, or a tab behind another pane, counts as closed:
  // the person asking for it then brings it up rather than putting it away.
  const isUp = pane !== undefined && pane.isPlaced && pane.isShown
  const open = want ?? !isUp
  if (!open) {
    if (pane !== undefined) await $.ui.close({ id: PANE })
    mem.isPaneOpen = false
    const p = await setPrefs($, x => ({ ...x, open: false }))
    await showChip($)
    return p.chip ? 'Spend meter closed; its chip stays under the prompt (/spend chip hides it).' : 'Spend meter closed.'
  }
  const placed = await $.ui.open({ id: PANE, title: TITLE, columns: 44 })
  mem.isPaneOpen = placed.isPlaced
  await setPrefs($, x => ({ ...x, open: true }))
  await showChip($)
  if ((await $.store.get('welcomed')) !== true) {
    await $.store.set('welcomed', true)
    $.ui.toast('Spend meter: press a row for its details · /spend help', { timeoutMs: 7000 })
  }
  return placed.isPlaced ? 'Spend meter open.' : `Spend meter open, waiting for room: ${placed.reason}`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = '', arg] = args.trim().toLowerCase().split(/\s+/)
  switch (verb) {
    case '':
      return setOpen($, undefined)
    case 'on':
    case 'open':
    case 'show':
      return setOpen($, true)
    case 'off':
    case 'close':
    case 'hide':
      return setOpen($, false)
    case 'budget': {
      if (arg === undefined) {
        const p = await read($, prefs)
        return p.budget === null ? 'No budget set; /spend budget 25 sets one.' : `Budget: ${fmtUsd(p.budget)}.`
      }
      if (arg === 'off' || arg === 'none' || arg === '0') {
        await setPrefs($, p => ({ ...p, budget: null }))
        return 'Budget cleared.'
      }
      const usd = Number(arg.replace(/^\$/, ''))
      if (!Number.isFinite(usd) || usd <= 0) return `Not an amount: ${arg}. Try /spend budget 25.`
      await setPrefs($, p => ({ ...p, budget: usd }))
      const c = await read($, core)
      return `Budget set: ${fmtUsd(usd)} (${fmtUsd(c?.usd ?? 0)} spent so far).`
    }
    case 'chip': {
      const p = await setPrefs($, x => ({ ...x, chip: arg === 'on' ? true : arg === 'off' ? false : !x.chip }))
      await showChip($)
      return p.chip ? 'Chip on: shown under the prompt while the pane is closed.' : 'Chip off.'
    }
    case 'unit': {
      const p = await setPrefs($, x => ({ ...x, unit: (x.unit + 1) % UNITS.length }))
      return `The big number now counts ${UNITS[p.unit]!.label}.`
    }
    case 'milestones': {
      const p = await setPrefs($, x => ({ ...x, eggs: arg === 'on' ? true : arg === 'off' ? false : !x.eggs }))
      return p.eggs ? 'Milestone toasts on.' : 'Milestone toasts off.'
    }
    case 'brrr':
      mem.flashUntil = (await $.clock.now()) + 3600
      return 'money printer go brrr'
    case 'gfx': {
      const want = arg === 'cells' || arg === 'pixels' || arg === 'auto' ? arg : undefined
      if (want === undefined) {
        const p = await read($, prefs)
        return `Chart drawn as ${p.gfx === 'cells' || p.gfx === 'pixels' ? p.gfx : `${mem.gfx} (auto)`}; /spend gfx auto|cells|pixels changes it.`
      }
      await setPrefs($, x => ({ ...x, gfx: want }))
      return want === 'auto' ? `Chart drawn as ${mem.gfx}, as this terminal takes.` : `Chart drawn as ${want}.`
    }
    case 'rebuild': {
      const found = await backfill($, await $.session.cwd(), true)
      return found < 0 ? 'Already reading the transcripts.' : `Read ${found} responses back from the transcripts.`
    }
    default:
      return HELP
  }
}

// ─── the hooks ───────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    mem.agents = (await read($, sources)).agents
    await $.command.register({
      name: 'spend',
      description: 'Toggle the live spend meter: cost with subagents and workflows, limits, burn rate',
      argumentHint: '[budget <usd>|chip|unit|milestones|help]',
      immediate: true,
    })
    const held = await $.state.get({ plugin: 'spend-meter', key: 'prefs' })
    if (held.version === 0) {
      const stored = await $.store.get('prefs')
      const saved = typeof stored === 'object' && stored !== null ? (stored as Partial<SpendPrefs>) : {}
      await update($, prefs, () => ({ ...DEFAULT_PREFS, ...saved, selected: null }))
    }
    if (e.isInteractive) {
      mem.gfx = await detectGfx($)
      await measure($).catch(() => undefined)
      $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
      // Read the session's past back after start, not before the first prompt.
      const cwd = e.cwd
      $.clock.after(50, () => void backfill($, cwd, false).catch(() => undefined))
      const p = await read($, prefs)
      if (p.open && !(await $.ui.panes()).some(pane => pane.id === PANE)) {
        mem.isPaneOpen = (await $.ui.open({ id: PANE, title: TITLE, columns: 44 })).isPlaced
      }
      await showChip($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await resetSession($).catch(() => undefined)
    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (e.origin.kind !== 'plugin') mem.isPaneOpen = false
    if (e.origin.kind === 'person') await setPrefs($, p => ({ ...p, open: false })).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  // A compaction is marked, never reset: the spend before it stays the session's.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && r.skip === undefined) {
      const at = await $.clock.now()
      const trigger = e.trigger
      await update($, core, c =>
        c === null ? c : { ...c, compactions: [...(c.compactions ?? []), { at, trigger, from: c.ctxTokens }].slice(-20) },
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    await update($, core, c => (c === null ? c : { ...c, turn: { startedAt: now, usd0: c.usd } }))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      const u = await $.session.usage()
      await update($, core, c =>
        c === null || c.turn === null ? c : { ...c, turn: { ...c.turn, endedAt: now, usd1: u.cost?.usd ?? c.usd } },
      )
    } else {
      const status = e.reason === 'answer' ? 'done' : 'failed'
      const agentId = e.agentId
      await update($, sources, s => finishAgent(s, agentId, status))
    }
    return r
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    let name = e.name
    if (name === undefined && e.script !== undefined) name = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(e.script)?.[1]
    if (name === undefined && e.scriptPath !== undefined) {
      const text = await $.fs.read(e.scriptPath).catch(() => '')
      name = /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(text)?.[1]
    }
    if (name !== undefined) {
      const label = name
      await update($, sources, s => ({ ...s, workflows: { ...s.workflows, [e.tool_use_id]: label } }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.agentId === undefined) return r
    const agentId = r.agentId
    const runId = e.workflow?.runId
    const now = await $.clock.now()
    await update($, sources, s => {
      const wfName = s.workflows[e.tool_use_id] ?? (runId === undefined ? undefined : `workflow ${runId.slice(3, 9)}`)
      const meta: SpendAgentMeta =
        runId === undefined
          ? { label: `${e.subagentType} · ${e.description}`, type: e.subagentType, model: r.model }
          : { label: wfName ?? 'workflow', type: e.description || e.subagentType, runId, model: r.model }
      const withMeta = { ...s, agents: { ...s.agents, [agentId]: meta } }
      mem.agents = withMeta.agents
      return ensureRow(withMeta, attribute(agentId, withMeta), now)
    })
    return r
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const flightId = `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`
    const flight: Flight = { key: attribute(e.agentId, { ...EMPTY_SOURCES, agents: mem.agents }).key, model: e.model, chars: 0 }
    mem.flights.set(flightId, flight)
    const seated = $.clock
      .now()
      .then(now => update($, sources, s => ensureRow(s, attribute(e.agentId, s), now)))
      .catch(() => undefined)
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'text' || chunk.kind === 'thinking') flight.chars += chunk.text.length
        else if (chunk.kind === 'input') flight.chars += chunk.json.length
        yield chunk
      }
      const result = await stream.result
      await seated
      const usage = result.usage
      if (usage !== null) {
        const model = usage.model || e.model
        const parts = priceUsage(model, usage, e.agentId === undefined && mem.isSubscriber ? '1h' : '5m')
        const now = await $.clock.now()
        const kind = e.agentId === undefined ? 'main' : mem.agents[e.agentId]?.runId !== undefined ? 'workflows' : 'agents'
        mem.split[kind] += parts === undefined ? 0 : partsTotal(parts)
        mem.isStale = true
        if (mem.backfilling) {
          mem.held.push({ agentId: e.agentId, model, usage, parts, at: now })
        } else {
          await update($, sources, s => addStep(s, attribute(e.agentId, s), model, usage, parts, now))
        }
      }
      return result
    } finally {
      mem.flights.delete(flightId)
    }
  })

  on('command.run', { command: 'spend' }, async ($, e) => ({ text: await runCommand($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    mem.viewedAgentId = e.props.view.agentId
    const [c, s, se, p, l, now] = await Promise.all([
      read($, core),
      read($, sources),
      read($, series),
      read($, prefs),
      read($, live),
      $.clock.now(),
    ])
    return drawPane(
      ui,
      e.surface === 'terminal' && 'Raster' in ui ? { Raster: ui.Raster, Image: ui.Image } : undefined,
      {
        now,
        core: c,
        sources: s,
        series: se,
        prefs: p,
        live: l,
        width: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        placement: e.props.placement,
        surface: e.surface,
        viewedAgentId: e.props.view.agentId,
        gfx: p.gfx === 'cells' || p.gfx === 'pixels' ? p.gfx : mem.gfx,
      },
      {
        cycleUnit: () => void setPrefs($, x => ({ ...x, unit: (x.unit + 1) % UNITS.length })),
        select: key => void update($, prefs, x => ({ ...x, selected: key })),
      },
    )
  })
}
