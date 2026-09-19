/**
 * Nsight Systems 时间线分析引擎（流式实现，面向超大报告）。
 *
 * 架构（DESIGN「Nsight 报告分析 → 实时分析」）：
 * - **单次扫描产出全部时间线事实**：kernel 与显存传输两路游标按 start 归并（各自走索引，无临时排序），
 *   一趟流内同时算出 GPU 并集忙碌时长、空闲缝、时间线分桶、每内核聚合、每流统计、启动间隔排行；
 * - **内存与报告规模解耦**：全部聚合器容量恒定（Top-K、固定桶直方图、每分组受控采样器），
 *   千万级事件报告与千级事件报告占用同一量级内存；
 * - **分段缓存**：事实按「报告指纹 + 分段名」缓存（报告不可变），概览/热点/诊断/定位多次调用共享一次扫描；
 * - **聚合下推 SQL**：API/同步/NVTX 等维度用 SQL GROUP BY + ORDER BY ... LIMIT，只把有界结果带回。
 */
import type { ReportDb } from "./db"
import { enumMap, sid, stringIdsMap } from "./db"
import { AdaptiveBins, IntervalUnionStreamer, TopK, ValueSampler, factsCacheKey, firstRow, getCachedFacts, scalar, setCachedFacts, streamRows } from "./stream"
import { tableColumns, tryAll } from "./db"
import { formatInt, formatNs } from "./util"
import { withTiming } from "./timing"
import { statSync } from "node:fs"

/** 排行与采样上限（结果有界：输出规模不随报告规模增长）。 */
export const ANALYSIS_LIMITS = {
  /** 报告的内核分组上限（超过时超出部分并入溢出桶，避免极端报告撑爆内存）。 */
  maxKernelGroups: 20_000,
  /** 报告分组的分位数采样容量（每分组）。 */
  samplesPerGroup: 64,
  /** 分配采样器的分组上限。 */
  samplerGroups: 2_000,
  /** 时间线分桶数（渲染用，恒定内存）。 */
  timelineBins: 1_000,
  /** 返回给模型的时间线点数（降采样后）。 */
  timelinePoints: 240,
  /** 每个排行榜的默认条数。 */
  topRows: 20,
} as const

interface KernelGroupAcc {
  name: string
  mangled: string
  instances: number
  totalNs: number
  minNs: number
  maxNs: number
  registersPerThread: number
  grid: [number, number, number]
  block: [number, number, number]
  smemBytes: number
  streams: Set<number>
  sampler?: ValueSampler
}

export interface KernelStat {
  name: string
  mangled: string
  instances: number
  totalNs: number
  avgNs: number
  minNs: number
  maxNs: number
  /** 中位数（受控采样估计；sampled 为真时是估计值）。 */
  p50Ns: number
  p50Sampled: boolean
  grid: [number, number, number]
  block: [number, number, number]
  registersPerThread: number
  smemBytes: number
  streams: number[]
  threadsPerBlock: number
  gridBlocks: number
  totalThreads: number
}

export interface StreamStat {
  streamId: number
  kernelInstances: number
  kernelTotalNs: number
  memcpyCount: number
  memcpyBytes: number
  firstStart: number
  lastEnd: number
}

export interface MemcpyKindStat {
  kind: string
  count: number
  totalNs: number
  bytes: number
  avgBytes: number
}

export interface TimelineFacts {
  /** 报告会话起始（UTC，来自报告元数据）。 */
  sessionStartUtc: string
  /** GPU 活动窗口（首个活动起点 → 最后活动终点）。 */
  firstActivityNs: number
  lastActivityNs: number
  windowNs: number
  busyNs: number
  utilization: number
  maxConcurrent: number
  gaps: Array<{ start: number; end: number; durNs: number }>
  gapsTruncated: boolean
  gapCount: number
  gapTotalNs: number
  /** 时间线占用序列（0~1，已降采样到 timelinePoints 点）。 */
  timeline: number[]
  timelineSpanNs: number
  /** 内核聚合（按总耗时降序，容量受 topRows 限制）。 */
  kernels: KernelStat[]
  kernelDistinctGroups: number
  kernelInstances: number
  kernelTotalNs: number
  /** 平均耗时低于 threshold 的内核调用统计（启动开销受限判据）。 */
  smallKernelInstances: number
  smallKernelTotalNs: number
  smallKernelGroups: Array<{ name: string; instances: number; avgNs: number; totalNs: number }>
  /** 单次网格线程总数偏小的内核（并行度不足判据）。 */
  undersizedGroups: Array<{ name: string; instances: number; totalNs: number; grid: [number, number, number]; block: [number, number, number]; totalThreads: number }>
  /** 寄存器/共享内存占用偏高的内核（占用率压力判据）。 */
  pressuredGroups: Array<{ name: string; instances: number; totalNs: number; registersPerThread: number; smemBytes: number; block: [number, number, number] }>
  streams: StreamStat[]
  memcpyKinds: MemcpyKindStat[]
  memcpyCount: number
  memcpyTotalNs: number
  memcpyBytes: number
  memcpySlowest: Array<{ kind: string; durNs: number; bytes: number; start: number }>
  /** 同流相邻内核启动间隔排行（脚本级间隙）。 */
  launchGaps: Array<{ from: string; to: string; streamId: number; gapNs: number }>
  /** 内核单次耗时采样（全局，用于报告整体分布）：JS 路径为蓄水池采样器，原生路径由边车回报的分位点实现。 */
  kernelDurationSampler: QuantileSource
}

