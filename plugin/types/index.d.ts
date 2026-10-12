// The spend meter's state contract: every value it keeps in `$.state`.

export type SpendTokens = { in: number; out: number; cr: number; cw: number }

/** USD by what was paid for: written output, new input cached, input re-read from cache, input never cached. */
export type SpendParts = { input: number; output: number; read: number; write: number }

/** A compaction: when, why, and the context before and after, in tokens. */
export type SpendCompaction = { at: number; trigger: string; from?: number; to?: number }

export type SpendLimit = { kind: string; pct: number; resetsAt?: string }

/** One rate-limit window as this session has watched it move. */
export type SpendWindow = {
  /** Percent when the session first saw this window (or since its last reset). */
  first: number
  last: number
  resetsAt?: string
  /** What earlier windows moved before they reset, in percent points. */
  carried: number
  /** Recent readings, `[at, pct]`, for the pace projection. */
  samples: [number, number][]
}

export type SpendCore = {
  /** The engine's own total, as /cost has it (subagents and workflows included). */
  usd: number
  /** What the total was when the meter first looked: spend it did not watch. */
  usd0: number
  startedAt: number
  at: number
  ctxTokens?: number
  ctxWindow: number
  ctxPct?: number
  limits: SpendLimit[]
  windows: Record<string, SpendWindow>
  isSubscriber: boolean
  turn: { startedAt: number; usd0: number; endedAt?: number; usd1?: number } | null
  /** Milestones and alerts already raised, so each fires once. */
  fired: string[]
  /** The ledger's format once the session's transcripts were read back into it. */
  ledger?: number
  compactions?: SpendCompaction[]
}

export type SpendSourceKind = 'main' | 'agent' | 'workflow' | 'fork'

export type SpendSource = {
  key: string
  kind: SpendSourceKind
  label: string
  type?: string
  model?: string
  usd: number
  cost: SpendParts
  /** False while some of its responses came from a model the price list lacks. */
  isPriced: boolean
  tok: SpendTokens
  steps: number
  status: 'running' | 'done' | 'failed'
  firstAt: number
  lastAt: number
  /** For a workflow run: its agents, by id, with what each spent. */
  members?: Record<string, { label: string; usd: number; steps: number; status: 'running' | 'done' | 'failed' }>
}

export type SpendAgentMeta = {
  label: string
  type: string
  runId?: string
  model?: string
}

export type SpendSources = {
  rows: Record<string, SpendSource>
  /** agentId to what it is, from `agent.spawn`. */
  agents: Record<string, SpendAgentMeta>
  /** Workflow tool_use_id to the workflow's name. */
  workflows: Record<string, string>
}

/** Spend per time bucket: the engine's total moved, split by who spent it. */
export type SpendSeries = {
  bucketMs: number
  /** Start of the newest bucket. */
  t0: number
  /** Oldest first: `[total, main, agents, workflows]` in USD. */
  buckets: [number, number, number, number][]
}

export type SpendPrefs = {
  unit: number
  chip: boolean
  /** The milestone toasts ($1, π, $42…). */
  eggs: boolean
  budget: number | null
  open: boolean
  selected: string | null
  /** How the chart is drawn: block-element cells, kitty-protocol pixels, or whichever the terminal takes. */
  gfx?: 'auto' | 'cells' | 'pixels'
}

export type SpendLive = {
  tick: number
  inflight: number
  /** What the responses still streaming have written so far, priced. */
  estUsd: number
  /** Source keys with a response streaming now. */
  keys: string[]
  flash: { kind: 'brrr'; until: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'spend-meter': {
      core: SpendCore | null
      sources: SpendSources
      series: SpendSeries
      prefs: SpendPrefs
      live: SpendLive
    }
  }
}
