/** 展示格式化与数值助手（nsight 分析层共用）：时间、字节、百分比、占比条。 */

/** 纳秒 → 人类可读时长（自动选 μs/ms/s）。 */
export function formatNs(ns: number): string {
  if (!Number.isFinite(ns)) return "-"
  const abs = Math.abs(ns)
  if (abs < 1_000) return `${ns.toFixed(0)} ns`
  if (abs < 1_000_000) return `${(ns / 1_000).toFixed(2)} μs`
  if (abs < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`
  return `${(ns / 1_000_000_000).toFixed(3)} s`
}

/** 字节 → 人类可读（KB/MB/GB，十进制单位，与显存带宽口径一致）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-"
  const abs = Math.abs(bytes)
  if (abs < 1000) return `${bytes} B`
  if (abs < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} KB`
  if (abs < 1000 * 1000 * 1000) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e9).toFixed(2)} GB`
}

export function formatPct(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return "-"
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 千分位整数。 */
export function formatInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "-"
}

/** 数值列对齐渲染（报告体表格的轻量实现，避免引入表格依赖）。 */
export function renderTable(headers: string[], rows: string[][], indent = ""): string {
  if (!rows.length) return `${indent}（无数据）`
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
  const line = (cells: string[]): string =>
    indent + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] + 2))).join("")
  const sep = indent + widths.map((w, i) => "-".repeat(w + (i === widths.length - 1 ? 0 : 2))).join("")
  return [line(headers), sep, ...rows.map(line)].join("\n")
}

/** 均匀采样（用于把大数组压到可渲染规模）。 */
export function sampleEven<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items
  const out: T[] = []
  const step = items.length / max
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]!)
  return out
}

/** 数值范围统计（分位点用线性插值，无需完整统计库）。 */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

export interface Interval {
  start: number
  end: number
}

/** 合并重叠/相邻区间（GPU 繁忙时间的并集计算）。 */
export function mergeIntervals(intervals: Interval[], gapToleranceNs = 0): Interval[] {
  const items = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const cur of items) {
    const last = out[out.length - 1]
    if (last && cur.start <= last.end + gapToleranceNs) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

/** 区间集合的总覆盖长度。 */
export function totalCoverage(merged: Interval[]): number {
  return merged.reduce((sum, i) => sum + (i.end - i.start), 0)
}

/** 区间并集在 [from, to] 内的空洞（GPU 空闲缝）。 */
export function findGaps(merged: Interval[], from: number, to: number, minGapNs: number): Interval[] {
  const gaps: Interval[] = []
  let cursor = from
  for (const iv of merged) {
    if (iv.start > cursor && iv.start - cursor >= minGapNs) gaps.push({ start: cursor, end: iv.start })
    cursor = Math.max(cursor, iv.end)
  }
  if (to > cursor && to - cursor >= minGapNs) gaps.push({ start: cursor, end: to })
  return gaps.sort((a, b) => b.end - b.start - (a.end - a.start))
}

/** 扫描线求最大并发数（kernel 跨流重叠检测）。 */
export function maxConcurrency(intervals: Interval[]): number {
  const events: Array<[number, number]> = []
  for (const iv of intervals) {
    if (iv.end <= iv.start) continue
    events.push([iv.start, 1], [iv.end, -1])
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0
  let max = 0
  for (const [, delta] of events) {
    cur += delta
    if (cur > max) max = cur
  }
  return max
}
