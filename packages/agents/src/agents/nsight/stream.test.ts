/**
 * 流式聚合与诊断规则的单元测试：不依赖 GPU / nsys / ncu——用合成数据锁定正确性。
 * 覆盖：区间并集与并发、空闲缝、自适应分桶、Top-K 有界性、采样分位数、诊断规则命中与阈值边界。
 */
import { describe, expect, test } from "bun:test"
import { AdaptiveBins, IntervalUnionStreamer, TopK, ValueSampler, maxConcurrencyExact, _resetFactsCache } from "./stream"
import { diagnoseNsys, shortSymbol, FINDING_THRESHOLDS } from "./findings"
import type { ApiFacts, NvtxFacts, SyncFacts, TimelineFacts } from "./nsys-analysis"
import { diagnoseNcu, metricNum, accessEfficiencyText, type NcuKernel, type NcuSourceAggregate } from "./ncu-analysis"

describe("IntervalUnionStreamer（区间并集/并发/空闲缝）", () => {
  test("重叠区间只计一次忙碌，并集边界连续则不报空闲缝", () => {
    const s = new IntervalUnionStreamer(50_000)
    s.add(0, 100)
    s.add(50, 200) // 与前一个重叠
    s.add(200, 300) // 紧邻
    const r = s.result()
    expect(r.busyNs).toBe(300)
    expect(r.spanNs).toBe(300)
    expect(r.utilization).toBe(1)
    expect(r.gaps.length).toBe(0)
  })

  test("超过阈值的间隔记为空闲缝，并按间隔降序返回", () => {
    const s = new IntervalUnionStreamer(1_000)
    s.add(0, 1_000)
    s.add(5_000, 6_000) // 空闲 4000
    s.add(20_000, 21_000) // 空闲 14000
    const r = s.result()
    expect(r.gaps.length).toBe(2)
    expect(r.gaps[0]!.end - r.gaps[0]!.start).toBe(14_000)
    expect(r.gaps[1]!.end - r.gaps[1]!.start).toBe(4_000)
    expect(r.busyNs).toBe(3_000)
  })

  test("小于阈值的间隔不记为空闲缝", () => {
    const s = new IntervalUnionStreamer(1_000)
    s.add(0, 100)
    s.add(500, 600) // 间隔 400 < 阈值
    expect(s.result().gaps.length).toBe(0)
  })

  test("最大并发由结束时间小顶堆精确计算（与参考实现一致）", () => {
    const intervals = [
      { start: 0, end: 100 },
      { start: 10, end: 50 },
      { start: 20, end: 30 },
      { start: 200, end: 300 },
    ]
    const s = new IntervalUnionStreamer(0)
    for (const iv of intervals) s.add(iv.start, iv.end)
    expect(s.result().maxConcurrent).toBe(3)
    expect(s.result().maxConcurrent).toBe(maxConcurrencyExact(intervals))
  })

  test("空闲缝数量达上限时标记截断（不无界增长）", () => {
    const s = new IntervalUnionStreamer(1, 3)
    for (let i = 0; i < 10; i++) {
      s.add(i * 100, i * 100 + 10)
    }
    const r = s.result()
    expect(r.gaps.length).toBe(3)
    expect(r.gapsTruncated).toBe(true)
  })
})

describe("AdaptiveBins（自适应分辨率时间线）", () => {
  test("单趟统计占用率，桶数恒定封顶", () => {
    const bins = new AdaptiveBins(16, 100)
    for (let i = 0; i < 100; i++) bins.add(i * 100, i * 100 + 50) // 每个 100ns 桶占 50%
    const series = bins.occupancySeries(8)
    expect(series.series.length).toBeLessThanOrEqual(8)
    expect(series.series.every((v) => v >= 0 && v <= 1)).toBe(true)
    const avg = series.series.reduce((a, b) => a + b, 0) / series.series.length
    expect(avg).toBeGreaterThan(0.4)
    expect(avg).toBeLessThanOrEqual(0.6)
  })

  test("跨度远大于初始分辨率时自动倍粗（内存不随跨度增长）", () => {
    const bins = new AdaptiveBins(8, 100)
    bins.add(0, 50)
    bins.add(1_000_000_000, 1_000_000_100) // 跨度极大
    const series = bins.occupancySeries(4)
    expect(series.series.length).toBeLessThanOrEqual(4)
    expect(series.resolutionNs).toBeGreaterThan(100)
  })
})

