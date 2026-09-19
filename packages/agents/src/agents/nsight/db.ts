/** Nsight 报告分析所需的 SQLite 访问封装（只读打开事件库 + schema 容错助手）。 */
import type { ToolContext } from "@gebai/sdk"
import type { NsightEnvState } from "./env"
import { cacheDirFor, importNsys, statReport, type ReportRef } from "./report"
import { join } from "node:path"

type SqliteDb = {
  query: (sql: string) => {
    all: (...params: unknown[]) => unknown[]
    get: (...params: unknown[]) => unknown
    iterate: (...params: unknown[]) => IterableIterator<unknown>
  }
  close: () => void
}

export interface ReportDb {
  db: SqliteDb
  ref: ReportRef
  dir: string
  /** 事件库（SQLite）绝对路径——事实缓存指纹、原生聚合后端与调试均以它为准。 */
  sqlitePath: string
  /** 打开报告时的工具上下文（原生聚合经 registry 解析边车工具，需 ctx 走装载门控）。 */
  ctx: ToolContext
  /** 首次解析耗时提示（复用缓存时为空）。 */
  importNote: string
  /** 关闭句柄。 */
  close: () => void
}

async function openSqlite(path: string): Promise<SqliteDb> {
  const mod = (await import("bun:sqlite")) as unknown as { Database: new (p: string, opts?: { readonly?: boolean }) => SqliteDb }
  return new mod.Database(path, { readonly: true })
}

/** 打开（必要时先导入）Nsight Systems 报告的事件库。 */
export async function openNsysReport(ctx: ToolContext, env: NsightEnvState, input: string): Promise<ReportDb> {
  const ref = await statReport(ctx, input)
  if (ref.kind !== "nsys") {
    throw new Error(`${ref.name} 是 Nsight Compute 报告（单 kernel 指标）——请用 nsight_kernel_detail 分析；时间线类工具（nsight_overview/nsight_kernels/nsight_timeline/nsight_findings）需要 Nsight Systems 报告（.nsys-rep）。`)
  }
  const imp = await importNsys(ctx, env, ref)
  if (imp.pending || !imp.artifacts.length) {
    throw new Error(`报告事件库尚未就绪（导入进行中或未完成）：\n${imp.note}`)
  }
  const sqlitePath = imp.artifacts[0]!
  const db = await openSqlite(sqlitePath)
  return { db, ref, dir: cacheDirFor(env, ref), sqlitePath, ctx, importNote: imp.reused ? "" : imp.note, close: () => db.close() }
}

/** 打开 ncu 报告缓存目录中的 CSV 页（由 report.importNcu 保证存在）。 */
export function ncuPagePath(env: NsightEnvState, ref: ReportRef, page: string): string {
  return join(cacheDirFor(env, ref), `ncu-${page}.csv`)
}

/** 表是否存在。 */
export function tableExists(db: SqliteDb, table: string): boolean {
  try {
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").all(table) as Array<{ name: string }>
    return rows.length > 0
  } catch {
    return false
  }
}

/** 查询包装：失败（缺表/缺列/版本差异）返回 undefined，由调用方降级。 */
export function tryAll<T = Record<string, unknown>>(db: SqliteDb, sql: string, ...params: unknown[]): T[] | undefined {
  try {
    return db.query(sql).all(...params) as T[]
  } catch {
    return undefined
  }
}

export function tryGet<T = Record<string, unknown>>(db: SqliteDb, sql: string, ...params: unknown[]): T | undefined {
  try {
    return db.query(sql).get(...params) as T
  } catch {
    return undefined
  }
}

/** StringIds 解析（事件表以整数 id 引用字符串，报告导出后须回表还原名称）。 */
export function stringIdsMap(db: SqliteDb): Map<number, string> {
  const map = new Map<number, string>()
  const rows = tryAll<{ id: number; value: string }>(db, "SELECT id, value FROM StringIds")
  for (const r of rows ?? []) map.set(r.id, r.value)
  return map
}

export const sid = (map: Map<number, string>, id: unknown): string => (typeof id === "number" ? map.get(id) ?? `#${id}` : "")

/** 枚举表 → 标签映射（ENUM_* 表统一 id/name/label 三列）。 */
export function enumMap(db: SqliteDb, table: string): Map<number, string> {
  const map = new Map<number, string>()
  const rows = tryAll<{ id: number; label: string | null; name: string | null }>(db, `SELECT id, label, name FROM ${table}`)
  for (const r of rows ?? []) map.set(r.id, r.label || r.name || `#${r.id}`)
  return map
}

/** 只读 SQL 校验（nsight_query 用）：仅 SELECT/WITH/PRAGMA，拒绝多语句与写操作。 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "")
  if (!trimmed) throw new Error("SQL 为空")
  if (/;/.test(trimmed)) throw new Error("仅允许单条 SQL 语句（不含分号分隔的多语句）")
  if (!/^(select|with|pragma)\b/i.test(trimmed)) {
    throw new Error("仅允许只读查询（SELECT / WITH / PRAGMA）——报告事件库以只读方式打开，写操作会被拒绝")
  }
  if (/\b(insert|update|delete|drop|alter|create|attach|replace|vacuum)\b/i.test(trimmed)) {
    throw new Error("检测到写操作关键字：报告事件库只读")
  }
}

/** 表的列名清单（不同 nsys 版本列集有差异，构建查询前先探测以免整条查询失败）。 */
export function tableColumns(db: SqliteDb, table: string): string[] {
  const rows = tryAll<{ name: string }>(db, `PRAGMA table_info(${table})`)
  return (rows ?? []).map((r) => r.name)
}

/** 报告事件库中全部表名（模型探索 schema 用）。 */
export function listTables(db: SqliteDb): string[] {
  const rows = tryAll<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") ?? []
  return rows.map((r) => r.name)
}

/** 表行列结构 + 行数（nsight_query 的 schema 动作）。 */
export interface TableSchema {
  table: string
  rows: number
  columns: Array<{ name: string; type: string }>
}

export function describeTables(db: SqliteDb, tables: string[]): TableSchema[] {
  const out: TableSchema[] = []
  for (const t of tables) {
    const cols = tryAll<{ name: string; type: string }>(db, `PRAGMA table_info(${t})`) ?? []
    const count = tryGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM ${t}`)
    out.push({ table: t, rows: count?.c ?? 0, columns: cols.map((c) => ({ name: c.name, type: c.type })) })
  }
  return out
}