/** 分位数来源（JS 采样器与原生边车回报的分位点同形——原生只回报 p50/p90/p99，其余分位点按线性插值近似）。 */
export interface QuantileSource {
  readonly count: number
  readonly isSampled: boolean
  quantile(q: number): number
}

interface KernelCursorRow {
  start: number
  end: number
  demangledName: number | null
  shortName: number | null
  mangledName: number | null
  streamId: number | null
  registersPerThread: number | null
  gridX: number | null
  gridY: number | null
  gridZ: number | null
  blockX: number | null
  blockY: number | null
  blockZ: number | null
  staticSharedMemory: number | null
  dynamicSharedMemory: number | null
}

interface MemcpyCursorRow {
  start: number
  end: number
  bytes: number | null
  copyKind: number | null
  streamId: number | null
}

/** 阈值：与 findings 的判据保持同一口径（此处只做归类，判定在 findings 层）。 */
const SMALL_KERNEL_NS = 10_000
const UNDERSIZED_THREADS = 100_000
const HIGH_REGISTERS = 64
const HIGH_SMEM = 48 * 1024

/** 扫描上限保护：极长报告的排行与分组仍按上限收敛。 */
function factsCacheKeyOf(report: ReportDb, variant: string): string {
  const st = statSync(timelineSqlitePath(report))
  return factsCacheKey(timelineSqlitePath(report), st.size, st.mtimeMs, variant)
}

function timelineSqlitePath(report: ReportDb): string {
  // 事件库路径由 ReportDb 记录（缓存目录内），避免再次解析
  return report.sqlitePath
}

/**
 * 计算（或取缓存）时间线事实（JS 流式实现，单次扫描）。
 * 这是原生边车不可用时的回退路径，也是原子实现与等价性测试的基准。
 */
export function timelineFacts(report: ReportDb, opts: { smallKernelNs?: number; gapMinNs?: number } = {}): TimelineFacts {
  const cacheKey = factsCacheKeyOf(report, factsVariant(opts))
  const cached = getCachedFacts<TimelineFacts>(cacheKey)
  if (cached) return cached
  const computed = computeTimelineFacts(report, opts)
  setCachedFacts(cacheKey, computed)
  return computed
}

/** 事实缓存的分段名（不同阈值下的聚合结果不可混用）。 */
function factsVariant(opts: { smallKernelNs?: number; gapMinNs?: number }): string {
  return `timeline:${opts.smallKernelNs ?? SMALL_KERNEL_NS}:${opts.gapMinNs ?? 50_000}`
}

export interface ResolvedFacts {
  facts: TimelineFacts
  /** 聚合来源：native=原生边车（Rust），js=宿主 JS 流式实现（回退路径）。 */
  source: "native" | "js"
  /** 聚合耗时（原生为边车自报耗时；js 为宿主实测）。 */
  elapsedMs: number
  /** 原生不可用时的原因（已回退到 js；供工具如实呈现，不静默）。 */
  nativeError?: string
}

/**
 * 取时间线事实（原生优先、自动回退）：
 * - 原生边车（`nsight_aggregate`，Rust + 内嵌 SQLite）在事件规模大时优势明显——
 *   宿主 JS 层逐行取列与聚合是主成本，原生实现实测约 4 倍于 JS；
 * - 边车未构建/不可用（服务端部署下客卿整体禁用）或调用出错时**自动回退 JS 实现**，
 *   两者输出同构（等价性由测试锁定），回退原因如实回报；
 * - 结果按「报告指纹 + 阈值」缓存，同一报告的多次分析共享一次聚合。
 */
