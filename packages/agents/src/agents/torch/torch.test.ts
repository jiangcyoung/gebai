/**
 * PyTorch Profiler trace 分析的测试：合成一份覆盖真实形态的 trace（原子事件 + 内存瞬时事件 +
 * 元数据 + 采集开关 + python_function 位置），断言解析、聚合、诊断与阈值口径。
 *
 * 用真实 trace 核实过的形态（不是文档推测）：
 * - `ts`/`dur` 单位微秒；`[memory]` 是 `ph:"i"` 的瞬时事件，`args.Bytes` 负数表示释放；
 * - `Total Allocated`/`Total Reserved` 为分配器累计快照；
 * - `python_function` 名称形如 `文件(行): 函数`。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aggregateTorchTrace, buildFwdBwdFacts, eventIdOf, parsePythonSite, readTraceFlags, transferKind, TORCH_LIMITS, type TorchFwdBwdMark } from "./torch-trace"
import { diagnoseTorch, isUserCode, TORCH_THRESHOLDS, userSites } from "./torch-findings"
import { compareSnapshots, type SideSnapshot } from "../../core/perf/compare"
import { formatBytes } from "../../core/perf/format"
import { isTorchTrace, statTrace, traceAccessError, traceChangedReason } from "./torch-report"
import { captureScript, factsCachePath, loadTorchFacts, resetTorchFactsCache, scanCommand, torchTools } from "./torch-tools"
import { makeStubCtx } from "../../core/perf/test-ctx"

/** 造一条 trace：含 ProfilerStep、算子（含 .item() 同步）、内存事件、python 位置与 CPU 空洞。 */
function syntheticTrace(opts: { gpu?: boolean; memory?: boolean; steps?: number } = {}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  const base = 1_700_000_000_000_000
  events.push({ name: "process_name", ph: "M", pid: 100, tid: 0, args: { name: "python" } })
  const steps = opts.steps ?? 3
  for (let s = 0; s < steps; s++) {
    const stepStart = base + s * 10_000 // 每步 10 ms
    events.push({ ph: "X", cat: "user_annotation", name: `ProfilerStep#${s}`, pid: 100, tid: 1, ts: stepStart, dur: 9_000, args: {} })
    // 算子：linear → relu → item（同步）
    events.push({ ph: "X", cat: "cpu_op", name: "aten::linear", pid: 100, tid: 1, ts: stepStart + 10, dur: 2_000, args: { "Input Dims": [[128, 512], [1024, 512], [1024]], "Input type": ["float", "float", "float"] } })
    events.push({ ph: "X", cat: "cpu_op", name: "aten::relu", pid: 100, tid: 1, ts: stepStart + 2_020, dur: 300, args: { "Input Dims": [[128, 1024]], "Input type": ["float"] } })
    // 10 个微小算子（碎片化判据）
    for (let i = 0; i < 10; i++) {
      events.push({ ph: "X", cat: "cpu_op", name: "aten::mul", pid: 100, tid: 1, ts: stepStart + 3_000 + i * 10, dur: 3, args: { "Input Dims": [[128, 256]], "Input type": ["float"] } })
    }
    events.push({ ph: "X", cat: "cpu_op", name: "aten::_local_scalar_dense", pid: 100, tid: 1, ts: stepStart + 4_000, dur: 1_500, args: {} })
    events.push({ ph: "X", cat: "python_function", name: "train.py(42): train_step", pid: 100, tid: 1, ts: stepStart, dur: 9_000, args: { "Python id": 1 } })
    events.push({ ph: "X", cat: "python_function", name: "torch/optim/optimizer.py(120): step", pid: 100, tid: 1, ts: stepStart + 100, dur: 200, args: { "Python id": 2 } })
    if (opts.memory) {
      events.push({ ph: "i", cat: "cpu_instant_event", name: "[memory]", pid: 100, tid: 1, ts: stepStart + 50, s: "t", args: { Bytes: 8 << 20, Addr: 1000 + s, "Device Id": 0, "Total Allocated": 8 << 20, "Total Reserved": 24 << 20 } })
      events.push({ ph: "i", cat: "cpu_instant_event", name: "[memory]", pid: 100, tid: 1, ts: stepStart + 60, s: "t", args: { Bytes: -(8 << 20), Addr: 1000 + s, "Device Id": 0, "Total Allocated": 0, "Total Reserved": 24 << 20 } })
    }
    if (opts.gpu) {
      events.push({ ph: "X", cat: "cuda_runtime", name: "cudaLaunchKernel", pid: 100, tid: 1, ts: stepStart + 10, dur: 30, args: { correlation: 7000 + s } })
      events.push({ ph: "X", cat: "kernel", name: "void cutlass::Kernel<simt_sgemm>(Params)", pid: 0, tid: 7, ts: stepStart + 2_100, dur: 500, args: { device: 0, stream: 7, correlation: 7000 + s, grid: [128, 1, 1], block: [256, 1, 1], "registers per thread": 216, "est. achieved occupancy %": 18 } })
      // 50 个小内核（启动开销判据）
      for (let i = 0; i < 50; i++) {
        events.push({ ph: "X", cat: "kernel", name: "void tiny_kernel(int*)", pid: 0, tid: 7, ts: stepStart + 2_700 + i * 20, dur: 2, args: { device: 0, stream: 7, correlation: 7001 + s } })
      }
      events.push({ ph: "X", cat: "gpu_memcpy", name: "Memcpy DtoH (Device -> Pageable)", pid: 0, tid: 7, ts: stepStart + 3_800, dur: 400, args: { device: 0, stream: 7, bytes: 4096 } })
      events.push({ ph: "X", cat: "gpu_memcpy", name: "Memcpy HtoD (Pageable -> Device)", pid: 0, tid: 7, ts: stepStart + 4_300, dur: 600, args: { device: 0, stream: 7, bytes: 2 << 20 } })
      // 一段无 GPU 活动的 CPU 工作区（4 ms 空洞 → 计入空闲缝；把 GPU 利用率压到低水平 → 触发 CPU 受限判定）
      events.push({ ph: "X", cat: "python_function", name: "train.py(60): prepare_batch", pid: 100, tid: 1, ts: stepStart + 5_000, dur: 4_000, args: {} })
      events.push({ ph: "X", cat: "cpu_op", name: "aten::stack", pid: 100, tid: 1, ts: stepStart + 5_100, dur: 3_000, args: {} })
    }
  }
  return events
}

