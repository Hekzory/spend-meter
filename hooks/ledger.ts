// The meter's arithmetic: who spent what, how fast, and how it is written.
// Pure functions over the state contract, so the tests drive them directly.

import type { ModelUsage, SessionUsage } from 'claude-code'

import { addParts, NO_PARTS, partsTotal } from './pricing'
import type { Parts } from './pricing'

import type {
  SpendCore,
  SpendSeries,
  SpendSource,
  SpendSourceKind,
  SpendSources,
  SpendWindow,
} from '../types'

export const BUCKET_MS = 30_000
const KEEP_BUCKETS = 240 // two hours of history
const KEEP_SAMPLES_MS = 30 * 60_000
const PACE_SPAN_MS = 15 * 60_000

export const EMPTY_SOURCES: SpendSources = { rows: {}, agents: {}, workflows: {} }
export const EMPTY_SERIES: SpendSeries = { bucketMs: BUCKET_MS, t0: 0, buckets: [] }

// ─── the engine's figures ────────────────────────────────────────────────────

/** Folds a `$.session.usage()` reading into the core, starting it when absent. */
export function absorbUsage(prev: SpendCore | null, u: SessionUsage, now: number): SpendCore {
  const usd = u.cost?.usd ?? prev?.usd ?? 0
  const limits = u.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt }))
  const base: SpendCore = prev ?? {
    usd,
    usd0: usd,
    startedAt: u.startedAt,
    at: now,
    ctxWindow: u.context.window,
    limits: [],
    windows: {},
    isSubscriber: false,
    turn: null,
    compactions: [],
    fired: [],
  }
  return {
    ...base,
    usd,
    startedAt: u.startedAt,
    at: now,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    ctxPct: u.context.percent,
    limits,
    windows: absorbWindows(base.windows, limits, now),
    isSubscriber: base.isSubscriber || limits.length > 0,
  }
}

function absorbWindows(
  prev: Record<string, SpendWindow>,
  limits: readonly { kind: string; pct: number; resetsAt?: string }[],
  now: number,
): Record<string, SpendWindow> {
  const next: Record<string, SpendWindow> = { ...prev }
  for (const l of limits) {
    const w = prev[l.kind]
    if (w === undefined) {
      next[l.kind] = { first: l.pct, last: l.pct, resetsAt: l.resetsAt, carried: 0, samples: [[now, l.pct]] }
      continue
    }
    const isReset = l.resetsAt !== undefined && w.resetsAt !== undefined && l.resetsAt !== w.resetsAt && l.pct < w.last
    const samples = isReset ? [] : w.samples.filter(([at]) => now - at <= KEEP_SAMPLES_MS)
    const lastSample = samples.at(-1)
    if (lastSample === undefined || lastSample[1] !== l.pct || now - lastSample[0] > 60_000) samples.push([now, l.pct])
    next[l.kind] = isReset
      ? { first: l.pct, last: l.pct, resetsAt: l.resetsAt, carried: w.carried + Math.max(0, w.last - w.first), samples }
      : { ...w, last: l.pct, resetsAt: l.resetsAt ?? w.resetsAt, samples }
  }
  return next
}

/** How far a window moved while this session watched it, in percent points. */
export function windowMoved(w: SpendWindow): number {
  return w.carried + Math.max(0, w.last - w.first)
}

export type Pace = {
  /** Percent points a minute over the recent span. */
  perMin: number
  /** When it reaches 100 % at that pace, if it climbs at all. */
  fullAt?: number
  resetAt?: number
  /** Whether the pace fills it before it resets. */
  isShort: boolean
}

export function pace(w: SpendWindow, now: number): Pace | undefined {
  const recent = w.samples.filter(([at]) => now - at <= PACE_SPAN_MS)
  const first = recent[0]
  const last = recent.at(-1)
  if (first === undefined || last === undefined) return undefined
  const span = last[0] - first[0]
  if (span < 3 * 60_000) return undefined
  const perMin = ((last[1] - first[1]) / span) * 60_000
  const resetAt = w.resetsAt === undefined ? undefined : Date.parse(w.resetsAt)
  const reset = resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined
  if (perMin <= 0.001) return { perMin: 0, resetAt: reset, isShort: false }
  const fullAt = now + ((100 - last[1]) / perMin) * 60_000
  return { perMin, fullAt, resetAt: reset, isShort: reset === undefined || fullAt < reset }
}

// ─── who spent it ────────────────────────────────────────────────────────────

export type Attribution = {
  key: string
  kind: SpendSourceKind
  label: string
  type?: string
  /** The agent inside a workflow run's row. */
  member?: { id: string; label: string }
}