export async function resolveTimelineFacts(
  report: ReportDb,
  opts: { smallKernelNs?: number; gapMinNs?: number } = {},
): Promise<ResolvedFacts> {
  const cacheKey = factsCacheKeyOf(report, `resolved:${factsVariant(opts)}`)
  const cached = getCachedFacts<ResolvedFacts>(cacheKey)
  if (cached) return cached

  let nativeError: string | undefined
  if (report.ctx.env?.NSIGHT_NATIVE !== "off") {
    try {
      const native = await callNativeAggregate(report, opts)
      const resolved: ResolvedFacts = { facts: native.facts, source: "native", elapsedMs: native.elapsedMs }
      setCachedFacts(cacheKey, resolved)
      return resolved
    } catch (e) {
      nativeError = e instanceof Error ? e.message : String(e)
    }
  }
  const t0 = withTiming()
  const facts = timelineFacts(report, opts)
  const resolved: ResolvedFacts = { facts, source: "js", elapsedMs: t0(), nativeError }
  setCachedFacts(cacheKey, resolved)
  return resolved
}

/** 原生聚合后端工具名（客卿边车，同 nsight 子Agent 命名空间下）。 */
export const NATIVE_AGGREGATE_TOOL = "nsight_aggregate"

/** 调用原生聚合边车（未装载/未构建/报错即抛错，由上层回退）。 */
async function callNativeAggregate(
  report: ReportDb,
  opts: { smallKernelNs?: number; gapMinNs?: number },
): Promise<{ facts: TimelineFacts; elapsedMs: number }> {
  const resolved = report.ctx.registry.resolve(NATIVE_AGGREGATE_TOOL)
  if (!resolved) throw new Error(`原生边车未注册（${NATIVE_AGGREGATE_TOOL}）——未构建或当前形态下不可用`)
  const result = await resolved.tool.execute(
    {
      sqlite: report.sqlitePath,
      gap_min_ns: opts.gapMinNs ?? 50_000,
      small_kernel_ns: opts.smallKernelNs ?? SMALL_KERNEL_NS,
      timeline_points: ANALYSIS_LIMITS.timelinePoints,
      timeline_bins: ANALYSIS_LIMITS.timelineBins,
      top_rows: ANALYSIS_LIMITS.topRows,
    },
    report.ctx,
  )
  const data = result.data as Record<string, unknown> | undefined
  if (!data) throw new Error("原生边车未返回结构化聚合结果")
  return { facts: coerceNativeFacts(data), elapsedMs: Number(data.elapsedMs ?? 0) }
}

/** 校验并收窄原生返回的聚合结果（字段缺失/类型不符即抛错 → 上层回退 JS，不让脏数据进入分析）。 */
export function coerceNativeFacts(data: Record<string, unknown>): TimelineFacts {
  const num = (key: string): number => {
    const v = data[key]
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`原生聚合结果缺字段或类型不符：${key}`)
    return v
  }
  const arr = <T>(key: string): T[] => {
    const v = data[key]
    if (!Array.isArray(v)) throw new Error(`原生聚合结果缺数组字段：${key}`)
    return v as T[]
  }
  const dur = (data.kernelDurationNs ?? {}) as { count?: number; sampled?: boolean; p50?: number; p90?: number; p99?: number }
  const sampler: QuantileSource = {
    count: Number(dur.count ?? 0),
    isSampled: dur.sampled !== false,
    // 原生只回报 p50/p90/p99：其余分位点按这三点分段线性近似（报告用途足够，且标注为采样估计）
    quantile(q: number): number {
      const p50 = Number(dur.p50 ?? 0)
      const p90 = Number(dur.p90 ?? 0)
      const p99 = Number(dur.p99 ?? 0)
      if (q <= 0.5) return p50 * (q / 0.5)
      if (q <= 0.9) return p50 + (p90 - p50) * ((q - 0.5) / 0.4)
      if (q <= 0.99) return p90 + (p99 - p90) * ((q - 0.9) / 0.09)
      return p99
    },
  }
  return {
    sessionStartUtc: String(data.sessionStartUtc ?? ""),
    firstActivityNs: num("firstActivityNs"),
    lastActivityNs: num("lastActivityNs"),
    windowNs: num("windowNs"),
    busyNs: num("busyNs"),
    utilization: num("utilization"),
    maxConcurrent: num("maxConcurrent"),
    gaps: arr("gaps"),
    gapsTruncated: data.gapsTruncated === true,
    gapCount: num("gapCount"),
    gapTotalNs: num("gapTotalNs"),
    timeline: arr<number>("timeline"),
    timelineSpanNs: num("timelineSpanNs"),
    kernels: arr("kernels"),
    kernelDistinctGroups: num("kernelDistinctGroups"),
    kernelInstances: num("kernelInstances"),
    kernelTotalNs: num("kernelTotalNs"),
    smallKernelInstances: num("smallKernelInstances"),
    smallKernelTotalNs: num("smallKernelTotalNs"),
    smallKernelGroups: arr("smallKernelGroups"),
    undersizedGroups: arr("undersizedGroups"),
    pressuredGroups: arr("pressuredGroups"),
    streams: arr("streams"),
    memcpyKinds: arr("memcpyKinds"),
    memcpyCount: num("memcpyCount"),
    memcpyTotalNs: num("memcpyTotalNs"),
    memcpyBytes: num("memcpyBytes"),
    memcpySlowest: arr("memcpySlowest"),
    launchGaps: arr("launchGaps"),
    kernelDurationSampler: sampler,
  }
}

