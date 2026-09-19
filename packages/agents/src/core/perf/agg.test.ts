/**
 * 流式聚合原语的测试（共享基建自带测试）：区间并集/最大并发/空闲缝、自适应分桶、Top-K 与受控采样。
 * 这些原语被各分析面共用，正确性与有界性在此锁定。
 */
import { describe, expect, test } from "bun:test"
import { AdaptiveBins, IntervalUnionStreamer, TopK, ValueSampler, maxConcurrencyExact, _resetFactsCache } from "./agg"

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

