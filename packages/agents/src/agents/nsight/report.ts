/**
 * Nsight 报告索引层（nsight 专用）：报告识别、内容指纹缓存、导入规范化与查询加速。
 *
 * - 报告类型：Nsight Systems `.nsys-rep`（时间线：CPU/GPU/API/NVTX 事件）与 Nsight Compute `.ncu-rep`
 *   （单内核逐 pass 指标）。两者均为私有容器格式，只能经官方命令行解析。
 * - 导入形态：nsys → SQLite（`nsys export --type sqlite`，全量事件表，供 SQL 聚合与自由查询）；
 *   ncu → CSV 文本页（`ncu --import --page <页>`，逐内核指标行）。
 * - 缓存：`{cacheDir}/{报告名}-{size}-{mtime}/` 内容指纹寻址——同一报告重复分析不重复解析；
 *   报告重新采集（指纹变化）自动落到新目录，旧目录不误用。
 * - **超大报告**：导出耗时与报告体积成正比，可能超出单次工具调用的时间预算。故导出带预算：
 *   预算内完成即落盘并建索引；超出预算返回「导入进行中」状态与可直接后台执行的命令，
 *   下次调用（或后台命令完成后的调用）确认产物完整即直接复用——nsys 不支持续传，不重复启动导出。
 * - **查询加速**：导出的事件库默认无索引，千万级事件表的聚合会退化为全表扫描；导入完成后按表规模
 *   决定建索引（阈值 `INDEX_THRESHOLD_ROWS`），使后续任意分析查询保持在索引可用的量级。
 */
import { existsSync, statSync } from "node:fs"
import { basename, extname, isAbsolute, join, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { buildCommand, type NsightEnvState } from "./env"

export type ReportKind = "nsys" | "ncu" | "torch"

export interface ReportRef {
  /** 绝对路径。 */
  path: string
  /** 文件名（含扩展名）。 */
  name: string
  /** 不含扩展名的报告名（缓存目录命名用）。 */
  stem: string
  kind: ReportKind
  size: number
  mtimeMs: number
}

const TORCH_TRACE_RE = /\.(pt\.trace\.json|trace\.json|chrome\.trace\.json|json)(\.gz)?$/i

/**
 * 扩展名 → 报告类型（大小写不敏感）：
 * - `.nsys-rep` / `.qdstrm`：Nsight Systems 时间线（`.qdstrm` 为采集中间格式，nsys 可直接读取）；
 * - `.ncu-rep`：Nsight Compute 单内核报告；
 * - `.pt.trace.json(.gz)` / `.trace.json` / `.json(.gz)`：PyTorch Profiler（Kineto）Chrome Trace —— 
 *   PyTorch 默认导出名为 `*.pt.trace.json`（TensorBoard trace handler 进一步 gzip 为 `*.pt.trace.json.gz`）。
 */
export function detectReportKind(path: string): ReportKind | null {
  const ext = extname(path).toLowerCase()
  if (ext === ".nsys-rep" || ext === ".qdstrm") return "nsys"
  if (ext === ".ncu-rep") return "ncu"
  // `.json.gz` 时 extname 只取到 `.gz`，需对全名匹配
  if (TORCH_TRACE_RE.test(basename(path))) return "torch"
  return null
}

/** 报告路径解析：相对路径以工具上下文基准解析（project 包装后即项目根）。 */
export function resolveReportPath(ctx: ToolContext, input: string): string {
  return isAbsolute(input) ? input : resolve(ctx.resolvePath("."), input)
}

export async function statReport(ctx: ToolContext, input: string): Promise<ReportRef> {
  const path = resolveReportPath(ctx, input)
  if (!existsSync(path)) {
    throw new Error(`报告文件不存在：${path}（相对路径以当前工作目录为基准；也可传绝对路径）`)
  }
  const st = statSync(path)
  if (st.isDirectory()) throw new Error(`这是目录而非报告文件：${path}`)
  const kind = detectReportKind(path)
  if (!kind) {
    throw new Error(
      `无法识别的报告类型：${path}\n` +
        `本子Agent 支持：Nsight Systems（.nsys-rep / .qdstrm）、Nsight Compute（.ncu-rep）、` +
        `PyTorch Profiler Chrome Trace（.pt.trace.json / .trace.json / .json，可带 .gz）。`,
    )
  }
  const name = basename(path)
  // 缓存目录与展示名用「去掉尾部扩展」的 stem（gz 变体额外去掉 .gz，使同名 trace 的两份形态共享 stem）
  const stem = name.replace(/\.gz$/i, "").slice(0, name.replace(/\.gz$/i, "").length - extname(name.replace(/\.gz$/i, "")).length)
  return { path, name, stem, kind, size: st.size, mtimeMs: st.mtimeMs }
}

/** 内容指纹寻址的缓存目录（同尺寸同 mtime 视为同一报告）。 */
export function cacheDirFor(env: NsightEnvState, ref: ReportRef): string {
  const safeStem = ref.stem.replace(/[^\w.-]+/g, "_").slice(0, 80)
  return join(env.cacheDir, `${safeStem}-${ref.size}-${Math.round(ref.mtimeMs)}`)
}

export interface ImportResult {
  /** 复用既有产物（未重新解析）。 */
  reused: boolean
  /** 导出仍在进行中（未完成，需稍后重试或后台执行给出的命令）。 */
  pending: boolean
  /** 产物绝对路径（pending 时为空）。 */
  artifacts: string[]
  /** 面向模型的过程说明。 */
  note: string
  /** 建议后台执行的完整命令（pending 时给出）。 */
  command?: string
  /** 当前进度描述（pending 时给出：已写入字节数等）。 */
  progress?: string
}

const IMPORT_META = "import.json"
const SQLITE_NAME = "report.sqlite"
/** 行数超过此值的表在导入后建索引（低于此值全表扫描本就在毫秒级）。 */
export const INDEX_THRESHOLD_ROWS = 200_000

/** 默认导出预算（毫秒）：低于引擎的单次工具执行上限（9 分钟），留出分析时间。 */
export const DEFAULT_IMPORT_BUDGET_MS = 7 * 60_000

interface ImportMeta {
  sqlite: string
  nsysVersion: string
  exportedAt: string
  indexed: boolean
  source: { path: string; size: number; mtimeMs: number }
}

async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(dir, { recursive: true })
}

