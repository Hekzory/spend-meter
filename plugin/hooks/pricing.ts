// List prices per million tokens, as Claude Code 2.1.300's own model catalog
// has them (the same table /cost prices with), and the step pricing it does.
// The engine hands a mod the session's total but not each response's dollars,
// so this prices each response to say who spent what; the total stays the
// engine's.

import type { ModelUsage } from 'claude-code'

type Rates = { in: number; out: number; w5m: number; w1h: number; read: number }
type Tier = Rates & { long?: Rates & { above: number } }

const tier = (input: number, output: number, read = input / 10): Tier => ({
  in: input,
  out: output,
  w5m: input * 1.25,
  w1h: input * 2,
  read,
})

const TIERS = {
  haiku_35: tier(0.8, 4),
  haiku_45: tier(1, 5),
  haiku_55: { ...tier(0.1, 0.5), long: { ...tier(0.5, 2.5), above: 100_000 } },
  tier_2_10: tier(2, 10),
  tier_2_10_cr_010: tier(2, 10, 0.1),
  tier_3_15: tier(3, 15),
  tier_4_20_cr_020: tier(4, 20, 0.2),
  tier_5_25: tier(5, 25),
  tier_10_50: tier(10, 50),
  tier_10_50_cr_025: tier(10, 50, 0.25),
  tier_15_75: tier(15, 75),
} satisfies Record<string, Tier>

const CATALOG: Record<string, { name: string; tier: keyof typeof TIERS }> = {
  'claude-3-5-haiku': { name: 'Haiku 3.5', tier: 'haiku_35' },
  'claude-haiku-4-5': { name: 'Haiku 4.5', tier: 'haiku_45' },
  'claude-haiku-5-5': { name: 'Haiku 5.5', tier: 'haiku_55' },
  'claude-3-5-sonnet': { name: 'Sonnet 3.5', tier: 'tier_3_15' },
  'claude-3-7-sonnet': { name: 'Sonnet 3.7', tier: 'tier_3_15' },
  'claude-sonnet-4-0': { name: 'Sonnet 4', tier: 'tier_3_15' },
  'claude-sonnet-4-5': { name: 'Sonnet 4.5', tier: 'tier_3_15' },
  'claude-sonnet-4-6': { name: 'Sonnet 4.6', tier: 'tier_3_15' },
  'claude-sonnet-5': { name: 'Sonnet 5', tier: 'tier_2_10' },
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', tier: 'tier_2_10_cr_010' },
  'claude-opus-4-0': { name: 'Opus 4', tier: 'tier_15_75' },
  'claude-opus-4-1': { name: 'Opus 4.1', tier: 'tier_15_75' },
  'claude-opus-4-5': { name: 'Opus 4.5', tier: 'tier_5_25' },
  'claude-opus-4-6': { name: 'Opus 4.6', tier: 'tier_5_25' },
  'claude-opus-4-7': { name: 'Opus 4.7', tier: 'tier_5_25' },
  'claude-opus-4-8': { name: 'Opus 4.8', tier: 'tier_5_25' },
  'claude-opus-5': { name: 'Opus 5', tier: 'tier_5_25' },
  'claude-opus-5-5': { name: 'Opus 5.5', tier: 'tier_4_20_cr_020' },
  'claude-fable-5': { name: 'Fable 5', tier: 'tier_10_50' },
  'claude-fable-5-1': { name: 'Fable 5.1', tier: 'tier_10_50_cr_025' },
  'claude-mythos-5': { name: 'Mythos 5', tier: 'tier_10_50' },
  'claude-mythos-5-1': { name: 'Mythos 5.1', tier: 'tier_10_50_cr_025' },
}

// Longest first, so `claude-opus-5-5` wins over `claude-opus-5`.
const IDS = Object.keys(CATALOG).sort((a, b) => b.length - a.length)

/**
 * The catalog id a reported model id names: a dated id
 * (`claude-opus-5-5-20261001`), a provider's (`us.anthropic.claude-...-v1:0`)
 * or one with a context suffix (`claude-fable-5-1[1m]`).
 */
