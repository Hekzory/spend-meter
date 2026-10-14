// The pane's drawing: a tree from the meter's state, sized to the pane body.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { SpendCompaction, SpendCore, SpendLive, SpendPrefs, SpendSeries, SpendSource, SpendSources } from '../types'
import { areaCells, areaPixels, areaText } from './art'
import {
  barsOf,
  barTotal,
  burnPerMin,
  cacheHit,
  clip,
  fmtDur,
  fmtEta,
  fmtMin,
  fmtPct,
  fmtTok,
  fmtUsd,
  gauge,
  hex,
  pace,
  packCells,
  PALETTE,
  sumCost,
  sumTokens,
  windowMoved,
} from './ledger'
import { inputRate, modelName, readRate } from './pricing'

export const UNITS = [
  { id: 'usd', label: 'this session · USD at API list price' },
  { id: 'tok', label: 'tokens through the models this session' },
  { id: 'coffee', label: 'flat whites at $4.50', per: 4.5, glyph: '☕ ' },
  { id: 'banana', label: 'bananas, for scale', per: 0.3, glyph: '🍌 ' },
  { id: 'dev', label: 'minutes of a senior engineer', per: 1.5, glyph: '' },
] as const

const KIND_COLOR = {
  main: hex(PALETTE.main),
  agent: hex(PALETTE.agents),
  workflow: hex(PALETTE.workflows),
  fork: hex(PALETTE.other),
}

const KIND_NAME = { main: 'main thread', agent: 'subagents', workflow: 'workflows' } as const

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type ViewData = {
  now: number
  core: SpendCore | null
  sources: SpendSources
  series: SpendSeries
  prefs: SpendPrefs
  live: SpendLive
  width: number
  rows: number
  placement: 'dock' | 'inline'
  surface: RenderSurface
  viewedAgentId?: string
  /** Whether the chart may be a kitty-protocol picture rather than cells. */
  gfx: 'cells' | 'pixels'
}

export type ViewActions = {
  cycleUnit: () => void
  select: (key: string | null) => void
}

type Ui = Elements[RenderSurface]
/** The terminal's own elements: cells colored one by one, and pictures. */
export type Art = { Raster: Elements['terminal']['Raster']; Image: Elements['terminal']['Image'] }

type Row = {
  key: string
  kind: SpendSource['kind'] | 'overhead' | 'earlier'
  label: string
  usd: number
  status?: SpendSource['status']
  isStreaming: boolean
  source?: SpendSource
}