export function computeTimelineFacts(report: ReportDb, opts: { smallKernelNs?: number; gapMinNs?: number } = {}): TimelineFacts {
  const smallThreshold = opts.smallKernelNs ?? SMALL_KERNEL_NS
  const gapMinNs = opts.gapMinNs ?? 50_000
  const names = stringIdsMap(report.db)
  const memcpyKinds = enumMap(report.db, "ENUM_CUDA_MEMCPY_OPER")

  const groups = new Map<string, KernelGroupAcc>()
  let overflowGroups = 0
  let kernelInstances = 0
  let kernelTotalNs = 0
  let smallKernelInstances = 0
  let smallKernelTotalNs = 0
  const smallKernels = new TopK<{ name: string; instances: number; avgNs: number; totalNs: number }>(ANALYSIS_LIMITS.topRows, (v) => v.name, (v) => v.totalNs)
  const undersized = new TopK<{ name: string; instances: number; totalNs: number; grid: [number, number, number]; block: [number, number, number]; totalThreads: number }>(ANALYSIS_LIMITS.topRows, (v) => v.name, (v) => v.totalNs)
  const pressured = new TopK<{ name: string; instances: number; totalNs: number; registersPerThread: number; smemBytes: number; block: [number, number, number] }>(ANALYSIS_LIMITS.topRows, (v) => v.name, (v) => v.totalNs)

  const streams = new Map<number, StreamStat>()
  const streamLastEnd = new Map<number, { end: number; name: string }>()
  const launchGaps = new TopK<{ from: string; to: string; streamId: number; gapNs: number }>(ANALYSIS_LIMITS.topRows, (v) => `${v.streamId}|${v.from}|${v.to}`, (v) => v.gapNs)

  const memcpyAgg = new Map<string, { count: number; totalNs: number; bytes: number }>()
  let memcpyCount = 0
  let memcpyTotalNs = 0
  let memcpyBytes = 0
  const memcpySlowest = new TopK<{ kind: string; durNs: number; bytes: number; start: number }>(
    ANALYSIS_LIMITS.topRows,
    (v) => `${v.kind}|${v.start}`,
    (v) => v.durNs,
  )

  // 时间线并集/空闲缝/并发（单一流式计算器），分桶用自适应分辨率（单趟扫描，不需预知窗口）
  const union = new IntervalUnionStreamer(gapMinNs)
  const bins = new AdaptiveBins(ANALYSIS_LIMITS.timelineBins)
  const kernelDurationSampler = new ValueSampler(50_000)

  const ensureStream = (streamId: number): StreamStat => {
    const cur = streams.get(streamId)
    if (cur) return cur
    const fresh: StreamStat = { streamId, kernelInstances: 0, kernelTotalNs: 0, memcpyCount: 0, memcpyBytes: 0, firstStart: Number.POSITIVE_INFINITY, lastEnd: 0 }
    streams.set(streamId, fresh)
    return fresh
  }

  let groupKeyOf = (name: string, mangled: string): string => `${name}\u0000${mangled}`

  const kernelCursor = streamRows<KernelCursorRow>(
    report.db,
    `SELECT start, end, demangledName, shortName, mangledName, streamId, registersPerThread,
            gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory
     FROM CUPTI_ACTIVITY_KIND_KERNEL ORDER BY start`,
  )
  const memcpyCursor = streamRows<MemcpyCursorRow>(
    report.db,
    "SELECT start, end, bytes, copyKind, streamId FROM CUPTI_ACTIVITY_KIND_MEMCPY ORDER BY start",
  )

  interface Activity {
    kind: "kernel" | "memcpy"
    start: number
    end: number
    kernel?: KernelCursorRow
    memcpy?: MemcpyCursorRow
  }

  /** 两路已排序游标按 start 归并（各自走 start 索引，避免 UNION 的全局排序与临时落盘）。 */
  function* merged(): Generator<Activity> {
    let k = kernelCursor.next()
    let m = memcpyCursor.next()
    while (!k.done || !m.done) {
      if (k.done) {
        yield { kind: "memcpy", start: m.value.start, end: m.value.end, memcpy: m.value }
        m = memcpyCursor.next()
      } else if (m.done) {
        yield { kind: "kernel", start: k.value.start, end: k.value.end, kernel: k.value }
        k = kernelCursor.next()
      } else if (k.value.start <= m.value.start) {
        yield { kind: "kernel", start: k.value.start, end: k.value.end, kernel: k.value }
        k = kernelCursor.next()
      } else {
        yield { kind: "memcpy", start: m.value.start, end: m.value.end, memcpy: m.value }
        m = memcpyCursor.next()
      }
    }
  }

  for (const ev of merged()) {
    if (ev.end <= ev.start) continue
    union.add(ev.start, ev.end)
    bins.add(ev.start, ev.end)

    if (ev.kind === "kernel") {
      const row = ev.kernel!
      const durNs = ev.end - ev.start
      const name = sid(names, row.demangledName) || sid(names, row.shortName) || sid(names, row.mangledName) || "(未命名 kernel)"
      const mangled = sid(names, row.mangledName)
      const streamId = row.streamId ?? 0
      const grid: [number, number, number] = [row.gridX ?? 0, row.gridY ?? 0, row.gridZ ?? 0]
      const block: [number, number, number] = [row.blockX ?? 0, row.blockY ?? 0, row.blockZ ?? 0]
      const smemBytes = (row.staticSharedMemory ?? 0) + (row.dynamicSharedMemory ?? 0)
      const registers = row.registersPerThread ?? 0

      kernelInstances++
      kernelTotalNs += durNs
      kernelDurationSampler.add(durNs)

      const key = groupKeyOf(name, mangled)
      let group = groups.get(key)
      if (!group) {
        if (groups.size >= ANALYSIS_LIMITS.maxKernelGroups) {
          overflowGroups++
        } else {
          group = {
            name,
            mangled,
            instances: 0,
            totalNs: 0,
            minNs: Number.POSITIVE_INFINITY,
            maxNs: 0,
            registersPerThread: registers,
            grid,
            block,
            smemBytes,
            streams: new Set<number>(),
            sampler: groups.size < ANALYSIS_LIMITS.samplerGroups ? new ValueSampler(ANALYSIS_LIMITS.samplesPerGroup) : undefined,
          }
          groups.set(key, group)
        }
      }
      if (group) {
        group.instances++
        group.totalNs += durNs
        if (durNs < group.minNs) group.minNs = durNs
        if (durNs > group.maxNs) group.maxNs = durNs
        group.streams.add(streamId)
        group.sampler?.add(durNs)
        if (durNs < smallThreshold) {
          smallKernelInstances++
          smallKernelTotalNs += durNs
          smallKernels.add({ name, instances: group.instances, avgNs: group.totalNs / group.instances, totalNs: group.totalNs })
        }
        const totalThreads = grid[0] * grid[1] * grid[2] * block[0] * block[1] * block[2]
        if (totalThreads > 0 && totalThreads < UNDERSIZED_THREADS) {
          undersized.add({ name, instances: group.instances, totalNs: group.totalNs, grid, block, totalThreads })
        }
        if (registers > HIGH_REGISTERS || smemBytes > HIGH_SMEM) {
          pressured.add({ name, instances: group.instances, totalNs: group.totalNs, registersPerThread: registers, smemBytes, block })
        }
      }

      const st = ensureStream(streamId)
      st.kernelInstances++
      st.kernelTotalNs += durNs
      if (ev.start < st.firstStart) st.firstStart = ev.start
      if (ev.end > st.lastEnd) st.lastEnd = ev.end

      const prev = streamLastEnd.get(streamId)
      if (prev && ev.start > prev.end) {
        launchGaps.add({ from: prev.name, to: name, streamId, gapNs: ev.start - prev.end })
      }
      streamLastEnd.set(streamId, { end: ev.end, name })
    } else {
      const row = ev.memcpy!
      const durNs = ev.end - ev.start
      const streamId = row.streamId ?? 0
      const kind = memcpyKinds.get(row.copyKind ?? 0) ?? `kind#${row.copyKind ?? 0}`
      const bytes = row.bytes ?? 0
      memcpyCount++
      memcpyTotalNs += durNs
      memcpyBytes += bytes
      const agg = memcpyAgg.get(kind) ?? { count: 0, totalNs: 0, bytes: 0 }
      agg.count++
      agg.totalNs += durNs
      agg.bytes += bytes
      memcpyAgg.set(kind, agg)
      memcpySlowest.add({ kind, durNs, bytes, start: ev.start })

      const st = ensureStream(streamId)
      st.memcpyCount++
      st.memcpyBytes += bytes
      if (ev.start < st.firstStart) st.firstStart = ev.start
      if (ev.end > st.lastEnd) st.lastEnd = ev.end
      const prev = streamLastEnd.get(streamId)
      if (prev && ev.start > prev.end) launchGaps.add({ from: prev.name, to: kind, streamId, gapNs: ev.start - prev.end })
      streamLastEnd.set(streamId, { end: ev.end, name: kind })
    }
  }

  const unionResult = union.result()
  const binResult = bins.occupancySeries(ANALYSIS_LIMITS.timelinePoints)

  const kernelStats: KernelStat[] = []
  for (const g of groups.values()) {
    kernelStats.push({
      name: g.name,
      mangled: g.mangled,
      instances: g.instances,
      totalNs: g.totalNs,
      avgNs: g.instances ? g.totalNs / g.instances : 0,
      minNs: Number.isFinite(g.minNs) ? g.minNs : 0,
      maxNs: g.maxNs,
      p50Ns: g.sampler ? g.sampler.quantile(0.5) : g.instances ? g.totalNs / g.instances : 0,
      p50Sampled: g.sampler ? g.sampler.isSampled : true,
      grid: g.grid,
      block: g.block,
      registersPerThread: g.registersPerThread,
      smemBytes: g.smemBytes,
      streams: [...g.streams].sort((a, b) => a - b),
      threadsPerBlock: g.block[0] * g.block[1] * g.block[2],
      gridBlocks: g.grid[0] * g.grid[1] * g.grid[2],
      totalThreads: g.grid[0] * g.grid[1] * g.grid[2] * g.block[0] * g.block[1] * g.block[2],
    })
  }
  kernelStats.sort((a, b) => b.totalNs - a.totalNs)

  const sessionMeta = firstRow<{ utcTime: string }>(report.db, "SELECT utcTime FROM TARGET_INFO_SESSION_START_TIME LIMIT 1")

  const facts: TimelineFacts = {
    sessionStartUtc: sessionMeta?.utcTime ?? "",
    firstActivityNs: unionResult.firstStart,
    lastActivityNs: unionResult.lastEnd,
    windowNs: unionResult.spanNs,
    busyNs: unionResult.busyNs,
    utilization: unionResult.utilization,
    maxConcurrent: unionResult.maxConcurrent,
    gaps: unionResult.gaps.map((g) => ({ ...g, durNs: g.end - g.start })),
    gapsTruncated: unionResult.gapsTruncated,
    gapCount: unionResult.gaps.length,
    gapTotalNs: unionResult.gaps.reduce((s, g) => s + (g.end - g.start), 0),
    timeline: binResult.series,
    timelineSpanNs: unionResult.spanNs,
    kernels: kernelStats.slice(0, ANALYSIS_LIMITS.topRows),
    kernelDistinctGroups: groups.size + overflowGroups,
    kernelInstances,
    kernelTotalNs,
    smallKernelInstances,
    smallKernelTotalNs,
    smallKernelGroups: smallKernels.toArray().slice(0, 10),
    undersizedGroups: undersized.toArray().slice(0, 10),
    pressuredGroups: pressured.toArray().slice(0, 10),
    streams: [...streams.values()]
      .map((s) => ({ ...s, firstStart: Number.isFinite(s.firstStart) ? s.firstStart : 0 }))
      .sort((a, b) => b.kernelTotalNs - a.kernelTotalNs),
    memcpyKinds: [...memcpyAgg.entries()]
      .map(([kind, a]) => ({ kind, ...a, avgBytes: a.count ? a.bytes / a.count : 0 }))
      .sort((a, b) => b.totalNs - a.totalNs),
    memcpyCount,
    memcpyTotalNs,
    memcpyBytes,
    memcpySlowest: memcpySlowest.toArray(),
    launchGaps: launchGaps.toArray(),
    kernelDurationSampler,
  }
  return facts
}

