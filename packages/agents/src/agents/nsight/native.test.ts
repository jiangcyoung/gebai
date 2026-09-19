/**
 * 原生边车聚合与 JS 流式实现的**等价性测试**（双实现的一致性保证）。
 *
 * 本子Agent 的聚合有两条实现：宿主 JS 流式（回退路径，服务端部署下唯一可用）与原生边车
 * （Rust + 内嵌 SQLite，本地形态优先）。两者输出同构是正确性前提——测试用同一份合成事件库
 * 分别跑两条路径，逐字段比对核心指标（规模、耗时、并集、空闲缝、并发、传输、分组）。
 *
 * 未构建原生边车（`keqing/rust/target/release/nsight`）时跳过原生侧断言——CI 或无 cargo 环境下
 * 仍验证 JS 路径与回退行为。
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { coerceNativeFacts, computeTimelineFacts, resolveTimelineFacts } from "./nsys-analysis"
import { _resetFactsCache } from "../../core/perf/agg"
import { makeSyntheticReport, nativeBinaryPath } from "./test-fixture"
import { makeStubCtx } from "../../core/perf/test-ctx"

/** 按 keqing NDJSON 协议调用原生 aggregate 工具，取回结构化聚合结果。 */
async function callNativeAggregate(exe: string, sqlite: string): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([exe], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const killer = setTimeout(() => proc.kill(), 60_000)
  proc.stdin.write(JSON.stringify({ id: 1, op: "init" }) + "\n")
  proc.stdin.write(
    JSON.stringify({
      id: 2,
      op: "tool.call",
      tool: "aggregate",
      args: { sqlite },
      ctx: { cwd: "", sessionId: "t", user: "t", env: {}, sandboxed: false },
    }) + "\n",
  )
  // NDJSON 循环读到 stdin EOF 才退出：写完即关写入端
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  clearTimeout(killer)
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean)
  const call = lines
    .map((l) => JSON.parse(l) as { id?: number; ok?: boolean; result?: { data?: Record<string, unknown> }; error?: string })
    .find((m) => m.id === 2)
  if (!call) throw new Error(`边车无响应（stderr: ${stderr.slice(0, 200)}）`)
  if (call.ok === false) throw new Error(`边车报错：${call.error}`)
  const data = call.result?.data
  if (!data) throw new Error("边车未返回结构化数据")
  return data
}

const nativeExe = nativeBinaryPath()
const nativeAvailable = nativeExe !== null && existsSync(nativeExe)