export function attribute(agentId: string | undefined, src: SpendSources): Attribution {
  if (agentId === undefined) return { key: 'main', kind: 'main', label: 'main thread' }
  const meta = src.agents[agentId]
  if (meta === undefined) return { key: 'fork', kind: 'fork', label: 'engine loops' }
  if (meta.runId !== undefined) {
    return {
      key: `wf:${meta.runId}`,
      kind: 'workflow',
      label: meta.label,
      type: 'workflow',
      member: { id: agentId, label: meta.type },
    }
  }
  return { key: `agent:${agentId}`, kind: 'agent', label: meta.label, type: meta.type }
}

/** Seats a row for a source that has started but not yet been billed. */
export function ensureRow(src: SpendSources, who: Attribution, now: number): SpendSources {
  const row = src.rows[who.key]
  if (row !== undefined && (who.member === undefined || row.members?.[who.member.id] !== undefined)) {
    return row.status === 'running' || who.kind === 'main' || who.kind === 'fork'
      ? src
      : { ...src, rows: { ...src.rows, [who.key]: { ...row, status: 'running' } } }
  }
  return addStep(src, who, undefined, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, NO_PARTS, now, false)
}

/** Adds one response to its source's row. */
export function addStep(
  src: SpendSources,
  who: Attribution,
  model: string | undefined,
  usage: ModelUsage,
  parts: Parts | undefined,
  now: number,
  isStep = true,
): SpendSources {
  const step = isStep ? 1 : 0
  const usd = parts === undefined ? undefined : partsTotal(parts)
  const row: SpendSource = src.rows[who.key] ?? {
    key: who.key,
    kind: who.kind,
    label: who.label,
    type: who.type,
    usd: 0,
    cost: NO_PARTS,
    isPriced: true,
    tok: { in: 0, out: 0, cr: 0, cw: 0 },
    steps: 0,
    status: 'running',
    firstAt: now,
    lastAt: now,
  }
  const members = who.member === undefined ? row.members : { ...row.members }
  if (who.member !== undefined && members !== undefined) {
    const m = members[who.member.id] ?? { label: who.member.label, usd: 0, steps: 0, status: 'running' as const }
    members[who.member.id] = { ...m, usd: m.usd + (usd ?? 0), steps: m.steps + step, status: 'running' }
  }
  const next: SpendSource = {
    ...row,
    label: who.label,
    model: model ?? row.model,
    usd: row.usd + (usd ?? 0),
    cost: addParts(row.cost ?? NO_PARTS, parts),
    isPriced: row.isPriced && usd !== undefined,
    tok: {
      in: row.tok.in + usage.input_tokens,
      out: row.tok.out + usage.output_tokens,
      cr: row.tok.cr + usage.cache_read_input_tokens,
      cw: row.tok.cw + usage.cache_creation_input_tokens,
    },
    steps: row.steps + step,
    status: who.kind === 'main' || who.kind === 'fork' ? row.status : 'running',
    lastAt: isStep ? now : row.lastAt,
    members,
  }
  return { ...src, rows: { ...src.rows, [who.key]: next } }
}

/** Marks an agent's row (or its member of a workflow row) done or failed. */
export function finishAgent(src: SpendSources, agentId: string, status: 'done' | 'failed'): SpendSources {
  const who = attribute(agentId, src)
  const row = src.rows[who.key]
  if (row === undefined || who.kind === 'main' || who.kind === 'fork') return src
  if (who.member === undefined) return { ...src, rows: { ...src.rows, [who.key]: { ...row, status } } }
  const members = { ...row.members }
  const m = members[who.member.id]
  if (m !== undefined) members[who.member.id] = { ...m, status }
  const isRunning = Object.values(members).some(one => one.status === 'running')
  const isFailed = Object.values(members).some(one => one.status === 'failed')
  return {
    ...src,
    rows: { ...src.rows, [who.key]: { ...row, members, status: isRunning ? 'running' : isFailed ? 'failed' : 'done' } },
  }
}

export function sumTokens(rows: readonly SpendSource[]) {
  const t = { in: 0, out: 0, cr: 0, cw: 0 }
  for (const r of rows) {
    t.in += r.tok.in
    t.out += r.tok.out
    t.cr += r.tok.cr
    t.cw += r.tok.cw
  }
  return t
}

export function sumCost(rows: readonly SpendSource[]): Parts {
  return rows.reduce((acc, r) => addParts(acc, r.cost), NO_PARTS)
}

export function cacheHit(t: { in: number; cr: number; cw: number }): number | undefined {
  const prompt = t.in + t.cr + t.cw
  return prompt === 0 ? undefined : t.cr / prompt
}

// ─── over time ───────────────────────────────────────────────────────────────

/**
 * Moves the series up to `now`, adding what each source spent to the newest
 * bucket: the bars are the priced responses, timed as they finished.
 */
