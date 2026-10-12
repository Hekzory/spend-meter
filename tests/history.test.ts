import { describe, expect, test } from 'claude-code/testing'

import { rebuild } from '../hooks/history'

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const usage = (out: number, w1h: number, w5m: number) => ({
  input_tokens: 10,
  output_tokens: out,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: w1h + w5m,
  cache_creation: { ephemeral_1h_input_tokens: w1h, ephemeral_5m_input_tokens: w5m },
})

describe('reading a session back', () => {
  test('one response written per block is billed once, at its final counts', () => {
    const main = [
      row({ type: 'user', timestamp: '2026-10-12T10:00:00Z', message: { content: 'go' } }),
      row({ type: 'assistant', timestamp: '2026-10-12T10:00:05Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(5, 1000, 0) } }),
      row({ type: 'assistant', timestamp: '2026-10-12T10:00:06Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: usage(500, 1000, 0) } }),
      row({ type: 'user', timestamp: '2026-10-12T10:00:07Z', message: { content: [{ type: 'tool_result' }] } }),
      'not json {',
    ].join('\n')
    const agent = row({
      type: 'assistant',
      timestamp: '2026-10-12T10:00:09Z',
      message: { id: 'm2', model: 'claude-haiku-5-5', usage: usage(100, 0, 2000) },
    })
    const r = rebuild(
      [{ text: main }, { agentId: 'a1', meta: { label: 'Explore · scan', type: 'Explore' }, text: agent }],
      Date.parse('2026-10-12T11:00:00Z'),
    )
    expect(r.responses).toBe(2)
    // Opus 5.5: 10 in × $4 + 500 out × $20 + 1000 read × $0.20 + 1000 1h-write × $8, per million.
    expect(Math.round((r.sources.rows['main']?.usd ?? 0) * 1e6)).toBe(40 + 10_000 + 200 + 8000)
    // Haiku 5.5 at 5-minute writes: 10 × 0.1 + 100 × 0.5 + 1000 × 0.01 + 2000 × 0.125.
    expect(Math.round((r.sources.rows['agent:a1']?.usd ?? 0) * 1e6)).toBe(1 + 50 + 10 + 250)
    expect(r.sources.rows['agent:a1']?.status).toBe('done')
    expect(r.turn?.startedAt).toBe(Date.parse('2026-10-12T10:00:00Z'))
    expect(Math.round((r.turn?.usd ?? 0) * 1e6)).toBe(18_240 + 311)
  })

  test('compactions are read back with their sizes', () => {
    const text = row({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-10-12T10:30:00Z',
      compactMetadata: { trigger: 'manual', preTokens: 537_188, postTokens: 16_389 },
    })
    const r = rebuild([{ text }], Date.parse('2026-10-12T11:00:00Z'))
    expect(r.compactions).toEqual([{ at: Date.parse('2026-10-12T10:30:00Z'), trigger: 'manual', from: 537_188, to: 16_389 }])
  })

  test('responses after the cutoff are left to the live hooks', () => {
    const text = row({ type: 'assistant', timestamp: '2026-10-12T12:00:00Z', message: { id: 'm', model: 'claude-opus-5-5', usage: usage(1, 0, 0) } })
    expect(rebuild([{ text }], Date.parse('2026-10-12T11:00:00Z')).responses).toBe(0)
  })
})