export function catalogId(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const id = model.toLowerCase()
  for (const known of IDS) {
    const at = id.indexOf(known)
    if (at < 0) continue
    const before = id[at - 1]
    const rest = id.slice(at + known.length)
    if (before !== undefined && /[a-z0-9]/.test(before)) continue
    // `-5` after `claude-opus-5` is another model; `-20261001` is a date.
    if (/^-\d(\D|$)/.test(rest) || /^\d/.test(rest)) continue
    return known
  }
  return undefined
}

export function modelName(model: string | undefined): string {
  const id = catalogId(model)
  if (id !== undefined) return CATALOG[id]?.name ?? id
  if (model === undefined || model === '') return '?'
  return model.replace(/^claude-/, '')
}

/** USD per million output tokens, for pricing what is still streaming. */
export function outputRate(model: string | undefined): number {
  const id = catalogId(model)
  return id === undefined ? 0 : (TIERS[CATALOG[id]!.tier].out ?? 0)
}

/** USD per million uncached input tokens: what input would cost without the cache. */
export function inputRate(model: string | undefined): number {
  const id = catalogId(model)
  return id === undefined ? 0 : TIERS[CATALOG[id]!.tier].in
}

/** USD per million cache-read tokens: what re-reading the context costs. */
export function readRate(model: string | undefined): number {
  const id = catalogId(model)
  return id === undefined ? 0 : TIERS[CATALOG[id]!.tier].read
}

/** A response's usage as the transcript records it: the API's own fields. */
export type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  server_tool_use?: { web_search_requests?: number }
  inference_geo?: string
}

/**
 * What a response cost, by what was paid for: `output` the tokens the model
 * wrote, `write` new input stored in the prompt cache, `read` input served
 * from it, `input` input never cached (web searches count here too).
 */
export type Parts = { input: number; output: number; read: number; write: number }

export const NO_PARTS: Parts = { input: 0, output: 0, read: 0, write: 0 }

export const partsTotal = (p: Parts) => p.input + p.output + p.read + p.write

export function addParts(a: Parts, b: Parts | undefined): Parts {
  if (b === undefined) return a
  return { input: a.input + b.input, output: a.output + b.output, read: a.read + b.read, write: a.write + b.write }
}

function rates(model: string | undefined, prompt: number): Rates | undefined {
  const id = catalogId(model)
  if (id === undefined) return undefined
  const base: Tier = TIERS[CATALOG[id]!.tier]
  return base.long !== undefined && prompt > base.long.above ? base.long : base
}

/**
 * What a transcript's response cost, priced as Claude Code prices it: the
 * cache writes split by their TTL, US-only inference at 1.1×, web searches
 * at a cent each. Undefined for a model the catalog lacks.
 */
export function priceRaw(model: string | undefined, u: RawUsage): Parts | undefined {
  const input = u.input_tokens ?? 0
  const read = u.cache_read_input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  const r = rates(model, input + read + written)
  if (r === undefined) return undefined
  const w1h = Math.min(u.cache_creation?.ephemeral_1h_input_tokens ?? 0, written)
  const k = (u.inference_geo === 'us' ? 1.1 : 1) / 1e6
  return {
    input: input * r.in * k + (u.server_tool_use?.web_search_requests ?? 0) * 0.01,
    output: (u.output_tokens ?? 0) * r.out * k,
    read: read * r.read * k,
    write: (w1h * r.w1h + (written - w1h) * r.w5m) * k,
  }
}

/**
 * What one response cost at list price, or undefined for a model the catalog
 * lacks. `ttl` is how long the prompt cache was written for: Claude Code
 * writes the main thread's for an hour on a subscription, a subagent's for
 * five minutes.
 */
export function priceUsage(model: string | undefined, usage: ModelUsage, ttl: '5m' | '1h'): Parts | undefined {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const r = rates(model, prompt)
  if (r === undefined) return undefined
  return {
    input: (usage.input_tokens * r.in) / 1e6,
    output: (usage.output_tokens * r.out) / 1e6,
    read: (usage.cache_read_input_tokens * r.read) / 1e6,
    write: (usage.cache_creation_input_tokens * (ttl === '1h' ? r.w1h : r.w5m)) / 1e6,
  }
}