async function readMeta(dir: string): Promise<ImportMeta | undefined> {
  const p = join(dir, IMPORT_META)
  if (!existsSync(p)) return undefined
  try {
    return JSON.parse(await Bun.file(p).text()) as ImportMeta
  } catch {
    return undefined
  }
}

/**
 * 判定事件库可用：文件存在、可被 SQLite 打开、含预期事件表。
 * 不依赖导入标记——用户/后台自行执行的同路径导出产物同样可被复用。
 */
async function sqliteUsable(path: string): Promise<boolean> {
  if (!existsSync(path) || statSync(path).size === 0) return false
  try {
    const mod = (await import("bun:sqlite")) as unknown as {
      Database: new (p: string, opts?: { readonly?: boolean }) => {
        query: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }
        close: () => void
      }
    }
    const db = new mod.Database(path, { readonly: true })
    try {
      const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      return rows.some((r) => /^CUPTI_ACTIVITY_KIND_/.test(r.name)) || rows.some((r) => r.name === "META_DATA_CAPTURE")
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

/**
 * 需要索引的事件表与索引列：
 * - **覆盖索引**（把热扫描用到的列全部纳入）：分析层的主扫描是「按 start 顺序遍历 + 逐行取全部列」，
 *   普通索引只能给出 rowid、随后每行回表随机读；覆盖索引使顺序扫索引即可拿到全部列。实测（1000 万行、
 *   413MB 事件库）：同样的逐行扫描从 18.9s 降到 11.2s（约 1.7 倍）；完整首次分析 28.0s → 20.9s。
 *   主扫描之外的耗时主要在逐行消费（Bun 的 SQLite 行对象物化：实测 15 列 11.2s vs 3 列 6.1s）。
 * - `end` 索引供「空闲缝前序活动」反查（ORDER BY end DESC LIMIT 1）。
 * - `nameId` 索引供 API 按名分组聚合。
 */
const INDEX_SPECS: Array<{ table: string; name: string; columns: string[] }> = [
  {
    table: "CUPTI_ACTIVITY_KIND_KERNEL",
    name: "idx_kernel_scan",
    columns: ["start", "end", "streamId", "demangledName", "shortName", "mangledName", "registersPerThread", "gridX", "gridY", "gridZ", "blockX", "blockY", "blockZ", "staticSharedMemory", "dynamicSharedMemory"],
  },
  { table: "CUPTI_ACTIVITY_KIND_KERNEL", name: "idx_kernel_end", columns: ["end"] },
  { table: "CUPTI_ACTIVITY_KIND_MEMCPY", name: "idx_memcpy_scan", columns: ["start", "end", "streamId", "bytes", "copyKind"] },
  { table: "CUPTI_ACTIVITY_KIND_RUNTIME", name: "idx_runtime_name", columns: ["nameId", "start", "end"] },
  { table: "CUPTI_ACTIVITY_KIND_RUNTIME", name: "idx_runtime_start", columns: ["start"] },
  { table: "CUPTI_ACTIVITY_KIND_SYNCHRONIZATION", name: "idx_sync_scan", columns: ["start", "end", "syncType"] },
  { table: "NVTX_EVENTS", name: "idx_nvtx_scan", columns: ["start", "end", "textId"] },
]

/** 表列名（用于跳过缺失列的索引定义）。 */
function tableColumnsOf(
  db: { query: (sql: string) => { all: (...a: unknown[]) => unknown[] } },
  table: string,
): string[] {
  try {
    return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name)
  } catch {
    return []
  }
}

/**
 * 为超出阈值的事件表建索引（幂等；写连接仅用于建索引，产物是缓存副本而非原始报告）。
 * 返回建立的索引数，供导入说明如实呈现。
 */
async function ensureIndexes(sqlitePath: string): Promise<number> {
  const mod = (await import("bun:sqlite")) as unknown as {
    Database: new (p: string, opts?: { readonly?: boolean }) => {
      query: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[]; run?: (...a: unknown[]) => unknown }
      run: (sql: string, ...params: unknown[]) => unknown
      close: () => void
    }
  }
  const db = new mod.Database(sqlitePath)
  let created = 0
  try {
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    )
    const existing = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((r) => r.name),
    )
    for (const spec of INDEX_SPECS) {
      if (!tables.has(spec.table) || existing.has(spec.name)) continue
      const count = Number(
        Object.values((db.query(`SELECT COUNT(*) AS c FROM ${spec.table}`).get() as Record<string, unknown>) ?? {})[0] ?? 0,
      )
      if (count < INDEX_THRESHOLD_ROWS) continue
      // 列可能因 nsys 版本差异缺失：缺失时跳过该索引（分析退化为全表扫描，功能仍可用）
      const cols = new Set(tableColumnsOf(db, spec.table))
      if (!spec.columns.every((c) => cols.has(c))) continue
      db.run(`CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table}(${spec.columns.join(", ")})`)
      created++
    }
  } catch {
    // 索引建立失败不阻断导入（分析退化为全表扫描，功能仍可用）
  } finally {
    db.close()
  }
  return created
}