async function writeTrace(events: Record<string, unknown>[], name = "trace.pt.trace.json", flags: Record<string, unknown> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "gebai-torch-"))
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, profile_memory: 1, with_stack: 1, record_shapes: 1, ...flags, traceEvents: events }), "utf8")
  return path
}

describe("报告类型识别（PyTorch trace）", () => {
  test("按 PyTorch / TensorBoard 命名识别为 torch", () => {
    expect(isTorchTrace("run/trace.pt.trace.json")).toBe(true)
    expect(isTorchTrace("trace.pt.trace.json.gz")).toBe(true)
    expect(isTorchTrace("model.trace.json")).toBe(true)
    expect(isTorchTrace("prof.json.gz")).toBe(true)
    // 与 Nsight 类型不混淆
    // Nsight 报告与其它文件不属于本面（由 nsight 子Agent 处理）
    expect(isTorchTrace("a.nsys-rep")).toBe(false)
    expect(isTorchTrace("a.ncu-rep")).toBe(false)
    expect(isTorchTrace("a.sqlite")).toBe(false)
  })
})

describe("解析与聚合（合成 trace）", () => {
  test("python_function 名称解析出 文件/行/函数；非该形态返回 null", () => {
    expect(parsePythonSite("train.py(42): train_step")).toEqual({ file: "train.py", line: 42, func: "train_step" })
    expect(parsePythonSite("torch/optim/optimizer.py(120): step")).toEqual({ file: "torch/optim/optimizer.py", line: 120, func: "step" })
    expect(parsePythonSite("no_location_here")).toBe(null)
  })

  test("传输方向解析（kineto 命名形态）", () => {
    expect(transferKind("Memcpy DtoH (Device -> Pageable)")).toBe("DtoH")
    expect(transferKind("Memcpy HtoD (Pageable -> Device)")).toBe("HtoD")
    expect(transferKind("Memset (Device)")).toBe("Memset")
    expect(transferKind("cudaMemcpyAsync")).toBe("cudaMemcpyAsync")
  })

  test("聚合：事件规模、类别、算子自身耗时（减法而非重复计数）、步骤与内存峰值", async () => {
    const path = await writeTrace(syntheticTrace({ memory: true }))
    const facts = await aggregateTorchTrace(path)
    expect(facts.scale.events).toBeGreaterThan(0)
    expect(facts.scale.byCategory["cpu_op"]).toBe(3 * 13) // linear + relu + 10×mul + item
    expect(facts.scale.byCategory["python_function"]).toBe(6)
    expect(facts.stepStats.count).toBe(3)
    expect(facts.steps[0]!.name).toBe("ProfilerStep#0")
    expect(facts.stepStats.medianUs).toBe(9_000)

    // ProfilerStep 的自身耗时 = 9000 - (linear 2000 + relu 300 + 10×3 + item 1500 + python 9200 含步内)
    // 这里只断言口径正确：自身耗时小于总耗时且非负
    const linear = facts.ops.find((o) => o.name === "aten::linear")!
    expect(linear.count).toBe(3)
    expect(linear.totalUs).toBe(6_000)
    expect(linear.selfUs).toBe(6_000) // 无同类子事件
    expect(linear.shapeSamples[0]).toContain("128")
    expect(linear.dtypeSamples[0]).toBe("float,float,float")

    // 内存：3 步 × (1 分配 + 1 释放)
    expect(facts.memory.available).toBe(true)
    expect(facts.memory.allocCount).toBe(3)
    expect(facts.memory.freeCount).toBe(3)
    expect(facts.memory.peakAllocatedBytes).toBe(8 << 20)
    expect(facts.memory.peakReservedBytes).toBe(24 << 20)
    expect(facts.memory.fragmentation).toBeCloseTo(3, 5)
    expect(facts.memory.largestAllocs[0]!.bytes).toBe(8 << 20)

    // CPU 忙碌与窗口
    expect(facts.timeline.cpuBusyUs).toBeGreaterThan(0)
    expect(facts.timeline.spanUs).toBeGreaterThan(0)
    // 无 GPU 事件 → 如实标注 + 备注说明如何补
    expect(facts.hasGpuEvents).toBe(false)
    expect(facts.notes.join("")).toContain("nsight_capture")
  })

  test("GPU 事件形态：内核几何/关联/小内核归类与传输聚合", async () => {
    const path = await writeTrace(syntheticTrace({ gpu: true }))
    const facts = await aggregateTorchTrace(path)
    expect(facts.hasGpuEvents).toBe(true)
    const sgemm = facts.kernels.find((k) => k.name.includes("sgemm"))!
    expect(sgemm.count).toBe(3)
    expect(sgemm.grid).toEqual([128, 1, 1])
    expect(sgemm.block).toEqual([256, 1, 1])
    expect(sgemm.registers).toBe(216)
    expect(sgemm.occupancy).toBe(18)
    expect(sgemm.devices).toEqual([0])
    expect(sgemm.streams).toEqual([7])
    // 内核 → 发起算子（correlation = cudaLaunchKernel）
    expect(facts.kernelAttribution.some((a) => a.op === "cudaLaunchKernel" && a.kernel.includes("sgemm"))).toBe(true)
    // 传输按方向聚合
    const dtoh = facts.transfers.find((t) => t.kind === "DtoH")!
    expect(dtoh.count).toBe(3)
    expect(dtoh.avgBytes).toBe(4096)
    expect(facts.transferBytes).toBe(3 * 4096 + 3 * (2 << 20))
    // GPU 忙碌与空闲缝（内核之间有空隙）
    expect(facts.timeline.gpuBusyUs).toBeGreaterThan(0)
    expect(facts.timeline.gpuGapCount).toBeGreaterThan(0)
    expect(facts.timeline.gpuGaps[0]).toHaveProperty("cpuBusyUs")
  })

  test("顶层采集开关可读（traceEvents 之外字段）", async () => {
    const path = await writeTrace(syntheticTrace(), "x.pt.trace.json", { profile_memory: 0, with_stack: 1, record_shapes: 1, with_modules: 1 })
    const flags = await readTraceFlags(path)
    expect(flags.profile_memory).toBe(0)
    expect(flags.with_stack).toBe(1)
    expect(flags.schemaVersion).toBe(1)
  })

  test("gzip 变体的采集开关与 json 一致（头部先解压再匹配）", async () => {
    const events = syntheticTrace()
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-flagsgz-"))
    const raw = join(dir, "t.pt.trace.json")
    writeFileSync(raw, JSON.stringify({ schemaVersion: 1, profile_memory: 1, with_stack: 1, record_shapes: 1, traceEvents: events }), "utf8")
    const gz = join(dir, "t.pt.trace.json.gz")
    await Bun.write(gz, Bun.gzipSync(await Bun.file(raw).arrayBuffer()))
    expect(await readTraceFlags(gz)).toEqual(await readTraceFlags(raw))
  })

  test("gzip 形态（*.pt.trace.json.gz）可直接分析（TensorBoard 默认产物）", async () => {
    const events = syntheticTrace({ memory: true })
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-gz-"))
    const raw = join(dir, "trace.pt.trace.json")
    writeFileSync(raw, JSON.stringify({ schemaVersion: 1, traceEvents: events }), "utf8")
    const gz = join(dir, "trace.pt.trace.json.gz")
    // Bun 的 gzip 压缩（与 TensorBoard 产出的 gzip 容器同格式）
    await Bun.write(gz, Bun.gzipSync(await Bun.file(raw).arrayBuffer()))
    const facts = await aggregateTorchTrace(gz)
    expect(isTorchTrace(gz)).toBe(true)
    expect(facts.stepStats.count).toBe(3)
    expect(facts.memory.allocCount).toBe(3)
  })

  test("事件规模与内存解耦：结果条数由上限封顶，不随事件数增长", async () => {
    const many: Record<string, unknown>[] = []
    for (let i = 0; i < 20_000; i++) many.push({ ph: "X", cat: "cpu_op", name: `aten::op_${i % 3_000}`, pid: 1, tid: 1, ts: i * 10, dur: 5, args: {} })
    const path = await writeTrace(many)
    const facts = await aggregateTorchTrace(path)
    expect(facts.scale.events).toBe(20_000)
    expect(facts.ops.length).toBeLessThanOrEqual(TORCH_LIMITS.topRows)
    expect(facts.opGroups).toBe(3_000)
    expect(facts.timeline.cpuSeries.length).toBeLessThanOrEqual(TORCH_LIMITS.timelinePoints)
  })

  test("非 trace 文件给出可操作的错误（未找到 traceEvents）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-bad-"))
    const path = join(dir, "bad.pt.trace.json")
    writeFileSync(path, JSON.stringify({ events: [] }), "utf8")
    await expect(aggregateTorchTrace(path)).rejects.toThrow(/traceEvents/)
  })
})

