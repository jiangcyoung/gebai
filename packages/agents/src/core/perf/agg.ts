/**
 * 流式聚合原语（性能分析类子Agent 共用基建，不隶属任何单一报告格式）。
 *
 * 提供：区间并集与最大并发（含空闲缝）、自适应分辨率时间线分桶、Top-K 排行、
 * 受控采样分位数、区间交集与「由空闲缝反推并集」等——nsys 事件库与 PyTorch trace
 * 两个分析面都建立在这些原语上，故物理置于 core/ 供各自独立引用（两面之间无依赖）。
 *
 * 全部原语满足「内存与输入规模解耦」：容量恒定、单趟、无全量物化。
 * 时间量纲由调用方统一（本文件不假定单位；nsys 事件库与 torch trace 各自在边界换算）。
 */

export interface SqliteStatement {
  iterate: (...params: unknown[]) => IterableIterator<unknown>
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
}

export interface SqliteLike {
  query: (sql: string) => SqliteStatement
}

/** 逐行流式消费查询结果（O(1) 内存——不构建全量数组）。 */
export function streamRows<T = Record<string, unknown>>(db: SqliteLike, sql: string, ...params: unknown[]): IterableIterator<T> {
  return db.query(sql).iterate(...params) as IterableIterator<T>
}

/** 单值查询（COUNT/SUM/MIN/MAX 等聚合下推到 SQLite，避免把行带回 JS）。 */
export function scalar(db: SqliteLike, sql: string, ...params: unknown[]): number {
  try {
    const row = db.query(sql).get(...params) as Record<string, unknown> | null | undefined
    if (!row) return 0
    const v = Object.values(row)[0]
    return typeof v === "number" ? v : Number(v ?? 0) || 0
  } catch {
    return 0
  }
}