const pctColor = (pct: number) => (pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success')

function windowName(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return '$'
  if (kind.startsWith('seven_day_')) return `7d${kind.slice(10, 11)}`
  return kind.slice(0, 3)
}

/** How good a cache hit rate is, said in a word. */
function hitWord(hit: number): [string, string] {
  if (hit >= 0.95) return ['excellent', 'success']
  if (hit >= 0.85) return ['good', 'success']
  if (hit >= 0.7) return ['fair', 'warning']
  return ['poor', 'error']
}

/** The rows of "where it goes", the engine's total split as far as it can be. */
export function rowsOf(d: ViewData): Row[] {
  const live = new Set(d.live.keys)
  const rows: Row[] = Object.values(d.sources.rows).map(s => ({
    key: s.key,
    kind: s.kind,
    label: s.kind === 'main' ? `main thread · ${modelName(s.model)}` : s.kind === 'fork' ? 'compaction & memory' : s.label,
    usd: s.usd,
    status: s.status,
    isStreaming: live.has(s.key),
    source: s,
  }))
  const order = (r: Row) => (r.kind === 'main' ? 0 : r.kind === 'fork' ? 3 : r.status === 'running' ? 1 : 2)
  rows.sort((a, b) => order(a) - order(b) || b.usd - a.usd)
  if (d.core !== null) {
    const priced = rows.reduce((a, r) => a + r.usd, 0)
    const overhead = d.core.usd - d.core.usd0 - priced
    if (overhead >= 0.0005) {
      rows.push({ key: 'overhead', kind: 'overhead', label: 'side calls: classifier, titles', usd: overhead, isStreaming: false })
    }
    if (d.core.usd0 >= 0.0005) {
      rows.push({ key: 'earlier', kind: 'earlier', label: 'before the meter', usd: d.core.usd0, isStreaming: false })
    }
  }
  return rows
}

function glyphOf(r: Row, tick: number): string {
  if (r.isStreaming) return SPINNER[tick % SPINNER.length]!
  if (r.kind === 'overhead') return '◇'
  if (r.kind === 'earlier') return '·'
  if (r.kind === 'fork') return '○'
  if (r.status === 'done') return '✓'
  if (r.status === 'failed') return '✗'
  return r.kind === 'workflow' ? '◆' : '●'
}

function colorOf(r: Row): string {
  if (r.kind === 'overhead' || r.kind === 'earlier') return 'subtle'
  return KIND_COLOR[r.kind]
}

function heroValue(d: ViewData, tokens: number): { text: string; caption: string } {
  const unit = UNITS[d.prefs.unit % UNITS.length]!
  const usd = d.core?.usd ?? 0
  if (unit.id === 'usd') return { text: fmtUsd(usd), caption: unit.label }
  if (unit.id === 'tok') return { text: fmtTok(tokens), caption: unit.label }
  const n = usd / unit.per
  return { text: `${unit.glyph}${n >= 100 ? n.toFixed(0) : n.toFixed(1)}`, caption: `${unit.label} · ${fmtUsd(usd)}` }
}

function compactionNote(list: readonly SpendCompaction[] | undefined, now: number): string | undefined {
  const last = list?.at(-1)
  if (last === undefined) return undefined
  const sizes = last.from === undefined ? '' : ` · ${fmtTok(last.from)} → ${last.to === undefined ? '…' : fmtTok(last.to)}`
  const times = list!.length > 1 ? `compacted ${list!.length}×, last ` : 'compacted '
  return `${times}${fmtMin(now - last.at)} ago${sizes}`
}

/**
 * What the pane shows that moves with the clock alone, written as the pane writes it.
 * The meter draws the pane again only when this changes: a quiet pane, once a minute.
 */
export function clockText(d: Pick<ViewData, 'now' | 'core' | 'series' | 'sources' | 'prefs' | 'viewedAgentId'>): string {
  const core = d.core
  if (core === null) return ''
  const burn = burnPerMin(d.series, d.now)
  const parts = [fmtMin(d.now - core.startedAt), fmtUsd(burn), fmtUsd(burn * 60)]
  if (core.turn !== null && core.turn.endedAt === undefined) parts.push(fmtDur(d.now - core.turn.startedAt))
  for (const l of core.limits) parts.push(l.resetsAt === undefined ? '' : fmtMin(Date.parse(l.resetsAt) - d.now))
  for (const w of Object.values(core.windows)) {
    const p = pace(w, d.now)
    const full = p?.fullAt === undefined ? '' : `${fmtEta(p.fullAt - d.now)} ${p.fullAt - d.now < 60 * 60_000}`
    parts.push(p === undefined ? '' : `${p.perMin > 0} ${p.isShort} ${full}`)
  }
  parts.push(compactionNote(core.compactions, d.now) ?? '')
  // The chart moves a bucket at a time while a bar or a mark is in sight.
  const bars = barsOf(d.series, d.now, 240, (core.compactions ?? []).map(c => c.at))
  if (bars.some(b => barTotal(b) > 0 || b.isCompacted)) parts.push(String(Math.floor(d.now / d.series.bucketMs)))
  const selected = d.prefs.selected ?? (d.viewedAgentId === undefined ? null : `agent:${d.viewedAgentId}`)
  const s = selected === null ? undefined : d.sources.rows[selected]
  if (s?.status === 'running' && s.kind !== 'main' && d.now - s.lastAt >= 5000) parts.push(fmtDur(d.now - s.lastAt))
  return parts.join('|')
}

export function drawPane(ui: Ui, art: Art | undefined, d: ViewData, act: ViewActions): RenderElement {
  const { Box, Text, Button } = ui
  const W = Math.max(24, d.width - 2) // the root Box pads a cell each side
  const core = d.core
  const tick = d.live.tick
  const sourceRows = Object.values(d.sources.rows)
  const tokens = sumTokens(sourceRows)
  const allTokens = tokens.in + tokens.out + tokens.cr + tokens.cw
  const hero = heroValue(d, allTokens)
  const budget = d.prefs.budget
  const usd = core?.usd ?? 0
  const budgetFrac = budget === null || budget <= 0 ? undefined : usd / budget
  const heroColor = budgetFrac === undefined ? 'claude' : budgetFrac >= 1 ? 'error' : budgetFrac >= 0.8 ? 'warning' : 'claude'
  const isBusy = d.live.inflight > 0
  const main = d.sources.rows['main']
  const isInline = d.placement === 'inline'

  const heading = (text: string, right?: string) => (
    <Box justifyContent="space-between" marginTop={1}>
      <Text bold color="subtle">
        {text}
      </Text>
      {right !== undefined && <Text dimColor>{right}</Text>}
    </Box>
  )

  // ── header ──
  const header = (
    <Box justifyContent="space-between">
      <Box gap={2}>
        <Text bold color="claude">
          ◆ spend
        </Text>
        {isBusy ? (
          <Text color="claude">
            {SPINNER[tick % SPINNER.length]} {d.live.inflight} {d.live.inflight === 1 ? 'request' : 'requests'} live
          </Text>
        ) : (
          <Text dimColor>idle</Text>
        )}
      </Box>
      <Text dimColor>{core === null ? '' : fmtMin(d.now - core.startedAt)}</Text>
    </Box>
  )

  if (core === null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Text dimColor>Measuring the session…</Text>
      </Box>
    )
  }

  // ── the total ──
  const brrr = d.live.flash?.kind === 'brrr' && d.live.flash.until > d.now
  const streaming = d.live.estUsd >= 0.0005 ? `+${fmtUsd(d.live.estUsd)} streaming` : undefined
  const total = (
    <Box flexDirection="column" marginTop={1}>
      {brrr ? (
        printer(Text, tick)
      ) : (
        <Box justifyContent="space-between">
          <Text bold color={heroColor}>
            {hero.text}
          </Text>
          {streaming !== undefined && <Text color="claude">{streaming}</Text>}
        </Box>
      )}
      <Button key="caption" plain dimColor onPress={act.cycleUnit}>
        {hero.caption} ⇄
      </Button>
    </Box>
  )

  // ── the turn, the pace, the budget ──
  const turn = core.turn
  const turnUsd = turn === null ? 0 : (turn.usd1 ?? core.usd) - turn.usd0
  const turnMs = turn === null ? 0 : (turn.endedAt ?? d.now) - turn.startedAt
  const burn = burnPerMin(d.series, d.now)
  const statLine = (label: string, value: string, right: string, color?: string) => (
    <Box justifyContent="space-between">
      <Box gap={1}>
        <Text dimColor>{label.padEnd(10)}</Text>
        <Text color={color}>{value}</Text>
      </Box>
      <Text dimColor>{right}</Text>
    </Box>
  )
  const budgetColor = budgetFrac === undefined ? undefined : budgetFrac >= 1 ? 'error' : budgetFrac >= 0.8 ? 'warning' : 'success'
  const [budgetOn, budgetOff] = gauge(Math.max(6, W - 27), budgetFrac ?? 0)
  const stats = (
    <Box flexDirection="column" marginTop={1}>
      {turn !== null &&
        statLine(
          turn.endedAt === undefined ? 'this turn' : 'last turn',
          `+${fmtUsd(turnUsd)}`,
          `${fmtDur(turnMs)}${turn.endedAt === undefined ? ' so far' : ''}`,
        )}
      {statLine('burn', burn < 0.0005 ? 'idle' : `${fmtUsd(burn)}/min`, burn < 0.0005 ? '' : `≈ ${fmtUsd(burn * 60)}/h`)}
      {budget !== null && budgetFrac !== undefined && (
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text dimColor>{'budget'.padEnd(10)}</Text>
            <Text>
              <Text color={budgetColor}>{budgetOn}</Text>
              <Text dimColor>{budgetOff}</Text>
            </Text>
          </Box>
          <Text color={budgetColor}>
            {fmtPct(budgetFrac * 100)} of {fmtUsd(budget)}
          </Text>
        </Box>
      )}
    </Box>
  )

  // ── over time ──
  const spanMin = Math.round((W * d.series.bucketMs) / 60_000)
  const bars = barsOf(
    d.series,
    d.now,
    W,
    (core.compactions ?? []).map(c => c.at),
  )
  const peak = Math.max(...bars.map(barTotal))
  const chartRows = Math.min(7, Math.max(3, Math.floor((d.rows - 30) / 3)))
  const kinds = (['main', 'agent', 'workflow'] as const).filter(k =>
    bars.some(b => (k === 'main' ? b.main : k === 'agent' ? b.agents : b.workflows) > 0),
  )
  let chart: RenderElement
  if (peak <= 0) {
    chart = <Text dimColor>No spend in the last {spanMin} minutes.</Text>
  } else if (art !== undefined && d.gfx === 'pixels') {
    chart = art.Image({ key: 'chart', source: areaPixels(bars, chartRows), columns: W, rows: chartRows, alt: areaText(bars) })
  } else if (art !== undefined) {
    chart = art.Raster({ key: 'chart', columns: W, rows: chartRows, cells: packCells(areaCells(bars, chartRows)) })
  } else {
    chart = <Text color="claude">{areaText(bars)}</Text>
  }
  const overTime = (
    <Box flexDirection="column">
      {heading('OVER TIME', peak > 0 ? `last ${spanMin} min · peak ${fmtUsd(peak)}/${Math.round(d.series.bucketMs / 1000)}s` : `last ${spanMin} min`)}
      {chart}
      {kinds.length > 1 && (
        <Box flexWrap="wrap" columnGap={2}>
          {kinds.map(k => (
            <Text>
              <Text color={KIND_COLOR[k]}>■ </Text>
              <Text dimColor>{KIND_NAME[k]}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )

  // ── limits ──
  const gaugeW = Math.max(6, W - 21)
  const limitLines: RenderElement[] = []
  const note = (text: RenderElement | string) => (
    <Box paddingLeft={4}>
      <Text dimColor wrap="truncate-end">
        {text}
      </Text>
    </Box>
  )
  for (const l of core.limits) {
    const [on, off] = gauge(gaugeW, l.pct / 100)
    const resets = l.resetsAt === undefined ? '' : `↻ ${fmtMin(Date.parse(l.resetsAt) - d.now)}`
    limitLines.push(
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold>{windowName(l.kind).padEnd(3)}</Text>
          <Text>
            <Text color={pctColor(l.pct)}>{on}</Text>
            <Text dimColor>{off}</Text>
          </Text>
          <Text color={pctColor(l.pct)}>{fmtPct(l.pct).padStart(4)}</Text>
        </Box>
        <Text dimColor>{resets}</Text>
      </Box>,
    )
    const w = core.windows[l.kind]
    if (w === undefined || isInline) continue
    const moved = windowMoved(w)
    const p = pace(w, d.now)
    if (moved < 0.05 && (p === undefined || p.perMin <= 0)) continue
    const parts: RenderElement[] = [<Text dimColor>+{moved.toFixed(1)} pts since start</Text>]
    if (p !== undefined && p.perMin > 0 && p.fullAt !== undefined) {
      parts.push(
        p.isShort ? (
          <Text color={p.fullAt - d.now < 60 * 60_000 ? 'error' : 'warning'}> · full in ~{fmtEta(p.fullAt - d.now)} ⚠</Text>
        ) : (
          <Text color="success"> · pace ok</Text>
        ),
      )
    }
    limitLines.push(note(<Text>{parts}</Text>))
  }
  if (core.ctxPct !== undefined) {
    const [on, off] = gauge(gaugeW, core.ctxPct / 100)
    limitLines.push(
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold>ctx</Text>
          <Text>
            <Text color={pctColor(core.ctxPct)}>{on}</Text>
            <Text dimColor>{off}</Text>
          </Text>
          <Text color={pctColor(core.ctxPct)}>{fmtPct(core.ctxPct).padStart(4)}</Text>
        </Box>
        <Text dimColor>
          {fmtTok(core.ctxTokens ?? 0)}/{fmtTok(core.ctxWindow)}
        </Text>
      </Box>,
    )
    const tax = ((core.ctxTokens ?? 0) * readRate(main?.model)) / 1e6
    if (tax > 0 && !isInline) limitLines.push(note(`≈ ${fmtUsd(tax)} to re-read per main request`))
    const compacted = compactionNote(core.compactions, d.now)
    if (compacted !== undefined && !isInline) {
      // The same mark the chart draws where the session compacted.
      limitLines.push(
        note(
          <Text>
            <Text color={hex(PALETTE.mark)}>│ </Text>
            {compacted}
          </Text>,
        ),
      )
    }
  }

  // ── where it goes ──
  const rows = rowsOf(d)
  const costW = 8
  const barW = W >= 36 ? 7 : 0
  const labelW = Math.max(6, W - 1 - 2 - costW - barW)
  // Shares of what the meter watched: the spend before it has no bar.
  const watched = Math.max(0.000001, rows.reduce((a, r) => a + (r.kind === 'earlier' ? 0 : r.usd), 0))
  const maxRows = isInline ? 3 : Math.max(4, d.rows - 34)
  const selected = d.prefs.selected ?? (d.viewedAgentId === undefined ? null : `agent:${d.viewedAgentId}`)
  const sourceLines: RenderElement[] = []
  for (const r of rows.slice(0, maxRows)) {
    const isSel = selected === r.key
    // The engine's own calls, named in full where the row has room.
    const label = r.kind === 'overhead' && r.label.length > labelW ? 'side calls' : r.label
    // The row's share as a thin gauge, the limits' kind: a proportion, not a badge.
    const [shareOn, shareOff] = barW === 0 || r.kind === 'earlier' ? ['', ''] : gauge(barW - 1, r.usd / watched)
    const cost = r.usd === 0 && r.isStreaming ? '…' : `${r.source?.isPriced === false ? '≥' : ''}${fmtUsd(r.usd)}`
    const children = [
      <Text color={colorOf(r)}>{glyphOf(r, tick)}</Text>,
      ` ${clip(label, labelW).padEnd(labelW)} `,
      <Text bold={isSel}>{cost.padStart(costW)}</Text>,
      shareOn === '' && shareOff === '' ? '' : ' ',
      <Text color={colorOf(r)}>{shareOn}</Text>,
      <Text dimColor>{shareOff}</Text>,
    ]
    sourceLines.push(
      r.source !== undefined ? (
        <Button key={`src:${r.key}`} plain onPress={() => act.select(isSel ? null : r.key)}>
          {children}
        </Button>
      ) : (
        <Text dimColor={r.kind === 'earlier'}>{children}</Text>
      ),
    )
    if (isSel && r.source !== undefined) sourceLines.push(details(Box, Text, r.source, d.now, W))
  }
  const hidden = rows.slice(maxRows)
  if (hidden.length > 0) {
    sourceLines.push(
      <Text dimColor>
        {'  '}+{hidden.length} more · {fmtUsd(hidden.reduce((a, r) => a + r.usd, 0))}
      </Text>,
    )
  }

  // ── what the tokens cost ──
  const cost = sumCost(sourceRows)
  const hit = cacheHit(tokens)
  const tokW = 7
  const tokenLabelW = Math.max(8, W - tokW - costW - 2)
  const isCacheOpen = d.prefs.selected === 'cache'
  const tokenRow = (label: string, n: number, usdOf: number, color?: string) => (
    <Text>
      <Text color={color}>{clip(label, tokenLabelW).padEnd(tokenLabelW)}</Text> {fmtTok(n).padStart(tokW)} {fmtUsd(usdOf).padStart(costW)}
    </Text>
  )
  const tokenLines = (
    <Box flexDirection="column">
      <Box justifyContent="space-between" marginTop={1}>
        <Text bold color="subtle">
          TOKENS
        </Text>
        <Text dimColor>
          {'tokens'.padStart(tokW)} {'cost'.padStart(costW)}
        </Text>
      </Box>
      {tokenRow('written by models', tokens.out, cost.output)}
      {tokenRow('new input, cached', tokens.cw, cost.write)}
      {tokenRow('re-read from cache', tokens.cr, cost.read)}
      {tokens.in > 0 && tokenRow('uncached input', tokens.in, cost.input)}
      {hit !== undefined && cacheLine(Button, Text, hit, W, isCacheOpen, () => act.select(isCacheOpen ? null : 'cache'))}
      {hit !== undefined && isCacheOpen && (
        <Box paddingLeft={2} marginBottom={1}>
          <Text dimColor>{cacheExplained(sourceRows, tokens.cr, cost.read, main?.model)}</Text>
        </Box>
      )}
    </Box>
  )

  if (isInline) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold color={heroColor}>
              {hero.text}
            </Text>
            {turn !== null && <Text dimColor>this turn +{fmtUsd(turnUsd)}</Text>}
          </Box>
          <Text dimColor>{burn < 0.0005 ? 'idle' : `${fmtUsd(burn)}/min`}</Text>
        </Box>
        {limitLines}
        {sourceLines}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {total}
      {stats}
      {overTime}
      {limitLines.length > 0 && heading(core.isSubscriber ? 'LIMITS' : 'CONTEXT', core.isSubscriber ? 'whole account' : undefined)}
      {limitLines}
      {heading('WHERE IT GOES')}
      {sourceLines.length > 0 ? sourceLines : <Text dimColor>Nothing yet.</Text>}
      {allTokens > 0 && tokenLines}
    </Box>
  )
}

/** "cache served 99% of input · excellent", a toggle for what that means. */
function cacheLine(Button: Ui['Button'], Text: Ui['Text'], hit: number, width: number, isOpen: boolean, toggle: () => void) {
  const lead = `cache served ${fmtPct(hit * 100)} of input · `
  const [word, color] = hitWord(hit)
  const gap = ' '.repeat(Math.max(1, width - lead.length - word.length - 1))
  return (
    <Button key="cache" plain onPress={toggle}>
      <Text dimColor>{lead}</Text>
      <Text color={color}>{word}</Text>
      <Text dimColor={!isOpen} bold={isOpen}>
        {gap}?
      </Text>
    </Button>
  )
}

/** What the cache does, in this session's own figures. */
function cacheExplained(rows: readonly SpendSource[], reread: number, readCost: number, model: string | undefined): string {
  const atFull = rows.reduce((a, s) => a + (s.tok.cr * inputRate(s.model)) / 1e6, 0)
  const ratio = inputRate(model) > 0 ? readRate(model) / inputRate(model) : 0
  const rate = ratio > 0 ? ` at ${Number(ratio.toFixed(3))}× on ${modelName(model)}` : ' for a fraction of it'
  const saved =
    atFull > readCost
      ? ` Without the cache, the ${fmtTok(reread)} re-read tokens would have cost ≈ ${fmtUsd(atFull)}, not ${fmtUsd(readCost)}.`
      : ''
  return `Each request resends the whole conversation. New input is cached once, at 1.25–2× the input price; later requests re-read it${rate}.${saved}`
}

function details(Box: Ui['Box'], Text: Ui['Text'], s: SpendSource, now: number, width: number): RenderElement {
  const hit = cacheHit(s.tok)
  const perStep = s.steps === 0 ? 0 : s.usd / s.steps
  const members = Object.values(s.members ?? {}).sort((a, b) => b.usd - a.usd)
  // Inside the details' indent: two for the marker, a space, the name, a space, eight for the cost.
  const nameW = Math.max(6, width - 2 - 13)
  return (
    <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
      <Text dimColor wrap="truncate-end">
        {s.type !== undefined && s.kind !== 'workflow' ? `${s.type} · ` : ''}
        {modelName(s.model)} · {s.steps} requests
        {s.lastAt - s.firstAt >= 1000 ? ` over ${fmtDur(s.lastAt - s.firstAt)}` : ''}
        {s.status === 'running' && s.kind !== 'main' && now - s.lastAt >= 5000 ? ` · quiet ${fmtDur(now - s.lastAt)}` : ''}
      </Text>
      <Text dimColor wrap="truncate-end">
        {fmtTok(s.tok.out)} out · {fmtTok(s.tok.cw)} cached · {fmtTok(s.tok.cr)} re-read
      </Text>
      <Text dimColor wrap="truncate-end">
        {fmtUsd(perStep)} per request{hit === undefined ? '' : ` · cache served ${fmtPct(hit * 100)}`}
      </Text>
      {members.length > 0 && <Text dimColor>{members.length} {members.length === 1 ? 'agent' : 'agents'}:</Text>}
      {members.slice(0, 6).map(m => (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {m.status === 'running' ? '●' : m.status === 'failed' ? '✗' : '✓'} {clip(m.label, nameW).padEnd(nameW)}{' '}
          {fmtUsd(m.usd).padStart(8)}
        </Text>
      ))}
      {members.length > 6 && <Text dimColor>{'  '}+{members.length - 6} more</Text>}
    </Box>
  )
}

function printer(Text: Ui['Text'], tick: number): RenderElement {
  const belt = '  $  ▓▓  $  ▓▓  $  ▓▓  $  ▓▓'
  const at = tick % 8
  const bills = belt.slice(at, at + 13).padEnd(13)
  return (
    <Text color="success">
      {'╭───────────────╮\n'}
      {`│ ${bills} │  b${'r'.repeat(2 + (tick % 5))}\n`}
      {'╰─┬───────────┬─╯\n'}
      {'  ┷           ┷  '}
    </Text>
  )
}

/** The one-line status chip shown under the prompt while the pane is closed. */
export function chipText(core: SpendCore | null, live: SpendLive): string | undefined {
  if (core === null) return undefined
  const parts = [`◆ ${fmtUsd(core.usd)}`]
  if (core.turn !== null) parts.push(`turn +${fmtUsd((core.turn.usd1 ?? core.usd) - core.turn.usd0)}`)
  for (const l of core.limits) {
    if (l.kind === 'five_hour' || l.kind === 'seven_day') parts.push(`${windowName(l.kind)} ${fmtPct(l.pct)}`)
  }
  if (live.inflight > 1) parts.push(`${live.inflight} live`)
  return `${parts.join(' · ')}  (/spend)`
}