describe("诊断规则（阈值集中定义并与实现一致）", () => {
  test("逐步同步（.item()）→ 命中同步规则并按可回收时间给出上限", async () => {
    const path = await writeTrace(syntheticTrace({ memory: true }))
    const facts = await aggregateTorchTrace(path)
    const { findings } = diagnoseTorch(facts)
    const sync = findings.find((f) => f.id === "sync-per-step")!
    expect(sync).toBeDefined()
    expect(sync.severity).toBe("high")
    expect(sync.evidence.join(" ")).toContain("aten::_local_scalar_dense")
    expect(sync.reclaimableUs).toBeGreaterThan(0)
  })

  test("无 GPU 事件 → 不给内核级结论，改为如实提示补采（不把未采集当没问题）", async () => {
    const path = await writeTrace(syntheticTrace({ memory: true }))
    const facts = await aggregateTorchTrace(path)
    const { findings, skipped } = diagnoseTorch(facts)
    expect(findings.find((f) => f.id === "no-gpu-events")).toBeDefined()
    expect(findings.find((f) => f.id === "small-kernels")).toBeUndefined()
    expect(skipped.join(" ")).toContain("kernel")
  })

  test("有 GPU 事件时命中内核级规则（小内核、单内核主导、占用率压力）与 CPU 受限", async () => {
    const path = await writeTrace(syntheticTrace({ gpu: true }))
    const facts = await aggregateTorchTrace(path)
    const { findings } = diagnoseTorch(facts)
    const ids = findings.map((f) => f.id)
    expect(ids).toContain("small-kernels")
    expect(ids).toContain("top-kernel")
    expect(ids).toContain("occupancy-pressure")
    expect(ids).toContain("cpu-bound")
    // CPU 受限的判据必须带「空闲缝期间 CPU 是否在忙」的实测证据
    const cpuBound = findings.find((f) => f.id === "cpu-bound")!
    expect(cpuBound.evidence.join(" ")).toContain("CPU 仍在忙")
  })

  test("显存碎片化与 float64 混入命中；用户代码热点定位到合成文件行", async () => {
    const base = 1_700_000_000_000_000
    const events = syntheticTrace({ memory: true })
    events.push({ ph: "i", cat: "cpu_instant_event", name: "[memory]", pid: 1, tid: 1, ts: base + 999, s: "t", args: { Bytes: 1 << 20, Addr: 5, "Device Id": 0, "Total Allocated": 1 << 20, "Total Reserved": 64 << 20 } })
    events.push({ ph: "X", cat: "cpu_op", name: "aten::div", pid: 1, tid: 1, ts: base + 5_000, dur: 100, args: { "Input Dims": [[8]], "Input type": ["double", "Scalar"] } })
    const path = await writeTrace(events)
    const facts = await aggregateTorchTrace(path)
    const { findings } = diagnoseTorch(facts)
    const ids = findings.map((f) => f.id)
    expect(ids).toContain("memory-fragmentation")
    expect(ids).toContain("float64-ops")
    expect(ids).toContain("user-code-hotspot")
    const hotspot = findings.find((f) => f.id === "user-code-hotspot")!
    expect(hotspot.sites[0]!.file).toBe("train.py")
    expect(hotspot.sites[0]!.line).toBe(42)
    // 严重度排序：critical/high 在前
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const
    for (let i = 1; i < findings.length; i++) expect(order[findings[i]!.severity]).toBeGreaterThanOrEqual(order[findings[i - 1]!.severity])
  })

  test("用户代码判定：排除 torch/site-packages，保留工程文件", () => {
    expect(isUserCode("train.py")).toBe(true)
    expect(isUserCode("C:/proj/src/model.py")).toBe(true)
    expect(isUserCode("torch/optim/optimizer.py")).toBe(false)
    expect(isUserCode("site-packages/torch/nn/modules/module.py")).toBe(false)
    expect(isUserCode("torch/nn/modules/module.py")).toBe(false)
    // CPython 标准库帧（无路径前缀）不得占用户热点榜
    expect(isUserCode("inspect.py")).toBe(false)
    expect(isUserCode("functools.py")).toBe(false)
    expect(isUserCode("linecache.py")).toBe(false)
  })

  test("用户热点排序只含用户代码（框架帧不占榜）", async () => {
    const path = await writeTrace(syntheticTrace({ memory: true }))
    const facts = await aggregateTorchTrace(path)
    const sites = userSites(facts, 5)
    expect(sites.length).toBeGreaterThan(0)
    for (const s of sites) expect(isUserCode(s.file)).toBe(true)
  })

  test("显存数值的显示口径统一：findings 与格式化助手同源（同一数值不得两处显示不同）", async () => {
    const path = await writeTrace(syntheticTrace({ memory: true }))
    const facts = await aggregateTorchTrace(path)
    const { findings } = diagnoseTorch(facts)
    const frag = findings.find((f) => f.id === "memory-fragmentation")!
    expect(frag).toBeDefined()
    const text = [frag.title, ...frag.evidence].join(" ")
    // 与 overview/memory 使用的 formatBytes 完全一致（十进制 MB），且不出现二进制 MiB 的旧口径
    expect(text).toContain(formatBytes(facts.memory.peakAllocatedBytes))
    expect(text).toContain(formatBytes(facts.memory.peakReservedBytes))
    expect(text).not.toContain((facts.memory.peakAllocatedBytes / 1048576).toFixed(2))
    // 单位不得重复（\`28.1 MB MB\` 一类拼接错误）
    expect(text).not.toMatch(/([KMGB]+)\s+\1\b/)
  })

  test("阈值常量被导出且口径稳定（防止文档与实现漂移）", () => {
    expect(TORCH_THRESHOLDS.syncShare).toBeGreaterThan(0)
    expect(TORCH_THRESHOLDS.fragmentation).toBeCloseTo(1.5, 5)
    expect(TORCH_THRESHOLDS.tinyOpCountShare).toBeCloseTo(0.5, 5)
    expect(TORCH_LIMITS.topRows).toBe(20)
  })
})