/** 取首行（可能为 undefined）。 */
export function firstRow<T = Record<string, unknown>>(db: SqliteLike, sql: string, ...params: unknown[]): T | undefined {
  try {
    return (db.query(sql).get(...params) ?? undefined) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * 受控采样器（分位数估计）：先精确保存至多 cap 个样本；
 * 超出后按蓄水池抽样替换——内存恒定，且如实标记 `sampled`（调用方须向用户说明分位数为估计值）。
 */
export class ValueSampler {
  private values: number[] = []
  private seenCount = 0
  private sampled = false
  private rngState: number

  /**
   * @param cap 容量（内存恒定）
   * @param seed 采样随机种子——**固定种子**使采样可重现：同一报告重复分析得到同一组分位数
   *   （与原生边的固定种子同语义，否则两套实现的等价性与「重跑结果一致」都不成立）。
   */
  constructor(private readonly cap = 20_000, seed = 0x9e3779b9) {
    this.rngState = seed >>> 0
  }

  /** mulberry32：无依赖、分布均匀的整数混洗（与 Math.random 相比可重现）。 */
  private nextRandom(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0
    let t = this.rngState
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }

  add(v: number): void {
    this.seenCount++
    if (this.values.length < this.cap) {
      this.values.push(v)
      return
    }
    this.sampled = true
    const idx = Math.floor(this.nextRandom() * this.seenCount)
    if (idx < this.cap) this.values[idx] = v
  }

  get count(): number {
    return this.seenCount
  }

  get isSampled(): boolean {
    return this.sampled
  }

  /** 分位数（0~1）。排序一次，仅在需要时调用（被报告的分组才计算）。 */
  quantile(q: number): number {
    if (!this.values.length) return 0
    const sorted = [...this.values].sort((a, b) => a - b)
    const pos = (sorted.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
  }
}

/** Top-K 收集器（按权重降序，容量恒定——排行榜不随输入规模增长）。 */
export class TopK<T> {
  private items: Array<{ key: string; weight: number; value: T }> = []

  constructor(
    private readonly k: number,
    private readonly keyOf: (v: T) => string,
    private readonly weightOf: (v: T) => number,
  ) {}

  add(value: T): void {
    const weight = this.weightOf(value)
    const key = this.keyOf(value)
    const existing = this.items.findIndex((i) => i.key === key)
    if (existing >= 0) {
      this.items[existing]!.weight = weight
      this.items[existing]!.value = value
    } else {
      if (this.items.length >= this.k) {
        // 容量已满：仅当新项权重高于当前最小项时替换
        let minIdx = 0
        for (let i = 1; i < this.items.length; i++) if (this.items[i]!.weight < this.items[minIdx]!.weight) minIdx = i
        if (this.items[minIdx]!.weight >= weight) return
        this.items[minIdx] = { key, weight, value }
      } else {
        this.items.push({ key, weight, value })
      }
    }
    this.items.sort((a, b) => b.weight - a.weight)
  }

  toArray(): T[] {
    return this.items.map((i) => i.value)
  }

  get size(): number {
    return this.items.length
  }
}

/**
 * 自适应分辨率时间线直方图（单趟扫描，内存恒定）：
 * 窗口大小事前未知，而固定桶需要窗口边界——本类从粗初值开始，桶溢出即倍粗分辨率并合并相邻桶，
 * 因此无需第二遍扫描，也不随报告时长增长内存（桶数恒定封顶）。
 */
export class AdaptiveBins {
  private countsArr: Float64Array
  private busyArr: Float64Array
  private widthNs: number
  private origin = Number.POSITIVE_INFINITY
  private lastEnd = 0

  constructor(
    private readonly cap = 1_024,
    initialWidthNs = 100_000,
  ) {
    this.widthNs = initialWidthNs
    this.countsArr = new Float64Array(cap)
    this.busyArr = new Float64Array(cap)
  }

  /** 建立时间原点（首个事件起点）。 */
  private anchor(start: number): void {
    if (this.origin === Number.POSITIVE_INFINITY) {
      this.origin = start
      this.lastEnd = start
    }
  }

  /** 倍粗分辨率并合并相邻桶（O(cap)）。 */
  private coarsen(): void {
    const counts = new Float64Array(this.cap)
    const busy = new Float64Array(this.cap)
    for (let i = 0; i < this.cap; i++) {
      const target = i >> 1
      counts[target]! += this.countsArr[i]!
      busy[target]! += this.busyArr[i]!
    }
    this.countsArr = counts
    this.busyArr = busy
    this.widthNs *= 2
  }

  add(start: number, end: number): void {
    if (end <= start) return
    this.anchor(start)
    if (end > this.lastEnd) this.lastEnd = end
    // 分辨率不足：持续倍粗直到末端落在容量内
    while ((end - this.origin) / this.widthNs >= this.cap) this.coarsen()
    const first = Math.max(0, Math.floor((start - this.origin) / this.widthNs))
    const last = Math.min(this.cap - 1, Math.floor((end - this.origin) / this.widthNs))
    for (let b = first; b <= last; b++) {
      const binStart = this.origin + b * this.widthNs
      const binEnd = binStart + this.widthNs
      this.countsArr[b]! += 1
      this.busyArr[b]! += Math.max(0, Math.min(end, binEnd) - Math.max(start, binStart))
    }
  }

  /** 降采样为占用序列（0~1，长度不超 targetPoints）——紧凑时间线。 */
  occupancySeries(targetPoints: number): { series: number[]; resolutionNs: number; origin: number } {
    const used = Math.min(this.cap, Math.max(1, Math.ceil((this.lastEnd - this.origin) / this.widthNs)))
    const stride = Math.max(1, Math.ceil(used / targetPoints))
    const series: number[] = []
    for (let b = 0; b < used; b += stride) {
      let busy = 0
      for (let k = b; k < Math.min(used, b + stride); k++) busy += this.busyArr[k] ?? 0
      const spanNs = this.widthNs * Math.min(stride, used - b)
      series.push(Math.min(1, spanNs > 0 ? busy / spanNs : 0))
    }
    return { series, resolutionNs: this.widthNs, origin: Number.isFinite(this.origin) ? this.origin : 0 }
  }
}

/**
 * 区间并集流式计算器：输入按 start 升序（可来自多路游标合并），
 * 恒定内存地得到忙碌总时长、最大并发与空闲缝——不保存全部区间。
 * 最大并发用「结束时间小顶堆」精确计算（堆大小 = 并发度，与事件总数无关）。
 */
export class IntervalUnionStreamer {
  private runningMaxEnd = Number.NEGATIVE_INFINITY
  private busyNs = 0
  private readonly heap: number[] = []
  private maxConcurrent = 0
  private firstStart = Number.NEGATIVE_INFINITY
  private lastEnd = Number.NEGATIVE_INFINITY
  private readonly gaps: Array<{ start: number; end: number }> = []
  private truncatedGaps = false

  constructor(
    private readonly minGapNs: number,
    private readonly maxGaps = 50_000,
  ) {}

  private heapPush(v: number): void {
    this.heap.push(v)
    let i = this.heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.heap[parent]! <= this.heap[i]!) break
      const tmp = this.heap[parent]!
      this.heap[parent] = this.heap[i]!
      this.heap[i] = tmp
      i = parent
    }
  }

  private heapPop(): void {
    const last = this.heap.pop()!
    if (!this.heap.length) return
    this.heap[0] = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let smallest = i
      if (l < this.heap.length && this.heap[l]! < this.heap[smallest]!) smallest = l
      if (r < this.heap.length && this.heap[r]! < this.heap[smallest]!) smallest = r
      if (smallest === i) break
      const tmp = this.heap[smallest]!
      this.heap[smallest] = this.heap[i]!
      this.heap[i] = tmp
      i = smallest
    }
  }

  add(start: number, end: number): void {
    if (end <= start) return
    if (this.firstStart === Number.NEGATIVE_INFINITY || start < this.firstStart) this.firstStart = start
    if (end > this.lastEnd) this.lastEnd = end

    // 空闲缝：本区间起点晚于已建立的并集右边界 —— [并集右边界, 起点] 为 GPU 无活动区间
    if (this.runningMaxEnd !== Number.NEGATIVE_INFINITY && start > this.runningMaxEnd && start - this.runningMaxEnd >= this.minGapNs) {
      if (this.gaps.length < this.maxGaps) this.gaps.push({ start: this.runningMaxEnd, end: start })
      else this.truncatedGaps = true
    }

    // 并集增长量
    if (this.runningMaxEnd === Number.NEGATIVE_INFINITY) {
      this.busyNs += end - start
      this.runningMaxEnd = end
    } else if (end > this.runningMaxEnd) {
      this.busyNs += end - Math.max(start, this.runningMaxEnd)
      this.runningMaxEnd = end
    }

    // 最大并发：弹出所有已结束的区间后再入堆（输入按 start 升序，堆顶为最早结束者）
    while (this.heap.length && this.heap[0]! <= start) this.heapPop()
    this.heapPush(end)
    if (this.heap.length > this.maxConcurrent) this.maxConcurrent = this.heap.length
  }

  /** 汇总结果（空闲缝按间隔降序）。 */
  result(): {
    busyNs: number
    firstStart: number
    lastEnd: number
    spanNs: number
    utilization: number
    gaps: Array<{ start: number; end: number }>
    gapsTruncated: boolean
    maxConcurrent: number
  } {
    const firstStart = Number.isFinite(this.firstStart) ? this.firstStart : 0
    const lastEnd = Number.isFinite(this.lastEnd) ? this.lastEnd : 0
    const spanNs = Math.max(0, lastEnd - firstStart)
    const gaps = [...this.gaps].sort((a, b) => b.end - b.start - (a.end - a.start))
    return {
      busyNs: this.busyNs,
      firstStart,
      lastEnd,
      spanNs,
      utilization: spanNs > 0 ? this.busyNs / spanNs : 0,
      gaps,
      gapsTruncated: this.truncatedGaps,
      maxConcurrent: this.maxConcurrent,
    }
  }
}

