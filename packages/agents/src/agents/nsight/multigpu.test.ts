/**
 * 多卡与 memset 的正确性测试（nsight 时间线聚合）。
 *
 * 背景：把多张 GPU 的活动合并成一条时间线会**掩盖单卡停滞**——A 卡空闲而 B 卡在忙时，
 * 合并口径下看不到空闲。本测试用合成的两卡事件库锁定三条约束：
 * 1. 顶层字段仍是「任一卡在忙」的合并口径（单卡行为不变，向后兼容）；
 * 2. `devices[]` 给出**每卡**的利用率/空闲缝/并发——A 卡的空闲不会被 B 卡的忙碌掩盖；
 * 3. memset 计入 GPU 活动（否则 memset 密集负载的利用率被低估）。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"
import type { ReportDb } from "./db"
import { computeTimelineFacts, overheadFacts, timelineFacts } from "./nsys-analysis"
import { diagnoseNsys } from "./findings"
import type { ApiFacts, NvtxFacts, SyncFacts } from "./nsys-analysis"

const emptyApi = (): ApiFacts => ({ count: 0, totalNs: 0, top: [], slowest: [], blocking: [] })
const emptySync = (): SyncFacts => ({ count: 0, totalNs: 0, byKind: [], longest: [] })
const emptyNvtx = (): NvtxFacts => ({ available: false, count: 0, top: [] })

const schema = `
CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
  start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER, correlationId INTEGER,
  demangledName INTEGER, shortName INTEGER, mangledName INTEGER, registersPerThread INTEGER,
  gridX INTEGER, gridY INTEGER, gridZ INTEGER, blockX INTEGER, blockY INTEGER, blockZ INTEGER,
  staticSharedMemory INTEGER, dynamicSharedMemory INTEGER
);
CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY (start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER, bytes INTEGER, copyKind INTEGER);
CREATE TABLE CUPTI_ACTIVITY_KIND_MEMSET (start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER, bytes INTEGER);
CREATE TABLE ENUM_CUDA_MEMCPY_OPER (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
CREATE TABLE PROFILER_OVERHEAD (start INTEGER, end INTEGER, globalTid INTEGER, nameId INTEGER, returnValue INTEGER);
`

/** 建一个空事件库并返回 ReportDb（列集与真实 nsys 导出同形）。 */
async function makeDb(rows: { name: string; sql: string }[]): Promise<{ report: ReportDb; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "gebai-nsight-multigpu-"))
  const path = join(dir, "report.sqlite")
  const { Database: Db } = (await import("bun:sqlite")) as unknown as { Database: new (p: string) => Database }
  const db = new Db(path)
  for (const stmt of schema.split(";").map((s) => s.trim()).filter(Boolean)) db.run(stmt)
  db.run("INSERT INTO StringIds (id, value) VALUES (1, 'gpuKernel(float*)'), (2, '_Z9gpuKernelPf')")
  db.run("INSERT INTO ENUM_CUDA_MEMCPY_OPER (id, name, label) VALUES (1, 'CUDA_MEMCPY_KIND_HTOD', 'Host-to-Device')")
  for (const r of rows) db.run(r.sql)
  const report = {
    db: db as unknown as ReportDb["db"],
    ref: { path, name: "report.sqlite", stem: "multigpu", kind: "nsys", size: 1, mtimeMs: 1 },
    dir,
    sqlitePath: path,
    ctx: undefined as never,
    importNote: "",
    close: () => db.close(),
  } satisfies ReportDb
  return { report, close: () => db.close() }
}