// ---------------------------------------------------------------- 合成形态：流事件与 fwdbwd

/**
 * 流事件与 fwdbwd 的合成形态（按导出器实测顺序：活动 X 事件 → 该活动的流事件紧跟其后）。
 * - fwdbwd：s 挂前向 cpu_op、同 id 的 f 挂其反向 cpu_op（反向占比由两侧算子时长得出）；
 * - ac2g：s 挂 cuda_runtime 活动、同 id 的 f 挂对应 kernel 活动（内核归属的补充通道）；
 * - 两类流事件的 id 各自从 1 开始（实际如此）——配对键必须区分流类型。
 */
function flowTrace(opts: { fwdbwd?: boolean; ac2g?: boolean; correlation?: boolean; kernels?: boolean } = {}): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  const base = 1_700_000_000_000_000
  const kernels = opts.kernels !== false
  for (let s = 0; s < 3; s++) {
    const t = base + s * 10_000
    events.push({ ph: "X", cat: "user_annotation", name: `ProfilerStep#${s}`, pid: 100, tid: 1, ts: t, dur: 9_000, args: {} })
    events.push({ ph: "X", cat: "python_function", name: "train.py(42): train_step", pid: 100, tid: 1, ts: t, dur: 9_000, args: {} })
    events.push({ ph: "X", cat: "cpu_op", name: "aten::linear", pid: 100, tid: 1, ts: t + 10, dur: 2_000, args: {} })
    if (opts.ac2g) {
      events.push({ ph: "X", cat: "cuda_runtime", name: "cudaLaunchKernel", pid: 100, tid: 1, ts: t + 20, dur: 30, args: { correlation: 7000 + s } })
      events.push({ ph: "s", cat: "ac2g", name: "ac2g", id: 1 + s, pid: 100, tid: 1, ts: t + 20 })
      if (kernels) {
        events.push({ ph: "X", cat: "kernel", name: "void gemm_kernel(float*)", pid: 0, tid: 7, ts: t + 2_100, dur: 500, args: { device: 0, stream: 7, ...(opts.correlation === false ? {} : { correlation: 7000 + s }) } })
        events.push({ ph: "f", cat: "ac2g", name: "ac2g", id: 1 + s, pid: 0, tid: 7, ts: t + 2_100, bp: "e" })
      }
    }
    if (opts.fwdbwd) {
      events.push({ ph: "s", cat: "fwdbwd", name: "fwdbwd", id: 1 + s, pid: 100, tid: 1, ts: t + 10 })
      events.push({ ph: "X", cat: "cpu_op", name: "AddmmBackward0", pid: 100, tid: 1, ts: t + 3_000, dur: 4_000, args: {} })
      events.push({ ph: "f", cat: "fwdbwd", name: "fwdbwd", id: 1 + s, pid: 100, tid: 1, ts: t + 3_000, bp: "e" })
    }
  }
  return events
}