/** 事件区间（start/end 已解析）。 */
export interface RawInterval {
  start: number
  end: number
}

/**
 * 由空闲缝反推并集区间（升序）：并集 = [from,to] 去除空闲缝的补集。
 * 这样无需单独保存全部区间就能拿到合并后的忙碌区间（空闲缝数量远小于事件数）。
 */
export function mergedFromGaps(gaps: RawInterval[], from: number, to: number): RawInterval[] {
  if (to <= from) return []
  const sorted = [...gaps].sort((a, b) => a.start - b.start)
  const out: RawInterval[] = []
  let cursor = from
  for (const g of sorted) {
    const s = Math.max(from, g.start)
    const e = Math.min(to, g.end)
    if (e <= cursor) continue
    if (s > cursor) out.push({ start: cursor, end: s })
    cursor = Math.max(cursor, e)
  }
  if (cursor < to) out.push({ start: cursor, end: to })
  return out.filter((iv) => iv.end > iv.start)
}

/**
 * 两组升序区间的交集总长（双指针，O(n+m)）；`withPerItem` 时另给出 b 中每个区间的交集长度
 * （用于「GPU 空闲缝期间 CPU 是否在忙」这类逐缝归因）。
 */
export function intersectionTotals(a: RawInterval[], b: RawInterval[], withPerItem = false): { total: number; perItemB?: number[] } {
  let i = 0
  let j = 0
  let total = 0
  const perItem = withPerItem ? new Array<number>(b.length).fill(0) : undefined
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]!.start, b[j]!.start)
    const hi = Math.min(a[i]!.end, b[j]!.end)
    if (hi > lo) {
      total += hi - lo
      if (perItem) perItem[j] += hi - lo
    }
    if (a[i]!.end <= b[j]!.end) i++
    else j++
  }
  return { total, perItemB: perItem }
}