describe("TopK / ValueSampler（结果有界）", () => {
  test("TopK 容量恒定并保留权重最大的项", () => {
    const top = new TopK<{ name: string; w: number }>(3, (v) => v.name, (v) => v.w)
    for (let i = 0; i < 100; i++) top.add({ name: `k${i}`, w: i })
    expect(top.size).toBe(3)
    expect(top.toArray().map((v) => v.name)).toEqual(["k99", "k98", "k97"])
  })

  test("ValueSampler 超出容量后转为抽样并如实标记，分位数仍接近真值", () => {
    const s = new ValueSampler(100)
    for (let i = 1; i <= 1_000; i++) s.add(i)
    expect(s.count).toBe(1_000)
    expect(s.isSampled).toBe(true)
    const median = s.quantile(0.5)
    expect(median).toBeGreaterThan(400)
    expect(median).toBeLessThan(600)
  })
})

describe("diagnoseNsys（时间线诊断规则）", () => {
  const baseFacts = (over: Partial<TimelineFacts> = {}): TimelineFacts => ({
    sessionStartUtc: "2026-01-01T00:00:00",
    firstActivityNs: 0,
    lastActivityNs: 1_000_000_000,
    windowNs: 1_000_000_000,
    busyNs: 200_000_000,
    utilization: 0.2,
    maxConcurrent: 1,
    gaps: [{ start: 200_000_000, end: 1_000_000_000, durNs: 800_000_000 }],
    gapsTruncated: false,
    gapCount: 1,
    gapTotalNs: 800_000_000,
    timeline: [0.2, 0.1],
    timelineSpanNs: 1_000_000_000,
    kernels: [
      {
        name: "void myKernel<float>(float*, int)",
        mangled: "_Z8myKernelIfEvPfi",
        instances: 10,
        totalNs: 150_000_000,
        avgNs: 15_000_000,
        minNs: 14_000_000,
        maxNs: 16_000_000,
        p50Ns: 15_000_000,
        p50Sampled: false,
        grid: [100, 1, 1],
        block: [256, 1, 1],
        registersPerThread: 32,
        smemBytes: 1024,
        streams: [1],
        threadsPerBlock: 256,
        gridBlocks: 100,
        totalThreads: 25_600,
      },
    ],
    kernelDistinctGroups: 1,
    kernelInstances: 10,
    kernelTotalNs: 150_000_000,
    smallKernelInstances: 0,
    smallKernelTotalNs: 0,
    smallKernelGroups: [],
    undersizedGroups: [{ name: "void myKernel<float>(float*, int)", instances: 10, totalNs: 150_000_000, grid: [100, 1, 1], block: [256, 1, 1], totalThreads: 25_600 }],
    pressuredGroups: [],
    streams: [{ streamId: 1, kernelInstances: 10, kernelTotalNs: 150_000_000, memcpyCount: 0, memcpyBytes: 0, firstStart: 0, lastEnd: 200_000_000 }],
    memcpyKinds: [],
    memcpyCount: 0,
    memcpyTotalNs: 0,
    memcpyBytes: 0,
    memcpySlowest: [],
    launchGaps: [{ from: "a", to: "b", streamId: 1, gapNs: 200_000 }],
    kernelDurationSampler: new ValueSampler(100),
    ...over,
  })

  const emptyApi = (): ApiFacts => ({ count: 0, totalNs: 0, top: [], slowest: [], blocking: [] })
  const emptySync = (): SyncFacts => ({ count: 0, totalNs: 0, byKind: [], longest: [] })
  const emptyNvtx = (): NvtxFacts => ({ available: true, count: 0, top: [] })

  test("低利用率 + 空闲缝 + 小网格 → 命中对应规则并给出可回收时间", () => {
    _resetFactsCache()
    const d = diagnoseNsys({ facts: baseFacts(), api: emptyApi(), sync: emptySync(), nvtx: emptyNvtx(), devices: [] })
    const ids = d.findings.map((f) => f.id)
    expect(ids).toContain("gpu-idle")
    expect(ids).toContain("grid-undersized")
    expect(ids).toContain("no-concurrency")
    const idle = d.findings.find((f) => f.id === "gpu-idle")!
    expect(idle.reclaimableNs).toBe(800_000_000)
    // 严重度：空闲占比 80% > 50% → critical
    expect(idle.severity).toBe("critical")
    // 验证证据里带实测值
    expect(idle.evidence.join(" ")).toContain("20.0%")
  })

  test("同步阻塞命中：等待占比超过阈值或单次超过 1ms", () => {
    const sync: SyncFacts = { count: 5, totalNs: 300_000_000, byKind: [{ kind: "Context sync", count: 5, totalNs: 300_000_000 }], longest: [{ kind: "Context sync", durNs: 250_000_000, start: 0 }] }
    const api: ApiFacts = { count: 5, totalNs: 300_000_000, top: [], slowest: [], blocking: [{ name: "cudaDeviceSynchronize_v3020", count: 5, totalNs: 300_000_000, maxNs: 250_000_000 }] }
    const d = diagnoseNsys({ facts: baseFacts({ utilization: 0.9, gapTotalNs: 0, gaps: [], gapCount: 0 }), api, sync, nvtx: emptyNvtx(), devices: [] })
    const f = d.findings.find((x) => x.id === "sync-stall")!
    expect(f).toBeDefined()
    expect(f.reclaimableNs).toBe(300_000_000)
    expect(f.symbols.some((s) => s.kind === "api")).toBe(true)
  })

  test("热点集中 + 传输小包 → 命中规则；稀疏报告不臆造问题", () => {
    const facts = baseFacts({
      utilization: 0.95,
      gapTotalNs: 0,
      gaps: [],
      gapCount: 0,
      memcpyCount: 20,
      memcpyTotalNs: 40_000_000,
      memcpyBytes: 1_000_000,
      memcpyKinds: [{ kind: "Device-to-Host", count: 20, totalNs: 40_000_000, bytes: 1_000_000, avgBytes: 50_000 }],
    })
    const d = diagnoseNsys({ facts, api: emptyApi(), sync: emptySync(), nvtx: emptyNvtx(), devices: [] })
    const ids = d.findings.map((f) => f.id)
    expect(ids).toContain("hot-kernel")
    expect(ids).toContain("transfer-inefficient")
    // 无空闲、无同步、单流单内核且调用次数 < 3 时不报 no-concurrency
    expect(d.metrics["GPU 利用率"]).toBe("95.0%")
  })

  test("未采集维度如实列入 skipped", () => {
    const d = diagnoseNsys({
      facts: baseFacts({ kernelInstances: 0, kernels: [], kernelTotalNs: 0, kernelDistinctGroups: 0 }),
      api: emptyApi(),
      sync: emptySync(),
      nvtx: { available: false, count: 0, top: [] },
      devices: [],
    })
    expect(d.skipped.join(" ")).toContain("无内核事件")
    expect(d.skipped.join(" ")).toContain("无同步事件")
    expect(d.skipped.join(" ")).toContain("NVTX")
  })

  test("阈值常量与规则口径一致（防止文档与实现漂移）", () => {
    expect(FINDING_THRESHOLDS.lowUtilization).toBe(0.6)
    expect(FINDING_THRESHOLDS.syncStallNs).toBe(1_000_000)
  })

  test("长符号截断：证据文本不随 demangled 名长度膨胀", () => {
    const long = `void at::native::vectorized_elementwise_kernel<4, ${"x".repeat(500)}>(int, T)`
    const s = shortSymbol(long)
    expect(s.length).toBeLessThan(120)
    expect(s).toContain("字符)")
    expect(shortSymbol("short_name")).toBe("short_name")
  })
})