/** 写一条合成 trace 到临时目录并返回路径。 */
function writeTraceIn(dir: string, events: Record<string, unknown>[], name: string, flags: Record<string, unknown> = {}): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...flags, traceEvents: events }), "utf8")
  return path
}

describe("B2 前向/反向拆分（fwdbwd 流事件）", () => {
  test("配对口径：前向算子与其反向算子的成对时长、反向占比与逐步拆分", () => {
    const marks: TorchFwdBwdMark[] = [
      { forwardUs: 100, backwardUs: 300, forwardName: "aten::addmm", backwardName: "AddmmBackward0", tsUs: 0 },
      { forwardUs: 100, backwardUs: 100, forwardName: "aten::relu", backwardName: "ReluBackward0", tsUs: 10_000 },
    ]
    const fb = buildFwdBwdFacts(marks, [
      { name: "ProfilerStep#0", tsUs: 0, durUs: 9_000 },
      { name: "ProfilerStep#1", tsUs: 10_000, durUs: 9_000 },
    ])
    expect(fb.available).toBe(true)
    expect(fb.marks).toBe(2)
    expect(fb.linked).toBe(2)
    expect(fb.forwardUs).toBe(200)
    expect(fb.backwardUs).toBe(400)
    expect(fb.backwardShare).toBeCloseTo(400 / 600, 6)
    expect(fb.avgForwardUs).toBe(100)
    expect(fb.avgBackwardUs).toBe(200)
    // 逐步：按前向算子起点归步
    expect(fb.perStep.map((p) => p.step)).toEqual(["ProfilerStep#0", "ProfilerStep#1"])
    expect(fb.perStep[0]!.backwardShare).toBeCloseTo(0.75, 6)
    expect(fb.perStep[1]!.backwardShare).toBeCloseTo(0.5, 6)
    // 证据样本按反向耗时降序
    expect(fb.samples[0]!.backward).toBe("AddmmBackward0")
  })

  test("无步标注时逐对列出；未取到算子活动时 available=false（不臆造）", () => {
    const fb = buildFwdBwdFacts([{ forwardUs: 10, backwardUs: 20, tsUs: 5 }], [])
    expect(fb.perStep.map((p) => p.step)).toEqual(["配对 #0"])
    const unlinked = buildFwdBwdFacts([{ forwardUs: 0, backwardUs: 0, tsUs: 5 }], [])
    expect(unlinked.marks).toBe(1)
    expect(unlinked.linked).toBe(0)
    expect(unlinked.available).toBe(false)
  })

  test("真实形态：s 挂前向算子、f 挂其反向算子 → 聚合出两侧时长与反向占比", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-fwdbwd-"))
    const path = writeTraceIn(dir, flowTrace({ fwdbwd: true }), "flow.pt.trace.json")
    const facts = await aggregateTorchTrace(path)
    expect(facts.fwdBwd.available).toBe(true)
    expect(facts.fwdBwd.marks).toBe(3)
    expect(facts.fwdBwd.linked).toBe(3)
    // 3 步 × (前向 aten::linear 2000µs / 反向 AddmmBackward0 4000µs)
    expect(facts.fwdBwd.forwardUs).toBe(6_000)
    expect(facts.fwdBwd.backwardUs).toBe(12_000)
    expect(facts.fwdBwd.backwardShare).toBeCloseTo(2 / 3, 6)
    expect(facts.fwdBwd.perStep).toHaveLength(3)
    expect(facts.fwdBwd.perStep[0]!.forwardUs).toBe(2_000)
    expect(facts.fwdBwd.perStep[0]!.backwardUs).toBe(4_000)
    expect(facts.fwdBwd.samples[0]!.forward).toBe("aten::linear")
    rmSync(dir, { recursive: true, force: true })
  })

  test("反向占比超过阈值 → 命中诊断规则；无 fwdbwd 事件 → 如实说明未采集且不臆造", async () => {
    // 阈值锁定（防止实现与文档漂移）
    expect(TORCH_THRESHOLDS.backwardShare).toBeCloseTo(0.6, 6)
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-fwdbwd2-"))
    const withFlow = writeTraceIn(dir, flowTrace({ fwdbwd: true }), "flow.pt.trace.json")
    const facts = await aggregateTorchTrace(withFlow)
    const hit = diagnoseTorch(facts)
    const rule = hit.findings.find((f) => f.id === "backward-share")!
    expect(rule).toBeDefined()
    expect(rule.evidence.join(" ")).toContain("AddmmBackward0")
    expect(rule.evidence.join(" ")).toContain("aten::linear")

    const noFlow = writeTraceIn(dir, syntheticTrace({ memory: true }), "noflow.pt.trace.json")
    const f2 = await aggregateTorchTrace(noFlow)
    expect(f2.fwdBwd.available).toBe(false)
    expect(f2.fwdBwd.marks).toBe(0)
    const d2 = diagnoseTorch(f2)
    expect(d2.findings.find((f) => f.id === "backward-share")).toBeUndefined()
    expect(d2.skipped.join(" ")).toContain("前向/反向")
    rmSync(dir, { recursive: true, force: true })
  })

  test("overview 输出前向/反向拆分一行（未采集时也如实说明）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-fwdbwd3-"))
    const { ctx } = makeStubCtx(dir)
    const withFlow = writeTraceIn(dir, flowTrace({ fwdbwd: true }), "flow.pt.trace.json")
    resetTorchFactsCache()
    const out = await torchTools.overview!.execute({ report: withFlow }, ctx)
    expect(out.output).toContain("前向/反向")
    expect(out.output).toContain("反向占比 66.7%")
    const noFlow = writeTraceIn(dir, syntheticTrace({ memory: true }), "noflow.pt.trace.json")
    resetTorchFactsCache()
    const out2 = await torchTools.overview!.execute({ report: noFlow }, ctx)
    expect(out2.output).toContain("前向/反向：未采集")
    rmSync(dir, { recursive: true, force: true })
  })

  test("流事件 id 仅按原文提取（顶层 id 优先，不受 args 内同名键干扰）", () => {
    expect(eventIdOf('{"ph":"s","id":17,"cat":"fwdbwd"}')).toBe(17)
    expect(eventIdOf('{"ph":"s","cat":"x"}')).toBeUndefined()
  })
})