/**
 * 时间线占用序列的刻度信息（序列本身已随单趟扫描产出，此处仅做换算便于渲染）。
 */
export function timelineScale(facts: TimelineFacts): { points: number; spanNs: number } {
  return { points: facts.timeline.length, spanNs: facts.timelineSpanNs }
}

export interface ApiFacts {
  count: number
  totalNs: number
  top: Array<{ name: string; count: number; totalNs: number; maxNs: number }>
  slowest: Array<{ name: string; durNs: number; start: number }>
  /** 阻塞型 API（同步/拷贝/查询）聚合——同步瓶颈判据。 */
  blocking: Array<{ name: string; count: number; totalNs: number; maxNs: number }>
}

const BLOCKING_API_RE = /Synchronize|Memcpy|Query|Event|Malloc|Free|Reset/i

/** CUDA API 聚合（SQL 侧 GROUP BY，结果有界）。 */
export function apiFacts(report: ReportDb, top: number = ANALYSIS_LIMITS.topRows): ApiFacts {
  const cacheKey = factsCacheKeyOf(report, `api:${top}`)
  const cached = getCachedFacts<ApiFacts>(cacheKey)
  if (cached) return cached
  const names = stringIdsMap(report.db)
  const items: Array<{ name: string; count: number; totalNs: number; maxNs: number }> = []
  for (const r of streamRows<{ nameId: number; count: number; totalNs: number; maxNs: number }>(
    report.db,
    `SELECT nameId, COUNT(*) AS count, SUM(end - start) AS totalNs, MAX(end - start) AS maxNs
     FROM CUPTI_ACTIVITY_KIND_RUNTIME GROUP BY nameId ORDER BY totalNs DESC LIMIT ?`,
    top,
  )) {
    items.push({ name: sid(names, r.nameId) || "(未知 API)", count: r.count, totalNs: r.totalNs, maxNs: r.maxNs })
  }
  const slowest: ApiFacts["slowest"] = []
  for (const r of streamRows<{ nameId: number; durNs: number; start: number }>(
    report.db,
    `SELECT nameId, (end - start) AS durNs, start FROM CUPTI_ACTIVITY_KIND_RUNTIME ORDER BY durNs DESC LIMIT ?`,
    top,
  )) {
    slowest.push({ name: sid(names, r.nameId) || "(未知 API)", durNs: r.durNs, start: r.start })
  }
  const facts: ApiFacts = {
    count: scalar(report.db, "SELECT COUNT(*) FROM CUPTI_ACTIVITY_KIND_RUNTIME"),
    totalNs: scalar(report.db, "SELECT SUM(end - start) FROM CUPTI_ACTIVITY_KIND_RUNTIME"),
    top: items,
    slowest,
    blocking: items.filter((i) => BLOCKING_API_RE.test(i.name)).slice(0, 12),
  }
  setCachedFacts(cacheKey, facts)
  return facts
}