describe("多卡时间线（deviceId 分流）", () => {
  test("每卡利用率/空闲缝独立：A 卡空闲不被 B 卡忙碌掩盖", async () => {
    // 时间窗 0..1000（µs）：卡 0 只在 0..100 忙（10%），卡 1 只在 500..1000 忙（50%）
    const { report, close } = await makeDb([
      { name: "k0", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 100000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "k1", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (500000, 1000000, 1, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 2)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      expect(facts.deviceCount).toBe(2)
      const d0 = facts.devices.find((d) => d.deviceId === 0)!
      const d1 = facts.devices.find((d) => d.deviceId === 1)!
      // 每卡忙碌时长各自独立
      expect(d0.busyNs).toBe(100_000)
      expect(d1.busyNs).toBe(500_000)
      // 利用率按同一全局窗口（卡间可比）：10% 与 50%
      expect(d0.utilization).toBeCloseTo(0.1, 5)
      expect(d1.utilization).toBeCloseTo(0.5, 5)
      // 顶层是合并口径：「任一卡在忙」= 600/1000（不是 100% 也不是任一单卡）
      expect(facts.busyNs).toBe(600_000)
      expect(facts.utilization).toBeCloseTo(0.6, 5)
      // 关键：卡 0 的空闲必须可见——单活动设备无「卡内间隙」，空闲体现在利用率（10% vs 合并口径）
      expect(d0.utilization).toBeLessThan(d1.utilization)
      expect(d0.gapTotalNs).toBe(0)
      // 并发按卡计（跨卡合并会把「两卡各跑一个」误算成并发 2）
      expect(d0.maxConcurrent).toBe(1)
      expect(d1.maxConcurrent).toBe(1)
      // 每卡占用序列非空且有界（分辨率按该卡自身跨度自适应，故点数不必与顶层相同）
      expect(d0.timeline.length).toBeGreaterThan(0)
      expect(d0.timeline.length).toBeLessThanOrEqual(1024)
    } finally {
      close()
    }
  })

  test("卡内间隙按卡统计（同卡两段活动之间的缝隙）", async () => {
    // 卡 0：两段活动 0..100 与 800..900，中间 700µs 是卡 0 自己的停滞
    const { report, close } = await makeDb([
      { name: "k0a", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 100000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "k0b", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (800000, 900000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 2)" },
      { name: "k1", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (100000, 800000, 1, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 3)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      const d0 = facts.devices.find((d) => d.deviceId === 0)!
      // 卡 0 自己的 700µs 停滞：合并口径下被卡 1 的忙碌完全掩盖（顶层无间隙）
      expect(d0.gapTotalNs).toBe(700_000)
      expect(d0.gapCount).toBe(1)
      expect(facts.gapTotalNs).toBe(0)
    } finally {
      close()
    }
  })

  test("两卡同时繁忙：顶层合并忙碌不重复计时，每卡仍各自计数", async () => {
    const { report, close } = await makeDb([
      { name: "k0", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 400000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "k1", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (100000, 500000, 1, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 2)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      // 重叠区间只算一次：合并并集 = 0..500 = 500µs（而非 800µs）
      expect(facts.busyNs).toBe(500_000)
      expect(facts.devices.find((d) => d.deviceId === 0)!.busyNs).toBe(400_000)
      expect(facts.devices.find((d) => d.deviceId === 1)!.busyNs).toBe(400_000)
      // 每卡内核计数各自独立
      expect(facts.devices.find((d) => d.deviceId === 0)!.kernelInstances).toBe(1)
      expect(facts.kernelInstances).toBe(2)
    } finally {
      close()
    }
  })
})

describe("采集开销按窗口内外区分（启动成本不是扰动）", () => {
  test("窗口外的开销不计入扰动占比；窗口内开销才判定", async () => {
    // 活动窗口 1_000_000..1_100_000；开销：窗口前 500_000、窗口内 50_000、窗口后 20_000
    const { report, close } = await makeDb([
      { name: "k", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (1000000, 1100000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "ovh-before", sql: "INSERT INTO PROFILER_OVERHEAD (start, end, nameId) VALUES (0, 500000, 1)" },
      { name: "ovh-inside", sql: "INSERT INTO PROFILER_OVERHEAD (start, end, nameId) VALUES (1020000, 1070000, 1)" },
      { name: "ovh-after", sql: "INSERT INTO PROFILER_OVERHEAD (start, end, nameId) VALUES (1200000, 1220000, 1)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      const ovh = overheadFacts(report, { fromNs: facts.firstActivityNs, toNs: facts.lastActivityNs })
      expect(ovh.available).toBe(true)
      expect(ovh.count).toBe(3)
      expect(ovh.totalNs).toBe(570_000)
      // 关键：只有与窗口相交的 50_000 算扰动，启动/退出成本单列
      expect(ovh.inWindowNs).toBe(50_000)
      expect(ovh.beforeWindowNs).toBe(500_000)
      expect(ovh.afterWindowNs).toBe(20_000)
      // 若按总数除以窗口会得出 57%（误导）；按窗口内是 50%
      expect(ovh.inWindowNs / facts.windowNs).toBeCloseTo(0.5, 5)
      // 诊断用的是窗口内口径
      const d = diagnoseNsys({
        facts,
        api: emptyApi(),
        sync: emptySync(),
        nvtx: emptyNvtx(),
        devices: [],
        overhead: ovh,
        graph: { available: false, graphCount: 0, graphTotalNs: 0, nodeCount: 0, note: "未采集图维度" },
      })
      const f = d.findings.find((x) => x.id === "profiler-overhead")
      expect(f).toBeDefined()
      expect(f!.evidence.join(" ")).toContain("窗口外开销")
      expect(d.metrics["采集开销占比（窗口内）"]).toBeDefined()
      // 未采集的 Graph 维度必须如实列入 skipped
      expect(d.skipped.join(" ")).toContain("图")
    } finally {
      close()
    }
  })

  test("窗口外开销大但窗口内干净时不误报扰动", async () => {
    const { report, close } = await makeDb([
      { name: "k", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (1000000, 1100000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "ovh-before", sql: "INSERT INTO PROFILER_OVERHEAD (start, end, nameId) VALUES (0, 900000, 1)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      const ovh = overheadFacts(report, { fromNs: facts.firstActivityNs, toNs: facts.lastActivityNs })
      expect(ovh.inWindowNs).toBe(0)
      const d = diagnoseNsys({ facts, api: emptyApi(), sync: emptySync(), nvtx: emptyNvtx(), devices: [], overhead: ovh })
      expect(d.findings.find((x) => x.id === "profiler-overhead")).toBeUndefined()
    } finally {
      close()
    }
  })
})

describe("时间窗筛选（与活动区间相交即命中）", () => {
  test("窗口只统计区间内的活动，并改变忙碌与利用率", async () => {
    const { report, close } = await makeDb([
      { name: "early", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 100000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "late", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (900000, 1000000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 2)" },
    ])
    try {
      const all = computeTimelineFacts(report)
      expect(all.kernelInstances).toBe(2)
      expect(all.busyNs).toBe(200_000)
      // 只看 500ms~1s：只剩 late 段
      const win = computeTimelineFacts(report, { fromNs: 500_000, toNs: 1_000_000 })
      expect(win.kernelInstances).toBe(1)
      expect(win.busyNs).toBe(100_000)
      // 窗口内首个活动 = 900_000，故窗口就是 900_000..1_000_000（利用率 100%）
      expect(win.firstActivityNs).toBe(900_000)
      expect(win.utilization).toBeCloseTo(1, 5)
      // 与区间相交即命中：跨越窗口边界（起点早于窗口）的活动也要计入
      const cross = computeTimelineFacts(report, { fromNs: 50_000, toNs: 60_000 })
      expect(cross.kernelInstances).toBe(1)
    } finally {
      close()
    }
  })

  test("窗口命中缓存按窗口区分（不同窗口不串用结果）", async () => {
    const { report, close } = await makeDb([
      { name: "k", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 100000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
    ])
    try {
      const a = timelineFacts(report, { fromNs: 0, toNs: 200_000 })
      const b = timelineFacts(report, { fromNs: 500_000, toNs: 600_000 })
      expect(a.kernelInstances).toBe(1)
      expect(b.kernelInstances).toBe(0)
      // 首次结果不被第二次调用污染
      expect(a.kernelInstances).toBe(1)
    } finally {
      close()
    }
  })
})

describe("多卡诊断（findings）", () => {
  test("负载不均衡必须被单独指出：合并利用率正常但某卡空闲", async () => {
    // 窗口 0..1000：卡 0 忙 900µs（90%），卡 1 忙 100µs（10%）→ 合并 100%（看不到卡 1 的闲置）
    const { report, close } = await makeDb([
      { name: "k0", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 900000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
      { name: "k1", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 100000, 1, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 2)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      // 合并口径看着"满负荷"（任一卡在忙 = 窗口全程），单卡利用率才暴露问题
      expect(facts.utilization).toBeCloseTo(1, 5)
      expect(facts.devices.find((d) => d.deviceId === 1)!.utilization).toBeLessThan(0.2)
      const { findings, metrics } = diagnoseNsys({ facts, api: emptyApi(), sync: emptySync(), nvtx: emptyNvtx(), devices: [] })
      const imb = findings.find((f) => f.id === "device-imbalance")
      expect(imb).toBeDefined()
      // 证据里必须给出每卡利用率（不能只给合并值）
      expect(imb!.evidence.join(" ")).toContain("device 1")
      expect(imb!.evidence.join(" ")).toContain("device 0")
      // 摘要里也要按卡展开
      expect(metrics["device 1 利用率"]).toBeDefined()
      expect(imb!.reclaimableNs).toBeGreaterThan(0)
    } finally {
      close()
    }
  })

  test("单卡报告不产生多卡规则（无误报）", async () => {
    const { report, close } = await makeDb([
      { name: "k0", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, registersPerThread, correlationId) VALUES (0, 1000000, 0, 1, 1, 1, 2, 64, 1, 1, 256, 1, 1, 0, 0, 32, 1)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      const { findings } = diagnoseNsys({ facts, api: emptyApi(), sync: emptySync(), nvtx: emptyNvtx(), devices: [] })
      expect(findings.find((f) => f.id === "device-imbalance")).toBeUndefined()
    } finally {
      close()
    }
  })
})

describe("memset 计入 GPU 活动", () => {
  test("memset 的时长计入忙碌、利用率与传输方向（Memset）", async () => {
    const { report, close } = await makeDb([
      { name: "memset", sql: "INSERT INTO CUPTI_ACTIVITY_KIND_MEMSET (start, end, deviceId, streamId, bytes) VALUES (0, 300000, 0, 1, 1048576)" },
    ])
    try {
      const facts = computeTimelineFacts(report)
      // 若不计 memset，这里会是 0
      expect(facts.busyNs).toBe(300_000)
      expect(facts.utilization).toBeCloseTo(1, 5)
      expect(facts.memcpyCount).toBe(1)
      expect(facts.memcpyBytes).toBe(1_048_576)
      // 方向命名独立于 memcpy 枚举
      expect(facts.memcpyKinds.map((k) => k.kind)).toContain("Memset")
      expect(facts.devices.find((d) => d.deviceId === 0)!.memcpyCount).toBe(1)
    } finally {
      close()
    }
  })

  test("无 memset 表时降级不报错（旧版导出兼容）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-nsight-nomemset-"))
    const path = join(dir, "report.sqlite")
    const { Database: Db } = (await import("bun:sqlite")) as unknown as { Database: new (p: string) => Database }
    const db = new Db(path)
    // 故意不建 MEMSET 表
    db.run("CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT)")
    db.run(`CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
      start INTEGER, end INTEGER, deviceId INTEGER, streamId INTEGER, correlationId INTEGER,
      demangledName INTEGER, shortName INTEGER, mangledName INTEGER, registersPerThread INTEGER,
      gridX INTEGER, gridY INTEGER, gridZ INTEGER, blockX INTEGER, blockY INTEGER, blockZ INTEGER,
      staticSharedMemory INTEGER, dynamicSharedMemory INTEGER)`)
    db.run("INSERT INTO StringIds (id, value) VALUES (1, 'k(float*)')")
    db.run("INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, deviceId, streamId, demangledName, shortName, mangledName, registersPerThread, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory, correlationId) VALUES (0, 200000, 0, 1, 1, 1, 1, 32, 64, 1, 1, 256, 1, 1, 0, 0, 1)")
    const report = {
      db: db as unknown as ReportDb["db"],
      ref: { path, name: "report.sqlite", stem: "nomemset", kind: "nsys", size: 1, mtimeMs: 1 },
      dir,
      sqlitePath: path,
      ctx: undefined as never,
      importNote: "",
      close: () => db.close(),
    } satisfies ReportDb
    try {
      const facts = computeTimelineFacts(report)
      expect(facts.busyNs).toBe(200_000)
      expect(facts.memcpyKinds).toEqual([])
      expect(facts.devices.length).toBe(1)
    } finally {
      db.close()
    }
  })
})