describe("原生边车聚合 vs JS 流式实现（等价性）", () => {
  test.skipIf(!nativeAvailable)("核心指标逐字段一致", async () => {
    const fixture = await makeSyntheticReport()
    try {
      const nativeRaw = await callNativeAggregate(nativeExe!, fixture.sqlitePath)
      const native = coerceNativeFacts(nativeRaw)
      const js = computeTimelineFacts(fixture.report)
      // 逐字段比对：规模 / 时间 / 并集 / 空闲缝 / 并发 / 传输 / 分组
      expect(native.kernelInstances).toBe(js.kernelInstances)
      expect(native.kernelDistinctGroups).toBe(js.kernelDistinctGroups)
      expect(native.kernelTotalNs).toBe(js.kernelTotalNs)
      expect(native.busyNs).toBe(js.busyNs)
      expect(native.firstActivityNs).toBe(js.firstActivityNs)
      expect(native.lastActivityNs).toBe(js.lastActivityNs)
      expect(native.windowNs).toBe(js.windowNs)
      expect(native.maxConcurrent).toBe(js.maxConcurrent)
      expect(native.gapCount).toBe(js.gapCount)
      expect(native.gapTotalNs).toBe(js.gapTotalNs)
      expect(native.memcpyCount).toBe(js.memcpyCount)
      expect(native.memcpyTotalNs).toBe(js.memcpyTotalNs)
      expect(native.memcpyBytes).toBe(js.memcpyBytes)
      // 每卡分解（多卡正确性的两实现一致性）
      expect(native.deviceCount).toBe(js.deviceCount)
      expect(native.devices.map((d) => [d.deviceId, d.busyNs, d.utilization, d.maxConcurrent, d.kernelInstances])).toEqual(
        js.devices.map((d) => [d.deviceId, d.busyNs, d.utilization, d.maxConcurrent, d.kernelInstances]),
      )
      // 传输方向（含 memset 的独立方向名）
      expect(native.memcpyKinds.map((k) => k.kind)).toEqual(js.memcpyKinds.map((k) => k.kind))
      expect(native.streams.length).toBe(js.streams.length)
      expect(native.smallKernelInstances).toBe(js.smallKernelInstances)
      expect(native.sessionStartUtc).toBe(js.sessionStartUtc)
      // 空闲缝明细（起点/终点/时长）
      expect(native.gaps.map((g) => [g.start, g.end])).toEqual(js.gaps.map((g) => [g.start, g.end]))
      // 热点内核（名称/调用次数/总耗时/几何）
      const nk = native.kernels[0]!
      const jk = js.kernels[0]!
      expect(nk.name).toBe(jk.name)
      expect(nk.instances).toBe(jk.instances)
      expect(nk.totalNs).toBe(jk.totalNs)
      expect(nk.grid).toEqual(jk.grid)
      expect(nk.block).toEqual(jk.block)
      // 传输方向聚合（含枚举标签解析）
      expect(native.memcpyKinds.map((k) => k.kind)).toEqual(js.memcpyKinds.map((k) => k.kind))
      expect(native.memcpyKinds.map((k) => k.count)).toEqual(js.memcpyKinds.map((k) => k.count))
      // 时间线占用序列（分桶数与取值范围一致；数值允许浮点尾差）
      expect(native.timeline.length).toBe(js.timeline.length)
      for (let i = 0; i < native.timeline.length; i++) {
        expect(Math.abs(native.timeline[i]! - js.timeline[i]!)).toBeLessThan(1e-9)
      }
      // 归类排行（名称集合一致）
      expect(native.undersizedGroups.map((g) => g.name).sort()).toEqual(js.undersizedGroups.map((g) => g.name).sort())
      expect(native.pressuredGroups.map((g) => g.name).sort()).toEqual(js.pressuredGroups.map((g) => g.name).sort())
    } finally {
      fixture.report.close()
    }
  })

  test.skipIf(!nativeAvailable)("原生返回值缺失字段时抛错（保证回退而非脏数据）", async () => {
    const fixture = await makeSyntheticReport()
    try {
      const raw = await callNativeAggregate(nativeExe!, fixture.sqlitePath)
      expect(() => coerceNativeFacts({ ...raw, busyNs: undefined })).toThrow("busyNs")
      expect(() => coerceNativeFacts({ ...raw, gaps: "not-array" })).toThrow("gaps")
    } finally {
      fixture.report.close()
    }
  })
})

describe("resolveTimelineFacts（原生优先 + 自动回退）", () => {
  test("原生后端未注册时回退 JS 并在结果中说明原因", async () => {
    _resetFactsCache()
    const fixture = await makeSyntheticReport()
    try {
      const resolved = await resolveTimelineFacts(fixture.report)
      // 桩 ctx 的 registry.resolve 恒返回 undefined → 走 JS 路径
      expect(resolved.source).toBe("js")
      expect(resolved.nativeError).toContain("原生边车未注册")
      expect(resolved.facts.kernelInstances).toBeGreaterThan(0)
      expect(resolved.elapsedMs).toBeGreaterThanOrEqual(0)
    } finally {
      fixture.report.close()
    }
  })

  test("NSIGHT_NATIVE=off 时不尝试原生（显式关闭通道）", async () => {
    _resetFactsCache()
    const fixture = await makeSyntheticReport()
    try {
      fixture.report.ctx = makeStubCtx(fixture.root, { env: { NSIGHT_NATIVE: "off" } }).ctx
      const resolved = await resolveTimelineFacts(fixture.report)
      expect(resolved.source).toBe("js")
      expect(resolved.nativeError).toBeUndefined()
    } finally {
      fixture.report.close()
    }
  })

  test("结果按报告指纹缓存：同报告二次调用复用同一对象", async () => {
    _resetFactsCache()
    const fixture = await makeSyntheticReport()
    try {
      const first = await resolveTimelineFacts(fixture.report)
      const second = await resolveTimelineFacts(fixture.report)
      expect(second).toBe(first)
    } finally {
      fixture.report.close()
    }
  })
})
