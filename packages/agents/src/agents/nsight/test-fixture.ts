/**
 * 合成事件库夹具（nsight 测试共用）：自建一张与 nsys 导出同构的 SQLite（已知数值），
 * 供「JS 流式聚合」与「原生边车聚合」两条实现的一致性测试共用——同一份数据、同一批断言口径。
 */
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Database } from "bun:sqlite"
import type { ReportDb } from "./db"
import { makeStubCtx } from "../../core/perf/test-ctx"

export interface Fixture {
  report: ReportDb
  sqlitePath: string
  root: string
}

const SCHEMA = `
CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT);
CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (
  start INTEGER, end INTEGER, deviceId INTEGER, contextId INTEGER, streamId INTEGER, correlationId INTEGER,
  demangledName INTEGER, shortName INTEGER, mangledName INTEGER, registersPerThread INTEGER,
  gridX INTEGER, gridY INTEGER, gridZ INTEGER, blockX INTEGER, blockY INTEGER, blockZ INTEGER,
  staticSharedMemory INTEGER, dynamicSharedMemory INTEGER
);
CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY (start INTEGER, end INTEGER, streamId INTEGER, bytes INTEGER, copyKind INTEGER);
CREATE TABLE CUPTI_ACTIVITY_KIND_RUNTIME (start INTEGER, end INTEGER, nameId INTEGER, correlationId INTEGER, globalTid INTEGER);
CREATE TABLE CUPTI_ACTIVITY_KIND_SYNCHRONIZATION (start INTEGER, end INTEGER, syncType INTEGER);
CREATE TABLE ENUM_CUDA_MEMCPY_OPER (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
CREATE TABLE ENUM_CUPTI_SYNC_TYPE (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
CREATE TABLE TARGET_INFO_CUDA_DEVICE (gpuId INTEGER, cudaId INTEGER, pid INTEGER);
CREATE TABLE TARGET_INFO_GPU (id INTEGER, name TEXT);
CREATE TABLE TARGET_INFO_SESSION_START_TIME (utcEpochNs INTEGER, utcTime TEXT, localTime TEXT);
CREATE TABLE NVTX_EVENTS (start INTEGER, end INTEGER, textId INTEGER, text TEXT);
`

async function buildFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "gebai-nsight-db-"))
  const sqlitePath = join(root, "report.sqlite")
  const { Database: Db } = (await import("bun:sqlite")) as unknown as { Database: new (p: string) => Database }
  const db = new Db(sqlitePath)
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) db.run(stmt)

  // 字符串表：1=scaleKernel（demangled）2=_Z11scaleKernelPffi（mangled）
  db.run("INSERT INTO StringIds (id, value) VALUES (1, 'void scaleKernel<float>(float*, float, int)'), (2, '_Z11scaleKernelPffi'), (3, 'cudaLaunchKernel_v7000'), (4, 'cudaDeviceSynchronize_v3020')")
  db.run("INSERT INTO ENUM_CUDA_MEMCPY_OPER (id, name, label) VALUES (1, 'CUDA_MEMCPY_KIND_HTOD', 'Host-to-Device'), (2, 'CUDA_MEMCPY_KIND_DTOH', 'Device-to-Host')")
  db.run("INSERT INTO ENUM_CUPTI_SYNC_TYPE (id, name, label) VALUES (3, 'CUPTI_ACTIVITY_SYNCHRONIZATION_TYPE_STREAM_SYNCHRONIZE', 'Stream sync')")
  db.run("INSERT INTO TARGET_INFO_CUDA_DEVICE (gpuId, cudaId, pid) VALUES (0, 0, 4242)")
  db.run("INSERT INTO TARGET_INFO_GPU (id, name) VALUES (0, 'Synthetic GPU')")
  db.run("INSERT INTO TARGET_INFO_SESSION_START_TIME (utcEpochNs, utcTime, localTime) VALUES (0, '2026-01-01T00:00:00', '2026-01-01T08:00:00')")

  // 内核事件（已知数值，微秒量级）：
  //  - scaleKernel ×3（流 1）→ 小网格（32×128=4096 线程）与占用压力（200 寄存器）
  //  - bigKernel ×1（流 2）：与 scaleKernel 区间重叠 → 并发 2、并集不重复计
  const kernel = (start: number, end: number, stream: number, nameId: number, grid: number, block: number, regs: number, smem: number): void => {
    db.run(
      `INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL (start, end, streamId, demangledName, mangledName, registersPerThread, gridX, gridY, gridZ, blockX, blockY, blockZ, staticSharedMemory, dynamicSharedMemory)
       VALUES (?, ?, ?, ?, 2, ?, ?, 1, 1, ?, 1, 1, ?, 0)`,
      [start, end, stream, nameId, regs, grid, block, smem],
    )
  }
  kernel(0, 1_000_000, 1, 1, 32, 128, 200, 0)
  kernel(1_000_000, 3_000_000, 1, 1, 32, 128, 200, 0)
  kernel(10_000_000, 12_000_000, 1, 1, 32, 128, 200, 0)
  kernel(500_000, 2_500_000, 2, 1, 4096, 256, 40, 0)
  db.run("INSERT INTO StringIds (id, value) VALUES (5, 'void tinyKernel(int*)')")
  kernel(20_000_000, 20_005_000, 1, 5, 1, 64, 16, 0)
  kernel(20_010_000, 20_015_000, 1, 5, 1, 64, 16, 0)
  kernel(20_020_000, 20_025_000, 1, 5, 1, 64, 16, 0)

  // 显存传输（流 1）：小块 DtoH 两次
  db.run("INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY (start, end, streamId, bytes, copyKind) VALUES (4000000, 4100000, 1, 4096, 2), (5000000, 5150000, 1, 8192, 2)")

  // API 与同步
  db.run("INSERT INTO CUPTI_ACTIVITY_KIND_RUNTIME (start, end, nameId, correlationId, globalTid) VALUES (0, 100, 3, 1, 1), (100, 200, 3, 2, 1), (25000000, 25000000 + 900000, 4, 3, 1)")
  db.run("INSERT INTO CUPTI_ACTIVITY_KIND_SYNCHRONIZATION (start, end, syncType) VALUES (25000000, 25000000 + 2000000, 3)")

  // NVTX：两种存储形态（textId 走 StringIds；text 直接存文本——torch 等运行时如此）
  db.run("INSERT INTO StringIds (id, value) VALUES (9, 'phase_compute')")
  db.run("INSERT INTO NVTX_EVENTS (start, end, textId, text) VALUES (0, 12000000, 9, NULL), (20000000, 20025000, NULL, 'phase_tiny')")

  const report: ReportDb = {
    db: db as unknown as ReportDb["db"],
    ref: { path: sqlitePath, name: "report.sqlite", stem: "synthetic", kind: "nsys", size: 1, mtimeMs: 1 },
    ctx: makeStubCtx(root).ctx,
    dir: root,
    sqlitePath,
    importNote: "",
    close: () => db.close(),
  }
  return { report, sqlitePath, root }
}


/** 按夹具数据构造报告（每次调用新建临时库，避免用例间污染）。 */
export async function makeSyntheticReport(): Promise<Fixture> {
  return await buildFixture()
}

/** 原生边车可执行文件路径（未构建时返回 null，测试据此跳过原生侧断言）。 */
export function nativeBinaryPath(): string | null {
  const repoRoot = resolve(import.meta.dir, "../../../../..")
  const exe = process.platform === "win32" ? "nsight.exe" : "nsight"
  const p = join(repoRoot, "keqing", "rust", "target", "release", exe)
  return existsSync(p) ? p : null
}
