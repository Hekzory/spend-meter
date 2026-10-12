// What the session spent before the meter watched: read back from its
// transcripts (the main thread's, each subagent's, each workflow agent's),
// every response priced exactly as Claude Code prices it.

import type { ModelUsage } from 'claude-code'

import type { SpendAgentMeta, SpendCompaction, SpendSeries, SpendSources } from '../types'
import { addStep, addToSeries, attribute, EMPTY_SERIES, EMPTY_SOURCES, finishAgent } from './ledger'
import { partsTotal, priceRaw } from './pricing'
import type { RawUsage } from './pricing'

export type TranscriptFile = { agentId?: string; meta?: SpendAgentMeta; text: string }

export type Rebuilt = {
  sources: SpendSources
  series: SpendSeries
  usd: number
  responses: number
  /** The last prompt's turn: when it began and ended, and what it cost. */
  turn?: { startedAt: number; endedAt: number; usd: number }
  compactions: SpendCompaction[]
}

type Billed = { at: number; agentId?: string; model: string; usage: RawUsage }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// A response is written once per content block, each row carrying its usage
// as of then: the largest of each count is the response's.
function merge(a: RawUsage, b: RawUsage): RawUsage {
  return {
    input_tokens: Math.max(num(a.input_tokens), num(b.input_tokens)),
    output_tokens: Math.max(num(a.output_tokens), num(b.output_tokens)),
    cache_read_input_tokens: Math.max(num(a.cache_read_input_tokens), num(b.cache_read_input_tokens)),
    cache_creation_input_tokens: Math.max(num(a.cache_creation_input_tokens), num(b.cache_creation_input_tokens)),
    cache_creation: {
      ephemeral_5m_input_tokens: Math.max(
        num(a.cache_creation?.ephemeral_5m_input_tokens),
        num(b.cache_creation?.ephemeral_5m_input_tokens),
      ),
      ephemeral_1h_input_tokens: Math.max(
        num(a.cache_creation?.ephemeral_1h_input_tokens),
        num(b.cache_creation?.ephemeral_1h_input_tokens),
      ),
    },
    server_tool_use: {
      web_search_requests: Math.max(
        num(a.server_tool_use?.web_search_requests),
        num(b.server_tool_use?.web_search_requests),
      ),
    },
    inference_geo: b.inference_geo ?? a.inference_geo,
  }
}

const asModelUsage = (u: RawUsage): ModelUsage => ({
  input_tokens: num(u.input_tokens),
  output_tokens: num(u.output_tokens),
  cache_read_input_tokens: num(u.cache_read_input_tokens),
  cache_creation_input_tokens: num(u.cache_creation_input_tokens),
})

/** Whether a user row is a prompt the person sent, not a tool result or a note. */
function isPrompt(row: { isMeta?: unknown; isSidechain?: unknown; isCompactSummary?: unknown; message?: { content?: unknown } }) {
  if (row.isMeta === true || row.isSidechain === true || row.isCompactSummary === true) return false
  const content = row.message?.content
  if (typeof content === 'string') return !content.startsWith('<local-command') && !content.startsWith('Caveat:')
  return (
    Array.isArray(content) &&
    content.some(b => (b as { type?: unknown }).type === 'text') &&
    !content.some(b => (b as { type?: unknown }).type === 'tool_result')
  )
}

/** The ledger the transcripts add up to, counting responses up to `cutoff`. */
export function rebuild(files: readonly TranscriptFile[], cutoff: number): Rebuilt {
  const agents: Record<string, SpendAgentMeta> = {}
  for (const f of files) if (f.agentId !== undefined && f.meta !== undefined) agents[f.agentId] = f.meta
  const billed: Billed[] = []
  const compactions: SpendCompaction[] = []
  let promptAt: number | undefined
  for (const f of files) {
    const byId = new Map<string, Billed>()
    for (const line of f.text.split('\n')) {
      const isMain = f.agentId === undefined
      const isUser = isMain && line.includes('"type":"user"')
      const isCompaction = isMain && line.includes('"compact_boundary"')
      if (!isUser && !isCompaction && !line.includes('"type":"assistant"')) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // a torn last line, or a chunk's edge
      }
      const at = Date.parse(String(row['timestamp']))
      if (!Number.isFinite(at) || at > cutoff) continue
      if (row['subtype'] === 'compact_boundary') {
        const meta = row['compactMetadata'] as { trigger?: string; preTokens?: number; postTokens?: number } | undefined
        compactions.push({ at, trigger: meta?.trigger ?? 'auto', from: meta?.preTokens, to: meta?.postTokens })
        continue
      }
      if (row['type'] === 'user') {
        if (isPrompt(row as Parameters<typeof isPrompt>[0])) promptAt = at
        continue
      }
      if (row['type'] !== 'assistant') continue
      const m = row['message'] as { id?: string; model?: string; usage?: RawUsage } | undefined
      if (m?.usage === undefined || m.model === undefined || m.model === '<synthetic>') continue
      const id = m.id ?? String(row['requestId'] ?? row['uuid'])
      const prev = byId.get(id)
      byId.set(
        id,
        prev === undefined
          ? { at, agentId: f.agentId, model: m.model, usage: m.usage }
          : { ...prev, at: Math.max(prev.at, at), usage: merge(prev.usage, m.usage) },
      )
    }
    billed.push(...byId.values())
  }
  billed.sort((a, b) => a.at - b.at)

  let sources: SpendSources = { ...EMPTY_SOURCES, agents }
  let series: SpendSeries = EMPTY_SERIES
  let usd = 0
  let turnUsd = 0
  let lastAt = 0
  for (const b of billed) {
    const parts = priceRaw(b.model, b.usage)
    const who = attribute(b.agentId, sources)
    sources = addStep(sources, who, b.model, asModelUsage(b.usage), parts, b.at)
    const c = parts === undefined ? 0 : partsTotal(parts)
    usd += c
    series = addToSeries(series, b.at, {
      main: who.kind === 'main' ? c : 0,
      agents: who.kind === 'agent' || who.kind === 'fork' ? c : 0,
      workflows: who.kind === 'workflow' ? c : 0,
    })
    if (promptAt !== undefined && b.at >= promptAt) turnUsd += c
    lastAt = b.at
  }
  for (const id of Object.keys(agents)) sources = finishAgent(sources, id, 'done')
  return {
    sources,
    series,
    usd,
    responses: billed.length,
    turn: promptAt === undefined ? undefined : { startedAt: promptAt, endedAt: Math.max(lastAt, promptAt), usd: turnUsd },
    compactions: compactions.slice(-20),
  }
}
