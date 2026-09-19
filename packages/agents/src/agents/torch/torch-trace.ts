/**
 * PyTorch Profiler（Kineto / Chrome Trace）trace 分析引擎。
 *
 * 格式要点（依真实 trace 核实，非文档推测）：
 * - 顶层 `{"traceEvents":[...], "schemaVersion":1, "profile_memory":1, "with_stack":1, ...}`，
 *   `ts`/`dur` 单位为**微秒**且 `ts` 是绝对纪元时间；
 * - 事件类别（`cat`）：`cpu_op`（算子）、`python_function`（Python 帧，名称内嵌 `文件(行): 函数`）、
 *   `user_annotation`（record_function/ProfilerStep/NVTX）、`kernel`（GPU 内核）、`cuda_runtime`（CUDA API）、
 *   `gpu_memcpy`/`gpu_memset`（显存传输）、`cpu_instant_event`（含 `[memory]` 分配器事件）；
 * - 内存事件是**瞬时事件**（`ph:"i"`，无 `dur`），`args` 携带 `Bytes`（负数为释放）、`Addr`、
 *   `Total Allocated`、`Total Reserved`、`Device Id`；
 * - 关联通道：`Ph:"s"/"f"` 流事件（`id` 连接 CPU 算子与 GPU 内核）、`cuda_runtime` 与 `kernel` 的
 *   `correlation` 字段；
 * - **平台差异**：Windows 上 PyTorch 的 CUPTI GPU 采集不可用（实测启用 `ProfilerActivity.CUDA`
 *   仍无任何 kernel 事件）——此时 trace 只含 CPU/内存事件，GPU 侧时间线应改用 Nsight Systems。
 *
 * 性能取向：单趟流式扫描（`scanJsonArrayItems` 逐元素切片后解析，内存与文件规模解耦）、
 * 聚合器容量恒定（Top-K/受控采样/每分组样本上限）、同类事件按线程栈计算自身耗时（减法而非建树）。
 */
import { AdaptiveBins, IntervalUnionStreamer, TopK, ValueSampler, intersectionTotals, mergedFromGaps } from "../../core/perf/agg"
import { scanJsonArrayItems, textChunks, type JsonArrayScanStats } from "./jsonstream"
import { argNumber, argRaw, normalizeShapeList, normalizeTypeList, parseEventFast } from "./torch-events"

// ---------------------------------------------------------------- 常量

/** 聚合上限（结果有界：输出规模不随 trace 规模增长）。 */
export const TORCH_LIMITS = {
  /** 参与排行的分组上限（超出计入溢出，避免极端 trace 撑爆内存）。 */
  maxGroups: 20_000,
  /** 排行条数。 */
  topRows: 20,
  /** 每分组的耗时采样容量（分位数用）。 */
  samplesPerGroup: 64,
  /** 分配采样器的分组上限。 */
  samplerGroups: 2_000,
  /** 每分组保留的形状/类型样本条数。 */
  shapeSamples: 3,
  /** python 位置热点条数。 */
  pythonHotspots: 40,
  /** 时间线分桶数（自适应分辨率）+ 输出点数。 */
  timelineBins: 1_000,
  timelinePoints: 240,
  /** 空闲缝保留上限。 */
  maxGaps: 20_000,
  /** 内存地址追踪上限（超出即只保留累计值，不再逐地址追踪活跃集）。 */
  maxTrackedAddrs: 200_000,
  /** 流事件 id → 名称 映射上限。 */
  maxFlows: 100_000,
} as const

/** 每微秒的纳秒数：torch trace 的时间单位是微秒，时间线组件按纳秒语义工作，边界换算用。 */
const NS_PER_US = 1_000

/** 视为「小内核」的耗时上限（微秒；与 nsys 侧口径一致：10 µs）。 */
export const SMALL_KERNEL_US = 10
/** 视为「微小算子」的自身耗时上限（微秒）：CPU 侧算子碎片化判据。 */
export const TINY_OP_US = 5
/** GPU 内核总数低于此值不判定「启动开销受限」（避免小 trace 误报）。 */
export const MIN_KERNELS_FOR_LAUNCH_BOUND = 100

// ---------------------------------------------------------------- 事实结构

export interface TorchOpStat {
  cat: string
  name: string
  count: number
  /** 含子事件的总耗时（微秒）。 */
  totalUs: number
  /** 减去同类子事件后的自身耗时（微秒）。 */
  selfUs: number
  minUs: number
  maxUs: number
  p50Us: number
  p50Sampled: boolean
  /** GPU 内核专属：设备/流。 */
  devices: number[]
  streams: number[]
  /** 张量形状与类型样本（来自 `Input Dims` / `Input type`，仅 cpu_op）。 */
  shapeSamples: string[]
  dtypeSamples: string[]
  /** GPU 内核专属几何。 */
  grid?: [number, number, number]
  block?: [number, number, number]
  registers?: number
  occupancy?: number
  sharedMemory?: number
}