/** 后台/手工执行的导出命令（预算耗尽时给出，便于一次跑完）。 */
export function exportCommand(env: NsightEnvState, ref: ReportRef, dir: string): string {
  if (!env.nsys) return ""
  return buildCommand(env.nsys.path, ["export", "--type", "sqlite", "--force-overwrite", "true", "--output", join(dir, SQLITE_NAME), ref.path])
}

/**
 * 导入 Nsight Systems 报告为 SQLite（幂等：产物完整即复用；预算内完成即建索引）。
 */
export async function importNsys(
  ctx: ToolContext,
  env: NsightEnvState,
  ref: ReportRef,
  opts: { budgetMs?: number } = {},
): Promise<ImportResult> {
  if (!env.nsys) throw new Error("未找到 nsys 可执行文件（先运行 nsight_doctor 查看探测结果与环境变量配置）")
  const dir = cacheDirFor(env, ref)
  const sqlitePath = join(dir, SQLITE_NAME)
  const meta = await readMeta(dir)

  if (await sqliteUsable(sqlitePath)) {
    const note = meta
      ? `复用已解析的事件库（${dir}${meta.indexed ? "，已建索引" : ""}）`
      : `复用既有事件库产物（${dir}，非本工具上次导入，未建索引）`
    if (meta && !meta.indexed) {
      const created = await ensureIndexes(sqlitePath)
      if (created > 0) {
        await ctx.writeFile(join(dir, IMPORT_META), JSON.stringify({ ...meta, indexed: true } satisfies ImportMeta, null, 2))
        return { reused: true, pending: false, artifacts: [sqlitePath], note: `${note}；本次补建 ${created} 个索引以加速后续查询` }
      }
    }
    return { reused: true, pending: false, artifacts: [sqlitePath], note }
  }

  await ensureDir(dir)
  const budgetMs = opts.budgetMs ?? DEFAULT_IMPORT_BUDGET_MS
  const r = await ctx.runCommand(exportCommand(env, ref, dir), { timeoutMs: budgetMs })

  if (await sqliteUsable(sqlitePath)) {
    const created = await ensureIndexes(sqlitePath)
    const newMeta: ImportMeta = {
      sqlite: SQLITE_NAME,
      nsysVersion: env.nsys.version,
      exportedAt: new Date().toISOString(),
      indexed: created > 0,
      source: { path: ref.path, size: ref.size, mtimeMs: ref.mtimeMs },
    }
    await ctx.writeFile(join(dir, IMPORT_META), JSON.stringify(newMeta, null, 2))
    const sizeNote = `事件库 ${(statSync(sqlitePath).size / 1e6).toFixed(1)} MB`
    return {
      reused: false,
      pending: false,
      artifacts: [sqlitePath],
      note: `已导出 SQLite 事件库（${dir}，${sizeNote}${created > 0 ? `，建索引 ${created} 个` : ""}）`,
    }
  }

  // 未完成：预算耗尽（或导出失败）——给出进度与可后台执行的命令，不重复启动导出
  const partial = existsSync(sqlitePath) ? statSync(sqlitePath).size : 0
  const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n")
  const pendingResult: ImportResult = {
    reused: false,
    pending: true,
    artifacts: [],
    command: exportCommand(env, ref, dir),
    progress: partial > 0 ? `已写入 ${(partial / 1e6).toFixed(1)} MB` : "尚未产生输出文件",
    note: [
      `报告体积 ${(ref.size / 1e6).toFixed(1)} MB，导出未在本次预算（${Math.round(budgetMs / 60_000)} 分钟）内完成。`,
      `nsys 不支持续传，为不重复消耗时间，本次不再重试导出。请在后台一次性执行下面的命令（或让调用方用 sh 的 async 形式运行），完成后再次调用本工具即直接复用产物：`,
      exportCommand(env, ref, dir),
      tail ? `最近输出：\n${tail}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
  if (r.code !== 0 && partial === 0) {
    throw new Error(`nsys 导出 SQLite 失败（exit ${r.code}）：\n${tail || "（无输出）"}`)
  }
  return pendingResult
}

/** ncu CSV 页名（不同页数据粒度不同）。 */
export type NcuPage = "details" | "raw" | "source"

const ncuPageFile = (page: NcuPage): string => `ncu-${page}.csv`

/**
 * 导入 Nsight Compute 报告为 CSV 页（幂等缓存）。ncu 无 SQLite 形态，
 * 逐页 `--import --page <页> --csv` 导出文本，分析层按表头解析（不依赖列序）。
 */
export async function importNcu(
  ctx: ToolContext,
  env: NsightEnvState,
  ref: ReportRef,
  pages: NcuPage[],
  opts: { budgetMs?: number } = {},
): Promise<ImportResult> {
  if (!env.ncu) throw new Error("未找到 ncu 可执行文件（先运行 nsight_doctor 查看探测结果与环境变量配置）")
  const dir = cacheDirFor(env, ref)
  await ensureDir(dir)
  const missing = pages.filter((p) => !existsSync(join(dir, ncuPageFile(p))) || statSync(join(dir, ncuPageFile(p))).size === 0)
  if (!missing.length) {
    return { reused: true, pending: false, artifacts: pages.map((p) => join(dir, ncuPageFile(p))), note: `复用既有解析缓存（${dir}）` }
  }
  const budgetMs = opts.budgetMs ?? DEFAULT_IMPORT_BUDGET_MS
  const failed: string[] = []
  for (const page of missing) {
    const r = await ctx.runCommand(buildCommand(env.ncu.path, ["--import", ref.path, "--page", page, "--csv"]), { timeoutMs: budgetMs })
    const text = r.stdout ?? ""
    const hasData = text.includes(",") && text.length > 0
    if (!hasData || r.code !== 0) failed.push(`${page}（exit ${r.code}）`)
    if (hasData) await ctx.writeFile(join(dir, ncuPageFile(page)), text)
  }
  const produced = pages.filter((p) => existsSync(join(dir, ncuPageFile(p))) && statSync(join(dir, ncuPageFile(p))).size > 0)
  if (!produced.length) {
    throw new Error(`ncu 导入报告失败：${failed.join("、")}\n报告可能由更高版本的 Nsight Compute 采集，或采集时未启用源码/指标收集。`)
  }
  return {
    reused: false,
    pending: failed.length > 0,
    artifacts: produced.map((p) => join(dir, ncuPageFile(p))),
    note: `已导出 ncu CSV 页：${produced.join("、")}（${dir}）${failed.length ? `；失败页：${failed.join("、")}` : ""}`,
    progress: failed.length ? `失败页 ${failed.join("、")}` : undefined,
  }
}