describe("diagnoseNcu（Nsight Compute 诊断）", () => {
  const kernel = (over: Partial<NcuKernel> = {}): NcuKernel => ({
    id: "0",
    kernelName: "myKernel(float*, int)",
    processName: "app",
    device: "0",
    computeCap: "8.9",
    gridSize: "(1024, 1, 1)",
    blockSize: "(256, 1, 1)",
    sections: {
      "GPU Speed Of Light Throughput": {
        "Memory Throughput": "95.00 %",
        "DRAM Throughput": "95.00 %",
        "Compute (SM) Throughput": "20.00 %",
        "L1/TEX Cache Throughput": "30.00 %",
        "L2 Cache Throughput": "40.00 %",
        "Duration": "100.00 us",
      },
      Occupancy: { "Achieved Occupancy": "25.00 %", "Theoretical Occupancy": "50.00 %", "Block Limit Registers": "4 block", "Block Limit Shared Mem": "16 block" },
      "Source Counters": { "Branch Efficiency": "60.00 %", "Avg. Divergent Branches": "1.50" },
    },
    rules: [
      { name: "UncoalescedAccess", type: "OPT", description: "Accesses are not coalesced.", speedup: "global/25.00" },
      { name: "SOLBottleneck", type: "INF", description: "Utilizing greater than 80% of DRAM." },
    ],
    ...over,
  })

  const source: NcuSourceAggregate = {
    stallTotals: { long_sb: 800, barrier: 200 },
    excessSectors: 5_000_000,
    idealSectors: 1_000_000,
    bankConflicts: 0,
    bankWavefrontsExcessive: 0,
    hotspots: [{ address: "0x100", instruction: "LDG.E R0, [R2]", samples: 500, stalls: { long_sb: 500 }, excessSectors: 4_000_000 }],
    instructionRows: 120,
    hasSourceCorrelation: false,
    sourceFiles: [],
  }

  test("官方规则按预估收益分级，并保留原始描述", () => {
    const d = diagnoseNcu(kernel(), source)
    const rule = d.findings.find((f) => f.id === "rule:UncoalescedAccess")!
    expect(rule.official).toBe(true)
    expect(rule.severity).toBe("high") // 25 > 20
    expect(rule.estimatedSpeedup).toBe("global/25.00")
    expect(d.findings.find((f) => f.id === "rule:SOLBottleneck")!.severity).toBe("info")
  })

  test("SOL 判定瓶颈单元；访存效率与非合并访问命中；停顿主因命中", () => {
    const d = diagnoseNcu(kernel(), source)
    expect(d.bottleneck).toContain("显存带宽")
    const ids = d.findings.map((f) => f.id)
    expect(ids).toContain("sol-bottleneck")
    expect(ids).toContain("uncoalesced-access")
    expect(ids).toContain("stall-dominant")
    expect(ids).toContain("low-occupancy")
    expect(ids).toContain("branch-divergence")
    const acc = d.findings.find((f) => f.id === "uncoalesced-access")!
    expect(acc.title).toContain("6.00 倍")
    expect(acc.evidence.join(" ")).toContain("越界扇区")
  })

  test("合并访问 + 高占用时不误报", () => {
    const clean = kernel({
      sections: {
        ...kernel().sections,
        Occupancy: { "Achieved Occupancy": "85.00 %", "Theoretical Occupancy": "100.00 %" },
        "Source Counters": { "Branch Efficiency": "100.00 %", "Avg. Divergent Branches": "0.00" },
      },
      rules: [],
    })
    const d = diagnoseNcu(clean, { ...source, excessSectors: 0, idealSectors: 1_000_000, stallTotals: {}, hotspots: [] })
    const ids = d.findings.map((f) => f.id)
    expect(ids).not.toContain("uncoalesced-access")
    expect(ids).not.toContain("low-occupancy")
    expect(ids).not.toContain("branch-divergence")
  })

  test("指标取值与访存效率文本", () => {
    expect(metricNum(kernel(), "GPU Speed Of Light Throughput", "Memory Throughput")).toBe(95)
    expect(metricNum(kernel(), "Occupancy", "Missing")).toBeUndefined()
    expect(accessEfficiencyText(source)).toContain("6.00×")
  })
})