export interface TorchStep {
  name: string
  durUs: number
  tsUs: number
}

export interface TorchMemoryFacts {
  /** 是否有分配器事件（`profile_memory=True` 才有）。 */
  available: boolean
  events: number
  allocCount: number
  freeCount: number
  allocatedBytes: number
  freedBytes: number
  /** 峰值已分配字节（优先取 `Total Allocated` 最大值；缺失时用活跃集推算）。 */
  peakAllocatedBytes: number
  peakReservedBytes: number
  /** 峰值来源：`trace`=trace 自带的累计字段，`live-set`=按地址推算。 */
  peakSource: "trace" | "live-set" | "none"
  /** 碎片化比率（峰值保留/峰值分配）。 */
  fragmentation: number
  /** 最大的单次分配。 */
  largestAllocs: Array<{ bytes: number; addr: number; deviceId: number; tsUs: number }>
  byDevice: Array<{ deviceId: number; allocCount: number; bytes: number; peakBytes: number }>
  /** 地址追踪是否因上限而降级。 */
  addrTrackingTruncated: boolean
}

export interface TorchCategoryStat {
  cat: string
  count: number
  totalUs: number
  selfUs: number
}

export interface TorchTimelineFacts {
  spanUs: number
  firstTsUs: number
  lastTsUs: number
  /** CPU 侧忙碌（所有 CPU 事件的区间并集）。 */
  cpuBusyUs: number
  cpuUtilization: number
  /** GPU 侧忙碌（内核 + 显存传输的区间并集）。 */
  gpuBusyUs: number
  gpuUtilization: number
  /** GPU 空闲缝（含累计；cpuBusyUs 为该缝内 CPU 仍在忙的时长）。 */
  gpuGapCount: number
  gpuGapTotalUs: number
  gpuGaps: Array<{ startUs: number; endUs: number; durUs: number; cpuBusyUs: number }>
  gpuMaxConcurrent: number
  /** GPU 忙碌区间与 CPU 忙碌区间的重叠时长（判断是否 CPU 受限）。 */
  overlapUs: number
  /** 时间线占用序列（CPU / GPU），各 timelinePoints 点。 */
  cpuSeries: number[]
  gpuSeries: number[]
}

export interface TorchPythonSite {
  /** 位置串（`文件(行): 函数` 解析所得）。 */
  location: string
  file: string
  line: number
  func: string
  count: number
  selfUs: number
  totalUs: number
}

export interface TorchFacts {
  /** 报告路径（缓存指纹与展示用）。 */
  source: string
  scanMs: number
  scale: {
    events: number
    scannedChars: number
    byCategory: Record<string, number>
    processes: number[]
    threads: number
    /** trace 顶层声明的采集开关（判断能力边界：如 profile_memory/with_stack）。 */
    flags: Record<string, unknown>
  }
  hasGpuEvents: boolean
  hasMemoryEvents: boolean
  steps: TorchStep[]
  stepStats: { count: number; avgUs: number; medianUs: number; p90Us: number; minUs: number; maxUs: number }
  categories: TorchCategoryStat[]
  /** 算子（cpu_op）排行（按自身耗时降序）。 */
  ops: TorchOpStat[]
  /** 内核（kernel）排行（按总耗时降序）。 */
  kernels: TorchOpStat[]
  /** CUDA API（cuda_runtime）排行。 */
  cudaApis: TorchOpStat[]
  /** 用户标注（user_annotation，不含 ProfilerStep）。 */
  annotations: TorchOpStat[]
  opGroups: number
  kernelGroups: number
  /** 显存传输聚合（按方向）。 */
  transfers: Array<{ kind: string; count: number; bytes: number; totalUs: number; avgBytes: number }>
  transferCount: number
  transferBytes: number
  memory: TorchMemoryFacts
  timeline: TorchTimelineFacts
  pythonSites: TorchPythonSite[]
  /** 内核 → 发起它的 CPU 算子（经 correlation / 流事件关联；无 GPU 事件时为空）。 */
  kernelAttribution: Array<{ kernel: string; op: string; count: number; kernelUs: number }>
  /** 未采集维度的说明（供工具如实呈现）。 */
  notes: string[]
}

// ---------------------------------------------------------------- 事件解析