export interface SyncFacts {
  count: number
  totalNs: number
  byKind: Array<{ kind: string; count: number; totalNs: number }>
  longest: Array<{ kind: string; durNs: number; start: number }>
}

export function syncFacts(report: ReportDb, top: number = ANALYSIS_LIMITS.topRows): SyncFacts {
  const cacheKey = factsCacheKeyOf(report, `sync:${top}`)
  const cached = getCachedFacts<SyncFacts>(cacheKey)
  if (cached) return cached
  const kinds = enumMap(report.db, "ENUM_CUPTI_SYNC_TYPE")
  const byKind: SyncFacts["byKind"] = []
  for (const r of streamRows<{ syncType: number; count: number; totalNs: number }>(
    report.db,
    `SELECT syncType, COUNT(*) AS count, SUM(end - start) AS totalNs
     FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION GROUP BY syncType ORDER BY totalNs DESC`,
  )) {
    byKind.push({ kind: kinds.get(r.syncType) ?? `type#${r.syncType}`, count: r.count, totalNs: r.totalNs })
  }
  const longest: SyncFacts["longest"] = []
  for (const r of streamRows<{ syncType: number; durNs: number; start: number }>(
    report.db,
    `SELECT syncType, (end - start) AS durNs, start FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION ORDER BY durNs DESC LIMIT ?`,
    top,
  )) {
    longest.push({ kind: kinds.get(r.syncType) ?? `type#${r.syncType}`, durNs: r.durNs, start: r.start })
  }
  const facts: SyncFacts = {
    count: scalar(report.db, "SELECT COUNT(*) FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION"),
    totalNs: scalar(report.db, "SELECT SUM(end - start) FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION"),
    byKind,
    longest,
  }
  setCachedFacts(cacheKey, facts)
  return facts
}