/** 精确最大并发数（独立参考实现，用于校验流式堆结果；输入规模受限时使用）。 */
export function maxConcurrencyExact(intervals: RawInterval[]): number {
  const events: Array<[number, number]> = []
  for (const iv of intervals) {
    if (iv.end <= iv.start) continue
    events.push([iv.start, 1], [iv.end, -1])
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let cur = 0
  let max = 0
  for (const [, d] of events) {
    cur += d
    if (cur > max) max = cur
  }
  return max
}

/**
 * 聚合事实缓存（进程级）：报告不可变，同一份事件库的聚合结果可复用——
 * 首次分析付出扫描成本，后续（概览/热点/诊断/定位）直接命中，避免重复全表扫描。
 */
interface CacheEntry<T> {
  key: string
  value: T
}

const FACT_CACHE_LIMIT = 4
const factCache: CacheEntry<unknown>[] = []

export function factsCacheKey(sqlitePath: string, size: number, mtimeMs: number, variant: string): string {
  return `${sqlitePath}|${size}|${Math.round(mtimeMs)}|${variant}`
}

export function getCachedFacts<T>(key: string): T | undefined {
  const hit = factCache.find((e) => e.key === key)
  return hit ? (hit.value as T) : undefined
}

export function setCachedFacts<T>(key: string, value: T): void {
  const idx = factCache.findIndex((e) => e.key === key)
  if (idx >= 0) factCache.splice(idx, 1)
  factCache.unshift({ key, value })
  if (factCache.length > FACT_CACHE_LIMIT) factCache.length = FACT_CACHE_LIMIT
}

/** 清空事实缓存（测试用）。 */
export function _resetFactsCache(): void {
  factCache.length = 0
}
