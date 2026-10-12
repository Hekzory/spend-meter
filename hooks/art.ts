// The spend chart, stacked by who spent: in 24-bit block elements for every
// terminal, and as an anti-aliased bitmap where the kitty graphics protocol is.

import { barTotal, base64, DEFAULT_COLOR, PALETTE } from './ledger'
import type { Bar } from './ledger'

export type Cell = readonly [number, number, number]

const ch = (c: number, shift: number) => (c >> shift) & 0xff

export function mix(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t))
  const m = (s: number) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * k)
  return (m(16) << 16) | (m(8) << 8) | m(0)
}

const MARK = PALETTE.mark
const EIGHTHS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]
const COLORS = [PALETTE.main, PALETTE.agents, PALETTE.workflows]

/** The bar's stack in eighths of a cell: where each source's part ends, bottom up. */
function stack(bar: Bar, peak: number, span: number): number[] {
  const total = barTotal(bar)
  if (total <= 0) return [0, 0, 0]
  const h = Math.max(1, Math.round((total / peak) * span))
  const at = (v: number) => Math.round((v / total) * h)
  return [at(bar.main), at(bar.main + bar.agents), h]
}

/**
 * The chart in cells. Each bar stacks main thread, subagents and workflows
 * bottom up; where two parts meet inside a cell, its lower-eighths glyph
 * takes the lower part's color and its ground the upper's, so the stack stays
 * exact to an eighth of a cell.
 */
export function areaCells(bars: readonly Bar[], rows: number): Cell[] {
  const peak = Math.max(0.0001, ...bars.map(barTotal))
  const span = rows * 8
  const stacks = bars.map(b => stack(b, peak, span))
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) {
    const floor = (rows - 1 - r) * 8
    const top = floor + 8
    bars.forEach((bar, i) => {
      const bounds = stacks[i]!
      const h = bounds[2]!
      if (h <= floor) {
        if (bar.isCompacted) cells.push([0x2502, MARK, DEFAULT_COLOR])
        else if (r === rows - 1) cells.push([0x2581, PALETTE.axis, DEFAULT_COLOR])
        else cells.push([0x20, DEFAULT_COLOR, DEFAULT_COLOR])
        return
      }
      const below = COLORS[bounds.findIndex(b => b > floor)]!
      const edge = bounds.find(b => b > floor && b < top)
      if (edge === undefined) {
        cells.push([0x2588, below, DEFAULT_COLOR])
        return
      }
      const above = edge >= h ? DEFAULT_COLOR : COLORS[bounds.findIndex(b => b > edge)]!
      cells.push([EIGHTHS[edge - floor]!, below, above])
    })
  }
  return cells
}

/** The chart as a line of text, the words a picture stands in for. */
export function areaText(bars: readonly Bar[]): string {
  const peak = Math.max(0.0001, ...bars.map(barTotal))
  return bars.map(b => (barTotal(b) <= 0 ? '▁' : '▁▂▃▄▅▆▇█'[Math.min(7, Math.round((barTotal(b) / peak) * 7))])).join('')
}

const PX_W = 8
const PX_H = 16

// The last picture drawn: a redraw with the same bars sends the same source,
// which the terminal is not sent again.
const memo: { key: string; picture?: { rgba: string; width: number; height: number } } = { key: '' }

/**
 * The chart as RGBA pixels on a transparent ground: smooth stacked areas
 * through the bars, an anti-aliased line along the top, and a dashed guide
 * where the session compacted.
 */
export function areaPixels(bars: readonly Bar[], rows: number): { rgba: string; width: number; height: number } {
  const key = `${rows}|${bars.map(b => `${b.main.toFixed(5)},${b.agents.toFixed(5)},${b.workflows.toFixed(5)},${b.isCompacted ? 1 : 0}`).join(';')}`
  if (key === memo.key && memo.picture !== undefined) return memo.picture
  const width = bars.length * PX_W
  const height = rows * PX_H
  const room = height - 4 // headroom for the line
  const px = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, color: number, a: number) => {
    if (a <= 0 || y < 0 || y >= height) return
    const o = (y * width + x) * 4
    const prior = px[o + 3]! / 255
    const out = a + prior * (1 - a)
    const blend = (s: number, k: number) => Math.round((ch(color, s) * a + px[o + k]! * prior * (1 - a)) / out)
    px[o] = blend(16, 0)
    px[o + 1] = blend(8, 1)
    px[o + 2] = blend(0, 2)
    px[o + 3] = Math.round(out * 255)
  }
  // A picture reads as a rate: each bar is softened with its neighbours.
  const raw = (i: number) => bars[Math.min(bars.length - 1, Math.max(0, i))]!
  const soft = bars.map((bar, i): Bar => {
    const [l, r] = [raw(i - 1), raw(i + 1)]
    const k = (f: (b: Bar) => number) => (f(l) + 2 * f(bar) + f(r)) / 4
    return { main: k(b => b.main), agents: k(b => b.agents), workflows: k(b => b.workflows), isCompacted: bar.isCompacted }
  })
  const softPeak = Math.max(0.0001, ...soft.map(barTotal))
  const at = (i: number) => soft[Math.min(soft.length - 1, Math.max(0, i))]!
  const levels = (b: Bar) => [b.main, b.main + b.agents, barTotal(b)].map(v => (v / softPeak) * room)
  for (let x = 0; x < width; x++) {
    // Cosine interpolation between the bars' centers.
    const f = (x + 0.5) / PX_W - 0.5
    const i = Math.floor(f)
    const t = (1 - Math.cos((f - i) * Math.PI)) / 2
    const a = levels(at(i))
    const b = levels(at(i + 1))
    const tops = a.map((v, k) => v + (b[k]! - v) * t)
    if (at(Math.round(f)).isCompacted && x % PX_W === PX_W / 2) {
      for (let y = 0; y < height; y++) if (y % 4 < 2) put(x, y, MARK, 0.9)
    }
    if (tops[2]! < 0.01) {
      put(x, height - 1, PALETTE.axis, 0.9)
      continue
    }
    let below = 0
    tops.forEach((top, k) => {
      for (let y = Math.floor(height - top); y < Math.ceil(height - below); y++) {
        const cover = Math.min(1, height - below - y) * Math.min(1, y + 1 - (height - top))
        put(x, y, COLORS[k]!, 0.82 * Math.max(0, cover))
      }
      below = Math.max(below, top)
    })
    // The line along the top, in the color of the part it runs over.
    const crest = tops[2]! - tops[1]! > 0.5 ? 2 : tops[1]! - tops[0]! > 0.5 ? 1 : 0
    const y = height - tops[2]!
    for (let py = Math.floor(y) - 2; py <= Math.ceil(y) + 1; py++) {
      put(x, py, mix(COLORS[crest]!, 0xffffff, 0.25), Math.min(1, Math.max(0, 1.2 - Math.abs(py + 0.5 - y))))
    }
  }
  memo.key = key
  memo.picture = { rgba: base64(px), width, height }
  return memo.picture
}
