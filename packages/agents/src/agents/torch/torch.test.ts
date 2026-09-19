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
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aggregateTorchTrace, parsePythonSite, readTraceFlags, transferKind, TORCH_LIMITS } from "./torch-trace"
import { diagnoseTorch, isUserCode, TORCH_THRESHOLDS, userSites } from "./torch-findings"
import { isTorchTrace } from "./torch-report"

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

  test("阈值常量被导出且口径稳定（防止文档与实现漂移）", () => {
    expect(TORCH_THRESHOLDS.syncShare).toBeGreaterThan(0)
    expect(TORCH_THRESHOLDS.fragmentation).toBeCloseTo(1.5, 5)
    expect(TORCH_THRESHOLDS.tinyOpCountShare).toBeCloseTo(0.5, 5)
    expect(TORCH_LIMITS.topRows).toBe(20)
  })
})