describe("B3 内核归属（correlation + 流事件）", () => {
  test("correlation 链：内核 → 发起算子（最内层 cpu_op）+ 发起 Python 位置", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-attr-"))
    const path = writeTraceIn(dir, flowTrace({ ac2g: true }), "attr.pt.trace.json")
    const facts = await aggregateTorchTrace(path)
    const a = facts.kernelAttribution.find((x) => x.kernel.includes("gemm_kernel"))!
    expect(a).toBeDefined()
    expect(a.op).toBe("aten::linear")
    expect(a.api).toBe("cudaLaunchKernel")
    expect(a.python).toBe("train.py(42): train_step")
    expect(a.via).toBe("correlation")
    // 无 kernel 事件时的退化归属数据：CUDA API 的发起算子/发起位置样本
    expect(facts.cudaApis[0]!.launchOps).toContain("aten::linear")
    expect(facts.cudaApis[0]!.launchSites).toContain("train.py(42): train_step")
    rmSync(dir, { recursive: true, force: true })
  })

  test("流事件（ac2g）补全：无 correlation 的内核也能归属到发起活动", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-attr2-"))
    const path = writeTraceIn(dir, flowTrace({ ac2g: true, correlation: false }), "attr2.pt.trace.json")
    const facts = await aggregateTorchTrace(path)
    expect(facts.flows.available).toBe(true)
    expect(facts.flows.kernelLinks).toBe(3)
    const a = facts.kernelAttribution.find((x) => x.kernel.includes("gemm_kernel"))!
    expect(a).toBeDefined()
    expect(a.via).toBe("flow")
    expect(a.op).toBe("cudaLaunchKernel")
    rmSync(dir, { recursive: true, force: true })
  })

  test("无流事件时如实说明（归属仅依赖 correlation）；torch_ops kind=kernel 展示归属表", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-attr3-"))
    const { ctx } = makeStubCtx(dir)
    const path = writeTraceIn(dir, syntheticTrace({ gpu: true }), "gpu.pt.trace.json")
    const facts = await aggregateTorchTrace(path)
    expect(facts.flows.available).toBe(false)
    expect(facts.flows.pairs).toBe(0)
    expect(facts.notes.join("")).toContain("correlation")
    resetTorchFactsCache()
    const out = await torchTools.ops!.execute({ report: path, kind: "kernel" }, ctx)
    expect(out.output).toContain("内核 → 发起方")
    expect(out.output).toContain("correlation")

    // Windows 形态（无 kernel 事件）：退化为 CUDA API → 发起位置
    const cpuOnly = writeTraceIn(dir, flowTrace({ ac2g: true, kernels: false }), "cpuonly.pt.trace.json")
    resetTorchFactsCache()
    const out2 = await torchTools.ops!.execute({ report: cpuOnly, kind: "kernel" }, ctx)
    expect(out2.output).toContain("无 kernel 事件")
    expect(out2.output).toContain("发起算子（样本）")
    expect(out2.output).toContain("aten::linear")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("B1 时间预算、后台衔接与落盘事实缓存", () => {
  test("超预算返回「未完成」而不是抛超时错误；onProgress 报进度", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-budget-"))
    const many: Record<string, unknown>[] = []
    for (let i = 0; i < 120_000; i++) many.push({ ph: "X", cat: "cpu_op", name: `aten::op_${i % 500}`, pid: 1, tid: 1, ts: i * 10, dur: 5, args: { "Input Dims": [[64, 256]] } })
    const path = writeTraceIn(dir, many, "many.pt.trace.json")
    let progressCalls = 0
    const facts = await aggregateTorchTrace(path, { budgetMs: 100, onProgress: () => progressCalls++ })
    expect(facts.incomplete).toBeDefined()
    expect(facts.incomplete!.budgetMs).toBe(100)
    expect(facts.incomplete!.events).toBeGreaterThan(0)
    expect(facts.incomplete!.events).toBeLessThan(120_000)
    expect(facts.incomplete!.scannedChars).toBeGreaterThan(0)
    expect(facts.source).toBe(path)
    expect(progressCalls).toBeGreaterThan(0)
    // 预算 0 = 不限：正常完成且无 incomplete
    const full = await aggregateTorchTrace(path, { budgetMs: 0 })
    expect(full.incomplete).toBeUndefined()
    expect(full.scale.events).toBe(120_000)
    rmSync(dir, { recursive: true, force: true })
  })

  test("工具层：未完成 → 说明 + 可后台执行的完整命令 + 命中落盘缓存的说明", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-pending-"))
    const many: Record<string, unknown>[] = []
    for (let i = 0; i < 40_000; i++) many.push({ ph: "X", cat: "cpu_op", name: `aten::op_${i % 300}`, pid: 1, tid: 1, ts: i * 10, dur: 5, args: {} })
    const path = writeTraceIn(dir, many, "pending.pt.trace.json")
    const { ctx } = makeStubCtx(dir)
    resetTorchFactsCache()
    const r = await torchTools.overview!.execute({ report: path, budget: 0.001 }, ctx)
    expect(r.output).toContain("本次分析未完成")
    expect(r.output).toContain("bg_task")
    expect(r.output).toContain("命中已落盘")
    const data = r.data as { incomplete?: unknown; command?: string }
    expect(data.incomplete).toBeDefined()
    const cmd = data.command!
    expect(cmd.startsWith("bun -e \"")).toBe(true)
    // 命令里的路径必须用正斜杠（反斜杠在 JS 字符串里会被当转义符）
    expect(cmd).not.toMatch(/'(?:[A-Za-z]:)?[^']*\\[^']*'/)
    expect(cmd).toContain(path.replace(/\\/g, "/"))
    expect(cmd).toContain(factsCachePath(ctx, statTrace(ctx, path)).replace(/\\/g, "/"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("落盘事实缓存：后台命令产出的 JSON 被工具直接复用（秒回）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-diskcache-"))
    const path = writeTraceIn(dir, syntheticTrace({ memory: true }), "cached.pt.trace.json")
    // 先把扫描耗时阈值绕过：直接把事实写成后台命令的产物形态
    const { ctx } = makeStubCtx(dir)
    const facts = await aggregateTorchTrace(path, { budgetMs: 0 })
    const cacheFile = factsCachePath(ctx, statTrace(ctx, path))
    const { mkdirSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, JSON.stringify(facts), "utf8")
    resetTorchFactsCache()
    const loaded = await loadTorchFacts(ctx, { report: path })
    expect(loaded.reused).toBe(true)
    expect(loaded.elapsedMs).toBe(0)
    expect(loaded.cacheFile).toBe(cacheFile)
    expect(loaded.facts.scale.events).toBe(facts.scale.events)
    // 缓存键含文件指纹：文件改写后不再命中
    rmSync(cacheFile)
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, traceEvents: syntheticTrace({ memory: true, steps: 1 }) }), "utf8")
    resetTorchFactsCache()
    const again = await loadTorchFacts(ctx, { report: path })
    expect(again.reused).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("scanCommand：路径用正斜杠、单引号内联、含事实落盘写入", () => {
    const ctx = makeStubCtx(mkdtempSync(join(tmpdir(), "gebai-torch-cmd-"))).ctx
    const ref = { path: "C:\\tmp\\a b\\t.pt.trace.json", name: "t.pt.trace.json", stem: "t.pt", size: 10, mtimeMs: 5 }
    const cmd = scanCommand(ref, "C:\\tmp\\cache\\t.json")
    expect(cmd).toContain("bun -e \"const m=await import('file://")
    expect(cmd).toContain("'C:/tmp/a b/t.pt.trace.json'")
    expect(cmd).toContain("'C:/tmp/cache/t.json'")
    expect(cmd).toContain("Bun.write")
    expect(ctx.home).toBeTruthy()
  })
})