interface RawEvent {
  /** args 对象的原始 JSON 切片（快速提取器产出；JSON.parse 兜底时无此字段）。 */
  argsText?: string
  ph?: string
  cat?: string
  name?: string
  pid?: number | string
  tid?: number | string
  ts?: number
  dur?: number
  id?: number
  args?: Record<string, unknown>
}

/** 解析 python_function 名称中的 `文件(行): 函数`（kineto 的 with_stack 形态）。 */
export function parsePythonSite(name: string): { file: string; line: number; func: string } | null {
  const m = /^(.+?)\((\d+)\):\s*(.*)$/.exec(name)
  if (!m) return null
  const line = Number(m[2])
  if (!Number.isFinite(line)) return null
  return { file: m[1]!, line, func: m[3]! || "(匿名)" }
}

/** 三分量几何解析（`grid`/`block` 的原始 JSON 数组文本，如 `[128,1,1]`）。 */
export function parseTripleText(raw: string | undefined): [number, number, number] | undefined {
  if (!raw) return undefined
  const nums = raw.match(/-?\d+(?:\.\d+)?/g)
  if (!nums || !nums.length) return undefined
  return [Number(nums[0]) || 0, Number(nums[1] ?? 1) || 1, Number(nums[2] ?? 1) || 1]
}

/** 传输方向（kineto 的 gpu_memcpy 名称形如 `Memcpy HtoD (Pageable -> Device)`）。 */
export function transferKind(name: string): string {
  const m = /\b(HtoD|DtoH|DtoD|HtoH|PtoP)\b/.exec(name)
  if (m) return m[1]!
  if (/Memset/i.test(name)) return "Memset"
  return name.split(" ")[0] ?? name
}

/**
 * 读取 trace 顶层采集开关（`profile_memory` / `with_stack` / `record_shapes` / `with_modules` / `schemaVersion`）。
 * 这些字段在 `traceEvents` 数组**之外**，流式扫描器不可见——单独从文件头部提取（有界读取，避免为读元数据扫全文）；
 * gzip 变体先解压再匹配（TensorBoard trace handler 的默认产物即 gzip，直接读原始字节能拿到压缩流）。
 */