export function addToSeries(s: SpendSeries, now: number, split: { main: number; agents: number; workflows: number }): SpendSeries {
  const slot = Math.floor(now / s.bucketMs) * s.bucketMs
  let buckets = s.buckets.slice()
  let t0 = s.t0
  if (t0 === 0 || buckets.length === 0) {
    t0 = slot
    buckets = [[0, 0, 0, 0]]
  } else if (slot > t0) {
    const gap = Math.min(KEEP_BUCKETS, Math.round((slot - t0) / s.bucketMs))
    for (let i = 0; i < gap; i++) buckets.push([0, 0, 0, 0])
    t0 = slot
  }
  const spent = split.main + split.agents + split.workflows
  if (spent > 0) {
    const last = buckets[buckets.length - 1]!
    buckets[buckets.length - 1] = [
      last[0] + spent,
      last[1] + split.main,
      last[2] + split.agents,
      last[3] + split.workflows,
    ]
  }
  if (buckets.length > KEEP_BUCKETS) buckets = buckets.slice(-KEEP_BUCKETS)
  return { ...s, t0, buckets }
}

/** USD a minute over the last `spanMs`, from the series. */
export function burnPerMin(s: SpendSeries, now: number, spanMs = 5 * 60_000): number {
  if (s.buckets.length === 0) return 0
  const n = Math.max(1, Math.round(spanMs / s.bucketMs))
  const stale = Math.max(0, Math.round((Math.floor(now / s.bucketMs) * s.bucketMs - s.t0) / s.bucketMs))
  const take = Math.min(s.buckets.length, n - stale)
  if (take <= 0) return 0
  const spent = s.buckets.slice(-take).reduce((a, b) => a + b[0], 0)
  // A young session has not had the whole span: average over what it had.
  const watched = Math.min(spanMs, (s.buckets.length + stale) * s.bucketMs)
  return spent / (Math.max(60_000, watched) / 60_000)
}

// ─── writing it down ─────────────────────────────────────────────────────────

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 0.1) return `$${n.toFixed(3)}`
  if (n < 10_000) return `$${n.toFixed(2)}`
  return `$${(n / 1000).toFixed(1)}k`
}

export function fmtTok(n: number): string {
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** A coarse duration for a forecast: `37m`, `1h 40m`. */
export function fmtEta(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtPct(n: number): string {
  return n >= 10 || Number.isInteger(n) ? `${Math.round(n)}%` : `${n.toFixed(1)}%`
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar `width` cells long filled to `frac`, in eighths of a cell. */
export function blocks(width: number, frac: number): string {
  const eighths = Math.round(Math.min(1, Math.max(0, frac)) * width * 8)
  const full = Math.floor(eighths / 8)
  return '█'.repeat(full) + (EIGHTHS[eighths % 8] ?? '')
}

/** A thin gauge: `━` filled, `─` the track, `[filled, track]`. */
export function gauge(width: number, frac: number): [string, string] {
  const f = Math.round(Math.min(1, Math.max(0, frac)) * width)
  return ['━'.repeat(f), '─'.repeat(Math.max(0, width - f))]
}

export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`
}

// ─── the raster ──────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : B64[c & 63]
  }
  return out
}

export const DEFAULT_COLOR = 0x01000000

/** Packs `[codePoint, fg, bg]` cells, row-major, as a Raster's `cells`. */
export function packCells(cells: readonly (readonly [number, number, number])[]): string {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach(([cp, fg, bg], i) => {
    words[i * 3] = cp
    words[i * 3 + 1] = fg
    words[i * 3 + 2] = bg
  })
  return base64(new Uint8Array(words.buffer))
}

// Each color is one a 256-color terminal rounds the same way whether it comes
// as a cell of the chart or as text, so the legend matches the chart there too.
export const PALETTE = {
  main: 0xd9774b,
  agents: 0x4ba8f5,
  workflows: 0xaf7fff,
  other: 0x8a8a8a,
  mark: 0x767676, // a compaction's guide line
  axis: 0x3a3a3a,
}

export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

/** One bar of the chart: what each source spent in its bucket, and whether the session compacted then. */
export type Bar = { main: number; agents: number; workflows: number; isCompacted: boolean }

/** The last `columns` buckets up to `now`, oldest first. */
export function barsOf(s: SpendSeries, now: number, columns: number, compactedAt: readonly number[] = []): Bar[] {
  const slot = Math.floor(now / s.bucketMs) * s.bucketMs
  const stale = s.t0 === 0 ? 0 : Math.max(0, Math.round((slot - s.t0) / s.bucketMs))
  const series: [number, number, number, number][] = [...s.buckets]
  for (let i = 0; i < Math.min(stale, columns); i++) series.push([0, 0, 0, 0])
  const shown = series.slice(-columns)
  while (shown.length < columns) shown.unshift([0, 0, 0, 0])
  const first = slot - (columns - 1) * s.bucketMs
  const marks = new Set(compactedAt.map(at => Math.round((Math.floor(at / s.bucketMs) * s.bucketMs - first) / s.bucketMs)))
  return shown.map(([, main, agents, workflows], i) => ({ main, agents, workflows, isCompacted: marks.has(i) }))
}

export const barTotal = (b: Bar) => b.main + b.agents + b.workflows