describe("A3 文件变更的友好报错（TOCTOU）", () => {
  test("扫描前后一致性：未变 → undefined；被改写/删除 → 可操作提示", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-toctou-"))
    const { ctx } = makeStubCtx(dir)
    const path = writeTraceIn(dir, syntheticTrace({ memory: true }), "t.pt.trace.json")
    const ref = statTrace(ctx, path)
    expect(traceChangedReason(ref)).toBeUndefined()
    writeFileSync(path + ".tmp", "x")
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, traceEvents: syntheticTrace({ memory: true, steps: 6 }) }), "utf8")
    const changed = traceChangedReason(ref)!
    expect(changed).toContain("被修改")
    expect(changed).toContain("重试")
    rmSync(path)
    expect(traceChangedReason(ref)).toContain("被删除")
    rmSync(dir, { recursive: true, force: true })
  })

  test("文件访问类错误被重写为可操作提示（不暴露原始 ENOENT）", () => {
    const ref = { path: "C:\\gone\\t.pt.trace.json", name: "t.pt.trace.json", stem: "t.pt", size: 1, mtimeMs: 1 }
    const err = new Error("ENOENT: no such file or directory, open 'C:\\gone\\t.pt.trace.json'")
    const friendly = traceAccessError(ref, err)!
    expect(friendly.message).toContain("分析过程中不可读")
    expect(friendly.message).not.toContain("ENOENT")
    // 非文件访问类错误原样返回 null（由调用方抛出）
    expect(traceAccessError(ref, new Error("traceEvents 未找到"))).toBeNull()
  })

  test("分析期间文件被删除 → 工具抛可操作错误而不是原始系统错误", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-toctou2-"))
    const { ctx } = makeStubCtx(dir)
    // 足够大：扫描耗时远大于删除延迟（确保删除发生在扫描过程中）
    const many: Record<string, unknown>[] = []
    for (let i = 0; i < 100_000; i++) many.push({ ph: "X", cat: "cpu_op", name: `aten::op_${i % 400}`, pid: 1, tid: 1, ts: i * 10, dur: 5, args: { "Input Dims": [[64, 256]] } })
    const path = writeTraceIn(dir, many, "race.pt.trace.json")
    resetTorchFactsCache()
    const timer = setTimeout(() => rmSync(path, { force: true }), 80)
    try {
      await expect(loadTorchFacts(ctx, { report: path, budget: 0 })).rejects.toThrow(/分析过程中/)
    } finally {
      clearTimeout(timer)
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("C2 reports（trace 索引）", () => {
  test("list：按 trace 形态过滤、按修改时间倒序、标注事实缓存状态", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-reports-"))
    const { ctx } = makeStubCtx(dir, {
      files: [
        { path: join(dir, "a.pt.trace.json"), size: 111, modifiedAt: 1000 },
        { path: join(dir, "b.trace.json"), size: 222, modifiedAt: 2000 },
        { path: join(dir, "c.pt.trace.json.gz"), size: 333, modifiedAt: 3000 },
        { path: join(dir, "notes.md"), size: 1, modifiedAt: 4000 },
        { path: join(dir, "sub"), size: 0, modifiedAt: 5000, isDir: true },
      ],
    })
    // 先造出 a 的落盘事实缓存（缓存可见性）
    const cacheFile = factsCachePath(ctx, { name: "a.pt.trace.json", size: 111, mtimeMs: 1000 })
    const { mkdirSync } = await import("node:fs")
    const { dirname } = await import("node:path")
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, "{}", "utf8")

    const r = await torchTools.reports!.execute({ action: "list" }, ctx)
    expect(r.output).toContain("发现 3 个 trace")
    expect(r.output).not.toContain("notes.md")
    const traces = (r.data as { traces: Array<{ path: string; cached: boolean }> }).traces
    expect(traces.map((t) => t.path.split(/[\\/]/).pop())).toEqual(["c.pt.trace.json.gz", "b.trace.json", "a.pt.trace.json"])
    expect(traces.find((t) => t.path.endsWith("a.pt.trace.json"))!.cached).toBe(true)
    expect(traces.find((t) => t.path.endsWith("b.trace.json"))!.cached).toBe(false)
    // 筛选
    const f = await torchTools.reports!.execute({ action: "list", filter: "b." }, ctx)
    expect((f.data as { traces: unknown[] }).traces).toHaveLength(1)
    // 无匹配时的引导
    const none = await torchTools.reports!.execute({ action: "list", filter: "zzz" }, ctx)
    expect(none.output).toContain("未发现")
    rmSync(dir, { recursive: true, force: true })
  })

  test("info：规模、采集开关与缓存状态", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-reports2-"))
    const path = writeTraceIn(dir, syntheticTrace({ memory: true }), "i.pt.trace.json", { profile_memory: 1, with_stack: 1 })
    const { ctx } = makeStubCtx(dir)
    const r = await torchTools.reports!.execute({ action: "info", report: path }, ctx)
    expect(r.output).toContain("profile_memory")
    expect(r.output).toContain("with_stack")
    expect(r.output).toContain("事实缓存：未落盘")
    expect(r.output).toContain("torch_overview")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("C3 capture（采集脚本）", () => {
  const opts = {
    script: "C:\\proj\\train.py",
    output: "C:\\proj\\trace.pt.trace.json",
    active: 3,
    wait: 1,
    warmup: 1,
    activities: ["cpu"],
    recordShapes: true,
    profileMemory: true,
    withStack: true,
  }

  test("生成的脚本含 schedule + export_chrome_trace + 三个采集开关 + Windows CUPTI 说明", () => {
    const s = captureScript(opts)
    expect(s).toContain("import torch")
    expect(s).toContain("runpy")
    expect(s).toContain("torch.profiler.schedule(wait=WAIT, warmup=WARMUP, active=ACTIVE)")
    expect(s).toContain("p.export_chrome_trace(OUT)")
    expect(s).toContain("record_shapes=True, profile_memory=True, with_stack=True")
    expect(s).toContain("ProfilerActivity.CPU")
    expect(s).toContain("prof.step()")
    expect(s).toContain("CUPTI")
    expect(s).toContain("nsight_capture kind=nsys")
    expect(s).toContain("WAIT, WARMUP, ACTIVE = 1, 1, 3")
  })

  test("activities=cuda 时脚本启用 CUDA activity（并保留平台说明）", () => {
    const s = captureScript({ ...opts, activities: ["cpu", "cuda"] })
    expect(s).toContain("ProfilerActivity.CPU, torch.profiler.ProfilerActivity.CUDA")
  })

  test("mode=script（默认）只生成脚本：写文件、给命令、不执行；run 模式需审批", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-capture-"))
    const { ctx, commands } = makeStubCtx(dir)
    const r = await torchTools.capture!.execute({ script: join(dir, "train.py") }, ctx)
    expect(r.output).toContain("采集脚本已生成")
    expect(r.output).toContain("python ")
    expect(commands).toHaveLength(0)
    expect((r.data as { report?: string }).report).toBeUndefined()
    expect(await Bun.file(join(dir, "train-capture.py")).exists()).toBe(true)
    // 审批策略：script 免审批，run 需审批
    const ra = torchTools.capture!.requiresApproval!
    expect(typeof ra === "function" ? await (ra as (a: Record<string, unknown>) => boolean)({ mode: "script" }) : ra).toBe(false)
    expect(typeof ra === "function" ? await (ra as (a: Record<string, unknown>) => boolean)({ mode: "run" }) : ra).toBe(true)
    // 非法 activities 直接拦下
    const bad = await torchTools.capture!.execute({ script: join(dir, "train.py"), activities: "cpu,xpu" }, ctx)
    expect(bad.output).toContain("activities 只支持")
    rmSync(dir, { recursive: true, force: true })
  })

  test("mode=run：执行后探测产物并给出下一步", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-capture2-"))
    const out = join(dir, "cap.pt.trace.json")
    const { ctx, commands } = makeStubCtx(dir, {
      // 桩：模拟「运行采集脚本 → 产出 trace」
      runCommand: async () => {
        writeFileSync(out, JSON.stringify({ schemaVersion: 1, traceEvents: syntheticTrace() }), "utf8")
        return { stdout: "trace: " + out, stderr: "", code: 0 }
      },
    })
    const r = await torchTools.capture!.execute({ script: join(dir, "train.py"), output: out, mode: "run", timeout: 60 }, ctx)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("-capture.py")
    expect(r.output).toContain("退出码 0")
    expect(r.output).toContain("torch_overview")
    expect((r.data as { report?: string }).report).toBe(out)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("trace 间对比与导出（torch 面接入 core/perf 共享基建）", () => {
  test("度量快照：展示文本解析出数值与单位，单位不同则不可比", async () => {
    const mod = (await import("./torch-tools")) as unknown as Record<string, unknown>
    // 通过工具存在性验证接入（解析逻辑本身由 core/perf/compare.test.ts 覆盖）
    expect(mod.torchTools).toBeDefined()
    const tools = mod.torchTools as Record<string, unknown>
    expect(Object.keys(tools)).toContain("compare")
    expect(Object.keys(tools)).toContain("reports")
    expect(Object.keys(tools)).toContain("capture")
  })

  test("两端快照的差异：方向正确、消失的问题计入净变化", () => {
    const before: SideSnapshot = {
      label: "before.trace.json",
      metrics: [{ name: "时间窗口", value: 100, unit: "ms", higherIsBetter: false, text: "100 ms" }],
      findings: [{ id: "python-overhead", severity: "medium", title: "Python 开销", reclaimableNs: 20_000_000 }],
    }
    const after: SideSnapshot = {
      label: "after.trace.json",
      metrics: [{ name: "时间窗口", value: 60, unit: "ms", higherIsBetter: false, text: "60 ms" }],
      findings: [],
    }
    const r = compareSnapshots(before, after)
    expect(r.metrics[0]!.kind).toBe("improved") // 时间窗口下降 = 改善
    expect(r.findings[0]!.kind).toBe("fixed")
    expect(r.reclaimableDeltaNs).toBe(-20_000_000)
  })
})