export async function readTraceFlags(path: string): Promise<Record<string, unknown>> {
  const flags: Record<string, unknown> = {}
  let head = ""
  try {
    if (/\.gz$/i.test(path)) {
      let acc = ""
      for await (const chunk of textChunks(path)) {
        acc += chunk
        if (acc.length >= 8_192) break
      }
      head = acc.slice(0, 8_192)
    } else {
      head = await Bun.file(path).slice(0, 8_192).text()
    }
  } catch {
    return flags
  }
  const re = /"(schemaVersion|profile_memory|with_stack|record_shapes|with_modules|traceName)"\s*:\s*("[^"]*"|true|false|-?\d+(?:\.\d+)?)/g
  for (const m of head.matchAll(re)) {
    const key = m[1]!
    const raw = m[2]!
    flags[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw === "true" ? true : raw === "false" ? false : Number(raw)
  }
  return flags
}


// ---------------------------------------------------------------- 主聚合

export interface TorchAggregateOptions {
  /** 中断信号。 */
  signal?: AbortSignal
  /** 扫描进度回调（每 N 个事件一次，供长任务回报进度）。 */
  onProgress?: (stats: JsonArrayScanStats) => void
}

/**
 * 单趟流式聚合 PyTorch Profiler trace。
 * 内存与文件规模解耦：只保留固定容量的聚合器与浅栈（自身耗时计算用）。
 */
export async function aggregateTorchTrace(path: string, opts: TorchAggregateOptions = {}): Promise<TorchFacts> {
  const t0 = performance.now()
  // trace 顶层开关在 traceEvents 数组之外（扫描器不可见）——从文件头部提取（有界读取）
  const flags = await readTraceFlags(path)
  type GroupAcc = {
    cat: string
    name: string
    count: number
    totalUs: number
    childUs: number
    selfUs: number
    minUs: number
    maxUs: number
    devices: Set<number>
    streams: Set<number>
    shapes: string[]
    dtypes: string[]
    grid?: [number, number, number]
    block?: [number, number, number]
    registers?: number
    occupancy?: number
    sharedMemory?: number
    sampler?: ValueSampler
  }
  // 两级分组表（类别 → 名称）：避免每事件拼接 "cat\u0000name" 字符串（千万级事件下这是主成本之一）
  const groups = new Map<string, Map<string, GroupAcc>>()
  let groupCount = 0
  let overflowGroups = 0

  const ensureGroup = (cat: string, name: string, sample: boolean): GroupAcc | undefined => {
    let byName = groups.get(cat)
    if (!byName) {
      byName = new Map<string, GroupAcc>()
      groups.set(cat, byName)
    }
    let g = byName.get(name)
    if (g) return g
    if (groupCount >= TORCH_LIMITS.maxGroups) {
      overflowGroups++
      return undefined
    }
    g = {
      cat,
      name,
      count: 0,
      totalUs: 0,
      childUs: 0,
      selfUs: 0,
      minUs: Number.POSITIVE_INFINITY,
      maxUs: 0,
      devices: new Set(),
      streams: new Set(),
      shapes: [],
      dtypes: [],
      sampler: groupCount < TORCH_LIMITS.samplerGroups && sample ? new ValueSampler(TORCH_LIMITS.samplesPerGroup) : undefined,
    }
    byName.set(name, g)
    groupCount++
    return g
  }

  // 自身耗时：按「类别 + 进程 + 线程」维护浅栈（同类嵌套做减法，跨类嵌套不做——跨类归属无统一定义）
  interface Frame {
    name: string
    start: number
    end: number
    childUs: number
  }
  const stacks = new Map<string, Frame[]>()
  const closeFrame = (cat: string, frame: Frame): void => {
    const g = groups.get(cat)?.get(frame.name)
    if (!g) return
    g.childUs += frame.childUs
    g.selfUs += Math.max(0, frame.end - frame.start - frame.childUs)
  }
  const stackKey = (cat: string, pid: number | string, tid: number | string): string => `${cat}|${pid}|${tid}`

  // 类别统计与规模
  const byCategory = new Map<string, number>()
  const categoryTime = new Map<string, { count: number; totalUs: number; selfUs: number }>()
  const processes = new Set<string>()
  const threads = new Set<string>()
  let events = 0
  let scannedChars = 0

  // 步骤
  const steps: TorchStep[] = []
  const stepDurations = new ValueSampler(4_096)

  // 时间线：CPU / GPU 两路并集 + 分桶
  const cpuUnion = new IntervalUnionStreamer(50_000)
  const gpuUnion = new IntervalUnionStreamer(50_000)
  const cpuBins = new AdaptiveBins(TORCH_LIMITS.timelineBins)
  const gpuBins = new AdaptiveBins(TORCH_LIMITS.timelineBins)

  // GPU 传输与内存
  const transferAgg = new Map<string, { count: number; bytes: number; totalUs: number }>()
  let transferCount = 0
  let transferBytes = 0
  const memory = {
    events: 0,
    allocCount: 0,
    freeCount: 0,
    allocatedBytes: 0,
    freedBytes: 0,
    peakAllocated: 0,
    peakReserved: 0,
    sawTraceTotals: false,
    live: new Map<number, number>(),
    liveBytes: 0,
    peakLiveBytes: 0,
    byDevice: new Map<number, { allocCount: number; bytes: number; peakBytes: number; liveBytes: number }>(),
    largest: new TopK<{ bytes: number; addr: number; deviceId: number; tsUs: number }>(TORCH_LIMITS.topRows, (v) => `${v.addr}:${v.tsUs}`, (v) => v.bytes),
    addrTruncated: false,
  }

  // python 位置热点
  const pythonSites = new Map<string, TorchPythonSite>()

  // GPU 事件汇总（判断 GPU 侧是否存在，用于能力边界提示）
  let kernelEvents = 0
  let gpuTransferEvents = 0

  // correlation → CPU 算子（GPU 归属）
  const correlationToOp = new Map<number, string>()
  const kernelAttribution = new Map<string, { kernel: string; op: string; count: number; kernelUs: number }>()

  // 扫描按批产出（批内元素逐个处理）；事件主体在下面的 for 循环内
  let scanned = 0
  let lastStats: JsonArrayScanStats | undefined
  for await (const batch of scanJsonArrayItems(path, { signal: opts.signal })) {
    lastStats = batch.stats
    if (opts.onProgress) opts.onProgress(batch.stats)
    for (const text of batch.texts) {
      scanned++
    if (text[0] !== "{") {
      // 顶层标量/字符串元素（罕见）——只计入规模
      events++
      continue
    }
    // 字段级提取（不构造对象）；形态不符时回退 JSON.parse，单元素解析失败只跳过该事件
    let ev: RawEvent | null = parseEventFast(text) as RawEvent | null
    if (!ev) {
      try {
        ev = JSON.parse(text) as RawEvent
      } catch {
        events++
        continue
      }
    }
    events++
    const ph = ev.ph ?? ""
    const cat = typeof ev.cat === "string" ? ev.cat : ""
    byCategory.set(cat || "(无类别)", (byCategory.get(cat || "(无类别)") ?? 0) + 1)

    if (ph === "M") {
      // 元数据：进程/线程名与顶层开关（flags 由首个非事件字段给出）
      if (ev.pid !== undefined) processes.add(String(ev.pid))
      if (ev.tid !== undefined) threads.add(String(ev.pid) + ":" + String(ev.tid))
      continue
    }
    const name = typeof ev.name === "string" ? ev.name : ""
    const ts = typeof ev.ts === "number" ? ev.ts : NaN

    if (ph === "i") {
      // 瞬时事件：内存分配器事件即在此形态（`[memory]`）
      const memoryArgs = ev.argsText
      if (name === "[memory]" || cat === "memory" || argNumber(memoryArgs, "Bytes") !== undefined) {
        const bytes = argNumber(memoryArgs, "Bytes") ?? 0
        const addr = argNumber(memoryArgs, "Addr") ?? 0
        const deviceId = argNumber(memoryArgs, "Device Id") ?? 0
        memory.events++
        if (bytes >= 0) {
          memory.allocCount++
          memory.allocatedBytes += bytes
        } else {
          memory.freeCount++
          memory.freedBytes += -bytes
        }
        const totalAllocated = argNumber(memoryArgs, "Total Allocated")
        const totalReserved = argNumber(memoryArgs, "Total Reserved")
        if (totalAllocated !== undefined) {
          memory.sawTraceTotals = true
          if (totalAllocated > memory.peakAllocated) memory.peakAllocated = totalAllocated
        }
        if (totalReserved !== undefined && totalReserved > memory.peakReserved) memory.peakReserved = totalReserved
        // 活跃集（按地址）：追踪上限内维护，超出即降级
        if (!memory.addrTruncated) {
          if (memory.live.has(addr)) {
            memory.liveBytes -= memory.live.get(addr)!
            memory.live.delete(addr)
          }
          if (bytes > 0) {
            if (memory.live.size >= TORCH_LIMITS.maxTrackedAddrs) {
              memory.addrTruncated = true
              memory.live.clear()
            } else {
              memory.live.set(addr, bytes)
              memory.liveBytes += bytes
            }
          }
          if (memory.liveBytes > memory.peakLiveBytes) memory.peakLiveBytes = memory.liveBytes
        }
        const dev = memory.byDevice.get(deviceId) ?? { allocCount: 0, bytes: 0, peakBytes: 0, liveBytes: 0 }
        if (bytes > 0) {
          dev.allocCount++
          dev.bytes += bytes
          dev.liveBytes += bytes
          dev.peakBytes = Math.max(dev.peakBytes, dev.liveBytes)
          memory.largest.add({ bytes, addr, deviceId, tsUs: ts })
        } else {
          dev.liveBytes = Math.max(0, dev.liveBytes + bytes)
        }
        memory.byDevice.set(deviceId, dev)
      }
      continue
    }

    if (ph === "s" || ph === "f") {
      // 流事件：仅在用于关联时读取（此处只计入类别规模；关联由 correlation 完成）
      continue
    }

    if (ph !== "X") continue
    const dur = typeof ev.dur === "number" ? ev.dur : 0
    if (!Number.isFinite(ts) || dur < 0) continue
    const pid = ev.pid ?? 0
    const tid = ev.tid ?? 0
    processes.add(String(pid))
    threads.add(`${pid}:${tid}`)

    // 类别时间线与分类统计
    const isGpuSide = cat === "kernel" || cat === "gpu_memcpy" || cat === "gpu_memset"
    const ct = categoryTime.get(cat) ?? { count: 0, totalUs: 0, selfUs: 0 }
    ct.count++
    ct.totalUs += dur
    categoryTime.set(cat, ct)

    const interval = { start: ts, end: ts + dur }
    // 时间线组件（并集/分桶）按**纳秒**语义设计（与 nsys 事件库同口径，含 50 µs 空闲缝阈值），
    // 而 torch trace 的 ts/dur 是微秒——入参处统一换算，出参再换算回微秒。
    if (isGpuSide) {
      gpuUnion.add(interval.start * NS_PER_US, interval.end * NS_PER_US)
      gpuBins.add(interval.start * NS_PER_US, interval.end * NS_PER_US)
      if (cat === "kernel") kernelEvents++
      else gpuTransferEvents++
    } else {
      cpuUnion.add(interval.start * NS_PER_US, interval.end * NS_PER_US)
      cpuBins.add(interval.start * NS_PER_US, interval.end * NS_PER_US)
    }

    // 步骤标注
    if (cat === "user_annotation" && /^ProfilerStep#?\d*$/.test(name)) {
      steps.push({ name, durUs: dur, tsUs: ts })
      stepDurations.add(dur)
      continue
    }

    // 分组聚合（各 cat 的排行都用同一份分组表）
    const tracked =
      cat === "cpu_op" || cat === "kernel" || cat === "cuda_runtime" || cat === "user_annotation" || cat === "python_function" || cat === "gpu_memcpy" || cat === "gpu_memset"
    if (!tracked) continue

    const g = ensureGroup(cat, name, true)
    if (g) {
      g.count++
      g.totalUs += dur
      if (dur < g.minUs) g.minUs = dur
      if (dur > g.maxUs) g.maxUs = dur
      g.sampler?.add(dur)
      const argsText = ev.argsText
      if (cat === "cpu_op") {
        if (g.shapes.length < TORCH_LIMITS.shapeSamples) {
          const dims = argRaw(argsText, "Input Dims")
          if (dims) g.shapes.push(normalizeShapeList(dims))
        }
        if (g.dtypes.length < TORCH_LIMITS.shapeSamples) {
          const types = argRaw(argsText, "Input type")
          if (types) g.dtypes.push(normalizeTypeList(types))
        }
      } else if (cat === "kernel" || cat === "gpu_memcpy" || cat === "gpu_memset") {
        const dev = argNumber(argsText, "device")
        const stream = argNumber(argsText, "stream")
        if (dev !== undefined) g.devices.add(dev)
        if (stream !== undefined) g.streams.add(stream)
        if (cat === "kernel" && !g.grid) {
          g.grid = parseTripleText(argRaw(argsText, "grid"))
          g.block = parseTripleText(argRaw(argsText, "block"))
          g.registers = argNumber(argsText, "registers per thread")
          g.occupancy = argNumber(argsText, "est. achieved occupancy %")
          g.sharedMemory = argNumber(argsText, "shared memory")
        }
        const corr = argNumber(argsText, "correlation")
        if (cat === "kernel" && corr !== undefined) {
          const op = correlationToOp.get(corr)
          if (op) {
            const key = `${name}\u0000${op}`
            const acc = kernelAttribution.get(key) ?? { kernel: name, op, count: 0, kernelUs: 0 }
            acc.count++
            acc.kernelUs += dur
            kernelAttribution.set(key, acc)
          }
        }
      } else if (cat === "cuda_runtime") {
        const corr = argNumber(argsText, "correlation")
        if (corr !== undefined && correlationToOp.size < TORCH_LIMITS.maxFlows) correlationToOp.set(corr, name)
      }

      // 自身耗时：同类嵌套做减法（父帧记入子事件时长，关闭时自身 = 总时长 − 子事件时长）
      const key = stackKey(cat, pid, tid)
      const stack = stacks.get(key) ?? []
      while (stack.length && stack[stack.length - 1]!.end <= ts) closeFrame(cat, stack.pop()!)
      if (stack.length) {
        const top = stack[stack.length - 1]!
        if (ts >= top.start && ts + dur <= top.end) top.childUs += dur
        else {
          // 与栈顶不成包含关系（乱序/跨线程交叠）：清栈，避免错误归属
          while (stack.length) closeFrame(cat, stack.pop()!)
        }
      }
      stack.push({ name, start: ts, end: ts + dur, childUs: 0 })
      stacks.set(key, stack)
    }

    // 传输聚合
    if (cat === "gpu_memcpy" || cat === "gpu_memset") {
      const kind = transferKind(name)
      const bytes = argNumber(ev.argsText, "bytes") ?? 0
      const agg = transferAgg.get(kind) ?? { count: 0, bytes: 0, totalUs: 0 }
      agg.count++
      agg.bytes += bytes
      agg.totalUs += dur
      transferAgg.set(kind, agg)
      transferCount++
      transferBytes += bytes
    }

    // python 位置
    if (cat === "python_function") {
      const site = parsePythonSite(name)
      if (site) {
        const key = `${site.file}:${site.line}`
        const cur = pythonSites.get(key) ?? { location: `${site.file}:${site.line}`, file: site.file, line: site.line, func: site.func, count: 0, selfUs: 0, totalUs: 0 }
        cur.count++
        cur.totalUs += dur
        pythonSites.set(key, cur)
      }
    }
    }
  }

  // 收尾：关闭所有未闭合帧（trace 结束时仍在栈内的）
  for (const [key, stack] of stacks) {
    const cat = key.split("\u0000")[0]!
    while (stack.length) closeFrame(cat, stack.pop()!)
  }

  const stats = lastStats
  scannedChars = stats?.scannedChars ?? 0

  // 自身耗时回填到类别统计
  for (const [cat, ct] of categoryTime) {
    let selfUs = 0
    const byName = groups.get(cat)
    if (byName) for (const g of byName.values()) selfUs += g.selfUs
    ct.selfUs = selfUs
    // python_function 的自身耗时也回填到位置热点
    if (cat === "python_function" && byName) {
      for (const g of byName.values()) {
        const site = parsePythonSite(g.name)
        if (!site) continue
        const cur = pythonSites.get(`${site.file}:${site.line}`)
        if (cur) cur.selfUs += g.selfUs
      }
    }
  }

  const toStat = (g: GroupAcc): TorchOpStat => ({
    cat: g.cat,
    name: g.name,
    count: g.count,
    totalUs: g.totalUs,
    selfUs: g.selfUs,
    minUs: Number.isFinite(g.minUs) ? g.minUs : 0,
    maxUs: g.maxUs,
    p50Us: g.sampler ? g.sampler.quantile(0.5) : g.count ? g.totalUs / g.count : 0,
    p50Sampled: g.sampler ? g.sampler.isSampled : true,
    devices: [...g.devices].sort((a, b) => a - b),
    streams: [...g.streams].sort((a, b) => a - b),
    shapeSamples: g.shapes,
    dtypeSamples: g.dtypes,
    grid: g.grid,
    block: g.block,
    registers: g.registers,
    occupancy: g.occupancy,
    sharedMemory: g.sharedMemory,
  })

  const byCat = (cat: string): TorchOpStat[] =>
    [...(groups.get(cat)?.values() ?? [])]
      .map(toStat)
      .sort((a, b) => (cat === "kernel" || cat === "gpu_memcpy" || cat === "gpu_memset" ? b.totalUs - a.totalUs : b.selfUs - a.selfUs))
      .slice(0, TORCH_LIMITS.topRows)

  const cpuResult = cpuUnion.result()
  const gpuResult = gpuUnion.result()
  // 时间窗口由 X 事件的并集决定（瞬时事件/元数据不参与——它们无时长，且可能带不同时间基准）；
  // 并集结果为纳秒，统一换算回微秒（本文件的对外指标全为 µs）。
  const cpuFirstUs = cpuResult.spanNs > 0 ? cpuResult.firstStart / NS_PER_US : Number.POSITIVE_INFINITY
  const gpuFirstUs = gpuResult.spanNs > 0 ? gpuResult.firstStart / NS_PER_US : Number.POSITIVE_INFINITY
  const cpuLastUs = cpuResult.spanNs > 0 ? cpuResult.lastEnd / NS_PER_US : Number.NEGATIVE_INFINITY
  const gpuLastUs = gpuResult.spanNs > 0 ? gpuResult.lastEnd / NS_PER_US : Number.NEGATIVE_INFINITY
  const firstTs = Math.min(cpuFirstUs, gpuFirstUs)
  const lastTs = Math.max(cpuLastUs, gpuLastUs)
  const spanUs = Number.isFinite(firstTs) && Number.isFinite(lastTs) ? Math.max(0, lastTs - firstTs) : 0
  const cpuBusyUs = cpuResult.busyNs / NS_PER_US
  const gpuBusyUs = gpuResult.busyNs / NS_PER_US
  const cpuSeries = cpuBins.occupancySeries(TORCH_LIMITS.timelinePoints).series
  const gpuSeries = gpuBins.occupancySeries(TORCH_LIMITS.timelinePoints).series

  // CPU/X 与 GPU 的重叠：由空闲缝反推并集区间后双指针求交（不物化全部事件区间）
  const cpuMerged = mergedFromGaps(cpuResult.gaps, cpuResult.firstStart, cpuResult.lastEnd)
  const gpuMerged = mergedFromGaps(gpuResult.gaps, gpuResult.firstStart, gpuResult.lastEnd)
  const overlapNs = gpuMerged.length && cpuMerged.length ? intersectionTotals(cpuMerged, gpuMerged).total : 0
  // GPU 空闲期间 CPU 仍在忙的时长（GPU 等 CPU 的直接证据）
  const gapIntervals = gpuResult.gaps.map((g) => ({ start: g.start, end: g.end }))
  const gapCpuBusy = gapIntervals.length && cpuMerged.length ? intersectionTotals(cpuMerged, gapIntervals, true) : { total: 0, perItemB: [] }
  const gpuGapsWithCpu = gpuResult.gaps
    .map((g, i) => ({
      startUs: g.start / NS_PER_US,
      endUs: g.end / NS_PER_US,
      durUs: (g.end - g.start) / NS_PER_US,
      cpuBusyUs: (gapCpuBusy.perItemB?.[i] ?? 0) / NS_PER_US,
    }))
    .sort((a, b) => b.durUs - a.durUs)
    .slice(0, TORCH_LIMITS.topRows)

  const hasGpuEvents = kernelEvents > 0 || gpuTransferEvents > 0
  const notes: string[] = []
  if (!hasGpuEvents) {
    notes.push(
      "trace 中无 GPU 事件（kernel/传输）——GPU 侧时间线需另采：Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 CUDA activity 仍无 kernel 事件），" +
        "请用 nsight_capture kind=nsys 采集 GPU 时间线；Linux 上可用 activities=[ProfilerActivity.CUDA] 重新采集。",
    )
  }
  if (!memory.events) {
    notes.push("trace 中无分配器事件（`[memory]`）——需要采集时启用 profile_memory=True。")
  }

  const facts: TorchFacts = {
    source: path,
    scanMs: performance.now() - t0,
    scale: {
      events,
      scannedChars,
      byCategory: Object.fromEntries([...byCategory.entries()].sort((a, b) => b[1] - a[1])),
      processes: [...processes].map(Number).filter(Number.isFinite).sort((a, b) => a - b),
      threads: threads.size,
      flags,
    },
    hasGpuEvents,
    hasMemoryEvents: memory.events > 0,
    steps,
    stepStats: {
      count: stepDurations.count,
      avgUs: stepDurations.count ? stepDurations.quantile(0.5) : 0,
      medianUs: stepDurations.quantile(0.5),
      p90Us: stepDurations.quantile(0.9),
      minUs: stepDurations.quantile(0),
      maxUs: stepDurations.quantile(1),
    },
    categories: [...categoryTime.entries()].map(([cat, v]) => ({ cat, ...v })).sort((a, b) => b.totalUs - a.totalUs),
    ops: byCat("cpu_op"),
    kernels: byCat("kernel"),
    cudaApis: byCat("cuda_runtime"),
    annotations: byCat("user_annotation"),
    opGroups: (groups.get("cpu_op")?.size ?? 0) + overflowGroups,
    kernelGroups: groups.get("kernel")?.size ?? 0,
    transfers: [...transferAgg.entries()]
      .map(([kind, v]) => ({ kind, ...v, avgBytes: v.count ? v.bytes / v.count : 0 }))
      .sort((a, b) => b.totalUs - a.totalUs),
    transferCount,
    transferBytes,
    memory: {
      available: memory.events > 0,
      events: memory.events,
      allocCount: memory.allocCount,
      freeCount: memory.freeCount,
      allocatedBytes: memory.allocatedBytes,
      freedBytes: memory.freedBytes,
      peakAllocatedBytes: memory.sawTraceTotals ? memory.peakAllocated : memory.peakLiveBytes,
      peakReservedBytes: memory.peakReserved,
      peakSource: memory.sawTraceTotals ? "trace" : memory.peakLiveBytes > 0 ? "live-set" : "none",
      fragmentation: memory.peakAllocated > 0 ? memory.peakReserved / memory.peakAllocated : 0,
      largestAllocs: memory.largest.toArray().map((v) => ({ bytes: v.bytes, addr: v.addr, deviceId: v.deviceId, tsUs: v.tsUs })),
      byDevice: [...memory.byDevice.entries()].map(([deviceId, v]) => ({ deviceId, allocCount: v.allocCount, bytes: v.bytes, peakBytes: v.peakBytes })),
      addrTrackingTruncated: memory.addrTruncated,
    },
    timeline: {
      spanUs,
      firstTsUs: Number.isFinite(firstTs) ? firstTs : 0,
      lastTsUs: Number.isFinite(lastTs) ? lastTs : 0,
      cpuBusyUs,
      cpuUtilization: spanUs > 0 ? cpuBusyUs / spanUs : 0,
      gpuBusyUs,
      gpuUtilization: spanUs > 0 ? gpuBusyUs / spanUs : 0,
      gpuGapCount: gpuResult.gaps.length,
      gpuGapTotalUs: gpuResult.gaps.reduce((s, g) => s + (g.end - g.start), 0) / NS_PER_US,
      gpuGaps: gpuGapsWithCpu,
      gpuMaxConcurrent: gpuResult.maxConcurrent,
      overlapUs: overlapNs / NS_PER_US,
      cpuSeries,
      gpuSeries,
    },
    pythonSites: [...pythonSites.values()].sort((a, b) => b.selfUs - a.selfUs).slice(0, TORCH_LIMITS.pythonHotspots),
    kernelAttribution: [...kernelAttribution.values()].sort((a, b) => b.kernelUs - a.kernelUs).slice(0, TORCH_LIMITS.topRows),
    notes,
  }
  return facts
}