export interface NvtxFacts {
  available: boolean
  count: number
  /** 按名聚合的区间耗时（SQL GROUP BY，容量有界）。 */
  top: Array<{ text: string; count: number; totalNs: number }>
}

export function nvtxFacts(report: ReportDb, top: number = ANALYSIS_LIMITS.topRows): NvtxFacts {
  const cacheKey = factsCacheKeyOf(report, `nvtx:${top}`)
  const cached = getCachedFacts<NvtxFacts>(cacheKey)
  if (cached) return cached
  const top_rows: NvtxFacts["top"] = []
  let available = true
  try {
    // 区间名有两种存储形态：StringIds 表的 textId，或 NVTX_EVENTS.text 文本列（torch 等运行时走后者）
    for (const r of streamRows<{ name: string | null; count: number; totalNs: number }>(
      report.db,
      `SELECT COALESCE(s.value, e.text) AS name, COUNT(*) AS count, SUM(e.end - e.start) AS totalNs
       FROM NVTX_EVENTS e LEFT JOIN StringIds s ON s.id = e.textId
       WHERE e.end IS NOT NULL
       GROUP BY COALESCE(s.value, e.text) ORDER BY totalNs DESC LIMIT ?`,
      top,
    )) {
      top_rows.push({ text: r.name || "(未命名区间)", count: r.count, totalNs: r.totalNs })
    }
  } catch {
    available = false
  }
  const facts: NvtxFacts = {
    available,
    count: available ? scalar(report.db, "SELECT COUNT(*) FROM NVTX_EVENTS WHERE end IS NOT NULL") : 0,
    top: top_rows,
  }
  setCachedFacts(cacheKey, facts)
  return facts
}

/** 设备信息（TARGET_INFO_CUDA_DEVICE + TARGET_INFO_GPU）。 */
export interface DeviceFacts {
  devices: Array<{ gpuId: number; cudaId: number; pid: number; name?: string; computeCap?: string }>
}

export function deviceFacts(report: ReportDb): DeviceFacts {
  const cacheKey = factsCacheKeyOf(report, "devices")
  const cached = getCachedFacts<DeviceFacts>(cacheKey)
  if (cached) return cached
  // 列集逐版本有差异（如旧版无 computeCapability）：先探测列名再构建查询
  const gpuCols = tableColumns(report.db, "TARGET_INFO_GPU")
  const capCol = gpuCols.includes("computeCapability") ? "computeCapability" : gpuCols.includes("computeCap") ? "computeCap" : "NULL"
  const nameCol = gpuCols.includes("name") ? "name" : "NULL"
  const gpus = tryAll<{ id: number; name: string | null; computeCapability: string | null }>(
    report.db,
    `SELECT id, ${nameCol} AS name, ${capCol} AS computeCapability FROM TARGET_INFO_GPU`,
  ) ?? []
  const devices: DeviceFacts["devices"] = []
  for (const r of streamRows<{ gpuId: number; cudaId: number; pid: number }>(report.db, "SELECT gpuId, cudaId, pid FROM TARGET_INFO_CUDA_DEVICE")) {
    const gpu = gpus.find((g) => g.id === r.gpuId)
    devices.push({ gpuId: r.gpuId, cudaId: r.cudaId, pid: r.pid, name: gpu?.name ?? undefined, computeCap: gpu?.computeCapability ?? undefined })
  }
  const facts: DeviceFacts = { devices }
  setCachedFacts(cacheKey, facts)
  return facts
}

/**
 * 空闲缝的邻接活动（Top-K 空闲缝各自的「前序/后续活动」）：用索引定位边界，每次查询 O(log n)。
 * 只在需要渲染少量空闲缝时调用——不为全量空闲缝做归因。
 */
export function gapNeighbours(
  report: ReportDb,
  gaps: Array<{ start: number; end: number }>,
): Array<{ before?: string; after?: string; beforeStream?: number; afterStream?: number }> {
  const names = stringIdsMap(report.db)
  return gaps.map((g) => {
    const before = firstRow<{ demangledName: number | null; mangledName: number | null; streamId: number | null }>(
      report.db,
      "SELECT demangledName, mangledName, streamId FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE end <= ? ORDER BY end DESC LIMIT 1",
      g.start,
    )
    const after = firstRow<{ demangledName: number | null; mangledName: number | null; streamId: number | null }>(
      report.db,
      "SELECT demangledName, mangledName, streamId FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE start >= ? ORDER BY start ASC LIMIT 1",
      g.end,
    )
    return {
      before: before ? sid(names, before.demangledName) || sid(names, before.mangledName) : undefined,
      after: after ? sid(names, after.demangledName) || sid(names, after.mangledName) : undefined,
      beforeStream: before?.streamId ?? undefined,
      afterStream: after?.streamId ?? undefined,
    }
  })
}

/** 报告规模概览（超大报告的规模提示：行数与事件表规模）。 */
export function reportScale(report: ReportDb): { kernels: number; memcpys: number; apis: number; syncs: number; totalEvents: number } {
  const cacheKey = factsCacheKeyOf(report, "scale")
  const cached = getCachedFacts<{ kernels: number; memcpys: number; apis: number; syncs: number; totalEvents: number }>(cacheKey)
  if (cached) return cached
  const facts = {
    kernels: scalar(report.db, "SELECT COUNT(*) FROM CUPTI_ACTIVITY_KIND_KERNEL"),
    memcpys: scalar(report.db, "SELECT COUNT(*) FROM CUPTI_ACTIVITY_KIND_MEMCPY"),
    apis: scalar(report.db, "SELECT COUNT(*) FROM CUPTI_ACTIVITY_KIND_RUNTIME"),
    syncs: scalar(report.db, "SELECT COUNT(*) FROM CUPTI_ACTIVITY_KIND_SYNCHRONIZATION"),
    totalEvents: 0,
  }
  facts.totalEvents = facts.kernels + facts.memcpys + facts.apis + facts.syncs
  setCachedFacts(cacheKey, facts)
  return facts
}

/** 便于渲染：内核统计的紧凑单行文本。 */
export function kernelRowText(k: KernelStat): string {
  return `${k.name} × ${formatInt(k.instances)} 合计 ${formatNs(k.totalNs)}（均 ${formatNs(k.avgNs)}）`
}
