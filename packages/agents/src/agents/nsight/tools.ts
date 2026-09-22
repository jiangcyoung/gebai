/**
 * nsight 工具集（报告分析主入口）：环境自检、报告索引、时间线概览/热点/时间线细节、
 * 事件库只读查询、诊断与代码定位。全部工具只读（采集类工具见 capture.ts，单独需审批）。
 *
 * 大数据策略（DESIGN「Nsight 报告分析 → 实时分析」）：
 * - 事件库按内容指纹缓存，首次解析后不再重复；
 * - 全部聚合走流式扫描 / SQL 下推，结果条数由参数封顶；
 * - 每次分析回报实际耗时与缓存命中情况——超大报告的首次扫描与后续秒回对用户可见。
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Tool, ToolContext, ToolResult, ToolSchema } from "@gebai/sdk"
import { detectReportKind, importNcu, importNsys, statReport } from "./report"
import { openNsysReport, describeTables, listTables, assertReadOnlySql, tryAll } from "./db"
import { missingToolchainNote, probeCounterPermission, queryGpu, resolveNsightEnv } from "./env"
import {
  ANALYSIS_LIMITS,
  apiFacts,
  deviceFacts,
  firstActivityNs,
  graphFacts,
  overheadFacts,
  gapNeighbours,
  nvtxFacts,
  reportScale,
  syncFacts,
  resolveTimelineFacts,
  timelineScale,
} from "./nsys-analysis"
import {
  diagnoseNsys,
  severityLabel,
  type Severity,
} from "./findings"
import type { SymbolHint } from "../../core/perf/locate"
import { locateSymbols, renderLocate } from "../../core/perf/locate"
import { EXPORT_PARAMS, exportNote, parseExportArgs, renderMarkdown, saveMarkdown, type SaveResult } from "../../core/perf/export"
import { compareSnapshots, renderCompare, type CompareMetric, type SideSnapshot } from "../../core/perf/compare"
import { formatBytes, formatInt, formatNs, formatPct, renderTable } from "../../core/perf/format"
import { aggregateNote, withTiming } from "../../core/perf/timing"

/** 统一的 schema 构造助手。 */
export function schema(properties: Record<string, unknown>, required: string[] = []): ToolSchema {
  return { type: "object", properties, required } as ToolSchema
}

/** 时间窗参数（毫秒，相对会话首个活动；与活动区间相交即命中）。 */
const WINDOW_PARAMS = {
  time_from_ms: { type: "number", description: "时间窗起点（毫秒，相对报告首个活动）——只看该区间，用于聚焦某阶段" },
  time_to_ms: { type: "number", description: "时间窗终点（毫秒，相对报告首个活动）" },
}

/**
 * 把「相对首个活动的毫秒」换算成绝对纳秒。
 *
 * 事件库的时间戳是 nsys 自己的时基（非纪元时间），用户给不出绝对值——所以窗口按
 * **相对报告首个活动** 表达，换算需要先取到该基准（从事件库直接查，代价极小）。
 */
async function resolveWindow(report: Awaited<ReturnType<typeof openNsysReport>>, args: Record<string, unknown>): Promise<{ fromNs?: number; toNs?: number; note: string }> {
  const fromMs = args.time_from_ms === undefined || args.time_from_ms === null ? undefined : Number(args.time_from_ms)
  const toMs = args.time_to_ms === undefined || args.time_to_ms === null ? undefined : Number(args.time_to_ms)
  if (fromMs === undefined && toMs === undefined) return { note: "" }
  const base = firstActivityNs(report)
  const fromNs = fromMs === undefined ? undefined : base + Math.max(0, fromMs) * 1e6
  const toNs = toMs === undefined ? undefined : base + Math.max(0, toMs) * 1e6
  if (fromNs !== undefined && toNs !== undefined && toNs <= fromNs) {
    throw new Error(`时间窗无效：time_to_ms（${toMs}）必须大于 time_from_ms（${fromMs}）`)
  }
  const fmt = (v?: number) => (v === undefined ? "—" : `${((v - base) / 1e6).toFixed(2)}ms`)
  return { fromNs, toNs, note: `时间窗 ${fmt(fromNs)} ~ ${fmt(toNs)}（相对报告首个活动；仅统计与该区间相交的 GPU 活动）` }
}

const REPORT_PARAM = { report: { type: "string", description: "报告路径（.nsys-rep / .qdstrm / .ncu-rep；相对路径以当前工作目录或 project 根为基准）" } }

/** 稀疏时间线的紧凑条形渲染（0~1 → 8 级块字符）。 */
export function sparkline(series: number[]): string {
  const blocks = "▁▂▃▄▅▆▇█"
  return series.map((v) => blocks[Math.min(blocks.length - 1, Math.max(0, Math.round(v * (blocks.length - 1))))]).join("")
}

function scaleNote(facts: ReturnType<typeof reportScale>): string {
  return `事件规模：内核 ${formatInt(facts.kernels)}、传输 ${formatInt(facts.memcpys)}、API ${formatInt(facts.apis)}、同步 ${formatInt(facts.syncs)}`
}

// ---------------------------------------------------------------- doctor

export const doctorTool: Tool = {
  name: "doctor",
  description:
    "Nsight 环境自检：探测 nsys/ncu 可执行文件与版本（环境变量/安装目录/PATH 三路）、GPU 概况、GPU 性能计数器权限（ncu 采集的前置）、报告缓存目录与已缓存报告清单。分析报告或采集前先跑一次，可避免因工具链或权限问题反复试错。",
  parameters: schema({}),
  outputSchema: schema({
    nsys: { type: "object", description: "nsys 路径/版本/来源（缺失时为空）" },
    ncu: { type: "object", description: "ncu 路径/版本/来源" },
    gpus: { type: "array", description: "GPU 名称/驱动/计算能力" },
    counterPermission: { type: "object", description: "ncu 性能计数器权限状态与修复指引" },
    cacheDir: { type: "string" },
  }),
  safeMode: false,
  async execute(_args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const lines: string[] = ["【工具链】"]
    const fmt = (b: { path: string; version: string; source: string } | undefined, name: string, envName: string): string =>
      b
        ? `${name}：${b.path}\n  版本：${b.version || "（--version 无输出）"}（来源：${{ env: "环境变量", scan: "安装目录扫描", path: "PATH" }[b.source]}）`
        : `${name}：未找到（可设环境变量 ${envName} 指定路径，或加入 PATH）`
    lines.push(fmt(env.nsys, "nsys（Nsight Systems，时间线采集与分析）", "NSIGHT_SYSTEMS_BIN"))
    lines.push(fmt(env.ncu, "ncu（Nsight Compute，单内核详查）", "NSIGHT_COMPUTE_BIN"))
    if (env.issues.length) lines.push(`探测提示：${env.issues.join("；")}`)

    lines.push("", "【GPU】")
const t0 = withTiming()
const gpus = await queryGpu(ctx)
lines.push(
  gpus
    ? gpus.map((g) => `${g.name}（驱动 ${g.driver}，计算能力 ${g.computeCap}${g.driverModel ? `，驱动模型 ${g.driverModel}` : ""}）`).join("\n")
    : "nvidia-smi 不可用或未检测到 GPU（报告分析仍可用，采集不可用）",
)
if (gpus?.some((g) => g.driverModel === "WDDM")) {
  lines.push(
    "⚠ WDDM 驱动模型（Windows 显示驱动模型，非 TCC）：计算命令会多一层系统转换，\n" +
      "  且会**让 nsys 的内核时长失真**——此时不要用内核耗时下结论，\n" +
      "  改用**调用计数/网格配置/事件重叠**这类与时长无关的事实交叉验证。",
  )
}

    lines.push("", "【采集权限】")
    let counter: { state: string; detail: string } = { state: "unknown", detail: "未探测（缺少 ncu）" }
    if (env.ncu) counter = await probeCounterPermission(ctx, env.ncu.path)
    lines.push(`ncu 性能计数器：${{ granted: "可用", denied: "不可用（受限）", unknown: "未能判定" }[counter.state as "granted" | "denied" | "unknown"]}`)
    if (counter.detail) lines.push(`  ${counter.detail}`)

    lines.push("", "【缓存】")
    lines.push(`报告缓存目录：${env.cacheDir}`)
    const cached = existsSync(env.cacheDir) ? (await ctx.listDir(env.cacheDir).catch(() => [])).filter((e) => e.isDir) : []
    lines.push(cached.length ? `已缓存报告：${cached.length} 个（目录名 = 报告名-大小-mtime）` : "暂无缓存报告")
    lines.push(`探测耗时 ${((t0() ) / 1000).toFixed(1)}s`)
    return {
      output: lines.join("\n"),
      data: {
        nsys: env.nsys ? { path: env.nsys.path, version: env.nsys.version, source: env.nsys.source } : null,
        ncu: env.ncu ? { path: env.ncu.path, version: env.ncu.version, source: env.ncu.source } : null,
        gpus: gpus ?? [],
        counterPermission: counter,
        cacheDir: env.cacheDir,
      },
    }
  },
}

// ---------------------------------------------------------------- reports

export const reportsTool: Tool = {
  name: "reports",
  description:
    "报告索引与导入：list 扫描目录列出 Nsight 报告（按大小/修改时间，标注类型与是否已解析缓存）；info 显示单个报告的规模与缓存状态；import 预解析报告（nsys 导出事件库并按需建索引 / ncu 导出指标页）——超大报告若超出单次预算会返回后台可直接执行的命令，不重复消耗时间。",
  parameters: schema(
    {
      ...REPORT_PARAM,
      action: { type: "string", enum: ["list", "info", "import"], description: "动作（默认 info；给了 report 而 action=import 即预解析）" },
      path: { type: "string", description: "list 动作的扫描目录（默认当前工作目录）" },
      depth: { type: "number", description: "list 递归深度（默认 3）" },
    },
    [],
  ),
  outputSchema: schema({
    reports: { type: "array", description: "报告清单：path/kind/size/mtimeMs/cached" },
    imported: { type: "object", description: "import 结果：reused/pending/artifacts/note/command" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const action = String(args.action ?? (args.report ? "info" : "list"))
    const env = await resolveNsightEnv(ctx)
    if (action === "list") {
      // 目录遍历走宿主注入的 ctx.listFiles（沙箱与范围约束由引擎统一执行）
      const files = await ctx.listFiles().catch(() => [])
      const cacheRoot = env.cacheDir
      const found: Array<{ path: string; kind: string; size: number; mtimeMs: number; cached: boolean }> = []
      for (const f of files) {
        if (f.isDir) continue
        const kind = detectReportKind(f.path)
        if (!kind) continue
        const stem = f.path.split(/[/\\]/).pop()!.replace(/\.(nsys-rep|qdstrm|ncu-rep)$/i, "")
        const cached = existsSync(join(cacheRoot, `${stem.replace(/[^\w.-]+/g, "_").slice(0, 80)}-${f.size}-${Math.round(f.modifiedAt)}`))
        found.push({ path: f.path, kind, size: f.size, mtimeMs: f.modifiedAt, cached })
      }
      found.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const dir = ctx.workdir
      if (!found.length) {
        return { output: `当前工作目录 ${dir} 下未发现 Nsight 报告（.nsys-rep / .qdstrm / .ncu-rep）。可用 project 参数指定工程根后再列。`, data: { reports: [] } }
      }
      const rows = found.map((r) => [
        r.path,
        r.kind === "nsys" ? "Systems（时间线）" : "Compute（内核）",
        formatBytes(r.size),
        new Date(r.mtimeMs).toISOString().slice(0, 19).replace("T", " "),
        r.cached ? "已解析" : "未解析",
      ])
      return {
        output: [`当前工作目录下发现 ${found.length} 个报告：`, "", renderTable(["路径", "类型", "大小", "修改时间", "缓存"], rows)].join("\n"),
        data: { reports: found },
      }
    }

    if (!args.report) return { output: "需要 report 参数（报告路径）", data: {} }
    if (action === "info") {
      const ref = await statReport(ctx, String(args.report))
      const lines = [
        `报告：${ref.path}`,
        `类型：${ref.kind === "nsys" ? "Nsight Systems（时间线报告）" : "Nsight Compute（单内核报告）"}`,
        `大小：${formatBytes(ref.size)}（${formatInt(ref.size)} 字节）`,
        `修改时间：${new Date(ref.mtimeMs).toISOString()}`,
      ]
      if (ref.kind === "nsys") {
        const opened = await openNsysReport(ctx, env, String(args.report))
        try {
          const scale = withTimingCall(() => reportScale(opened))
          lines.push("", scaleNote(scale.value), `事件库解析：${opened.importNote || "复用既有缓存"}`, `行数统计耗时 ${(scale.ms / 1000).toFixed(2)}s`)
        } finally {
          opened.close()
        }
      } else {
        lines.push("", "ncu 报告解析需要先导出指标页（用 action=import，或直接调用 nsight_kernel_detail 在需要时自动导出）。")
      }
      return { output: lines.join("\n"), data: { report: ref } }
    }

    // import
    const ref = await statReport(ctx, String(args.report))
    const imp = ref.kind === "nsys" ? await importNsys(ctx, env, ref) : await importNcu(ctx, env, ref, ["details", "raw", "source"])
    const lines = [imp.note, imp.progress ? `进度：${imp.progress}` : "", imp.reused ? "（无需重复解析）" : ""].filter(Boolean)
    return {
      output: lines.join("\n"),
      data: { imported: { reused: imp.reused, pending: imp.pending, artifacts: imp.artifacts, note: imp.note, command: imp.command } },
    }
  },
}

function withTimingCall<T>(fn: () => T): { value: T; ms: number } {
  const t = withTiming()
  const value = fn()
  return { value, ms: t() }
}

// ---------------------------------------------------------------- overview

export const overviewTool: Tool = {
  name: "overview",
  description:
    "时间线总览：GPU 利用率与空闲占比、紧凑时间线（占用条）、热点内核排行、显存传输/API/同步/流分布与会话元信息，并给出事件规模与首次分析耗时（超大报告首个调用付出扫描成本，后续命中缓存秒回）。分析报告的第一步。",
  parameters: schema({
    ...REPORT_PARAM,
    top: { type: "number", description: "各排行榜条数（默认 10，上限 50）" },
    gap_min_ms: { type: "number", description: "空闲缝统计下限（毫秒，默认 0.05）" },
    ...WINDOW_PARAMS,
  }, ["report"]),
  outputSchema: schema({
    metrics: { type: "object", description: "会话级度量（利用率/忙碌时间/空闲/传输/同步等）" },
    timeline: { type: "array", description: "时间线占用序列（0~1）" },
    kernels: { type: "array", description: "热点内核排行" },
    scale: { type: "object", description: "事件规模" },
    analysisMs: { type: "number", description: "本次分析耗时（毫秒）" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, "nsys")
    if (missing) return { output: missing, data: {} }
    const top = Math.max(1, Math.min(50, Number(args.top ?? 10)))
    const gapMinNs = Math.max(0, Number(args.gap_min_ms ?? 0.05) * 1e6)
    const t = withTiming()
    const report = await openNsysReport(ctx, env, String(args.report))
    try {
      const scale = reportScale(report)
      const win = await resolveWindow(report, args as Record<string, unknown>)
      const agg = await resolveTimelineFacts(report, { gapMinNs, fromNs: win.fromNs, toNs: win.toNs })
      const facts = agg.facts
      const api = apiFacts(report, top)
      const sync = syncFacts(report)
      const nvtx = nvtxFacts(report, top)
      const dev = deviceFacts(report)
      const overhead = overheadFacts(report, { fromNs: facts.firstActivityNs, toNs: facts.lastActivityNs }, top)
      const graph = graphFacts(report)
      const elapsed = t()
      const lines: string[] = []
      lines.push(`报告：${report.ref.path}`)
      lines.push(`${scaleNote(scale)}｜聚合 ${aggregateNote(agg)}｜分析总耗时 ${(elapsed / 1000).toFixed(2)}s${report.importNote ? `（含首次解析：${report.importNote}）` : "（命中缓存，未重复解析）"}`)
      if (win.note) lines.push(win.note)
      lines.push("")
      lines.push("【GPU 活动】")
      lines.push(
        `活动窗口 ${formatNs(facts.windowNs)}｜有活动 ${formatNs(facts.busyNs)}｜利用率 ${formatPct(facts.utilization)}｜空闲 ${formatNs(facts.gapTotalNs)}（${facts.gapCount} 段）｜最大并发内核 ${facts.maxConcurrent}｜流 ${facts.streams.length} 个`,
      )
      const scaleInfo = timelineScale(facts)
      lines.push(`时间线（每字符 ≈ ${formatNs(scaleInfo.spanNs / Math.max(1, scaleInfo.points))}，高度 = 占用率）：`)
      lines.push(`  ${sparkline(facts.timeline)}`)
      if (dev.devices.length) {
        lines.push(`设备：${dev.devices.map((d) => `${d.name ?? `GPU ${d.gpuId}`}（CC ${d.computeCap ?? "?"}，进程 ${d.pid}）`).join("；")}`)
      }
      // 多卡：每卡单独一行（合并口径只能回答「机器有活干吗」）
      if (facts.devices.length > 1) {
        lines.push("")
        lines.push(`【每卡时间线】共 ${facts.devices.length} 张 GPU（合并口径利用率 ${formatPct(facts.utilization)}；单卡是否被困住看下列各行）`)
        for (const d of facts.devices) {
          lines.push(
            `  device ${d.deviceId}：利用率 ${formatPct(d.utilization)}｜忙碌 ${formatNs(d.busyNs)}｜卡内空闲 ${formatNs(d.gapTotalNs)}（${d.gapCount} 段）｜最大并发 ${d.maxConcurrent}｜内核 ${formatInt(d.kernelInstances)} 次`,
          )
          lines.push(`    ${sparkline(d.timeline)}`)
        }
      }
      lines.push("")
      lines.push("【采集开销】")
      if (!overhead.available) lines.push("（报告内无 PROFILER_OVERHEAD 表——该维度未采集）")
      else if (!overhead.count) lines.push("（开销表为空：采集未记录插桩开销点）")
      else {
        const share = facts.windowNs > 0 ? overhead.inWindowNs / facts.windowNs : 0
        lines.push(
          `开销点 ${formatInt(overhead.count)} 个、合计 ${formatNs(overhead.totalNs)}`,
        )
        lines.push(
          `其中落在活动窗口内 ${formatNs(overhead.inWindowNs)}（占窗口 ${formatPct(share)}）${share > 0.05 ? "——窗口内的测量可能被采集扰动，结论需打折" : "——窗口内扰动可忽略"}`,
        )
        if (overhead.beforeWindowNs > 0 || overhead.afterWindowNs > 0) {
          lines.push(`窗口外（不影响窗口内结论）：启动阶段 ${formatNs(overhead.beforeWindowNs)}、退出阶段 ${formatNs(overhead.afterWindowNs)}`)
        }
        lines.push(
          renderTable(
            ["开销点", "次数", "总耗时", "最长"],
            overhead.top.slice(0, Math.min(5, top)).map((o) => [o.name.length > 48 ? `${o.name.slice(0, 45)}...` : o.name, formatInt(o.count), formatNs(o.totalNs), formatNs(o.maxNs)]),
          ),
        )
      }
      lines.push("")
      lines.push("【CUDA Graph】")
      if (!graph.available) lines.push(`（未采集）${graph.note ?? ""}`)
      else
        lines.push(
          `图执行 ${formatInt(graph.graphCount)} 次、总时长 ${formatNs(graph.graphTotalNs)}、图内节点合计 ${formatInt(graph.nodeCount)}（图的内部依赖不在 kernel 事件里，逐内核视图看不到图结构）`,
        )
      lines.push("")
      lines.push("")
      lines.push(`【热点内核】Top ${Math.min(top, facts.kernels.length)}（按总耗时，共 ${formatInt(facts.kernelDistinctGroups)} 个不同内核 / ${formatInt(facts.kernelInstances)} 次调用，合计 ${formatNs(facts.kernelTotalNs)}）`)
      lines.push(
        renderTable(
          ["内核", "调用", "总耗时", "平均", "中位", "网格", "块", "寄存器"],
          facts.kernels.slice(0, top).map((k) => [
            k.name.length > 60 ? `${k.name.slice(0, 57)}...` : k.name,
            formatInt(k.instances),
            formatNs(k.totalNs),
            formatNs(k.avgNs),
            formatNs(k.p50Ns) + (k.p50Sampled ? "*" : ""),
            k.grid.join("×"),
            k.block.join("×"),
            String(k.registersPerThread),
          ]),
        ),
      )
      if (facts.kernels.some((k) => k.p50Sampled)) lines.push("（中位值带 * 为受控抽样估计）")
      lines.push("")
      lines.push("【显存传输】")
      if (facts.memcpyCount === 0) lines.push("（无传输事件）")
      else {
        lines.push(`共 ${formatInt(facts.memcpyCount)} 次、${formatBytes(facts.memcpyBytes)}、合计耗时 ${formatNs(facts.memcpyTotalNs)}`)
        lines.push(
          renderTable(
            ["方向", "次数", "总耗时", "字节", "平均每次"],
            facts.memcpyKinds.map((k) => [k.kind, formatInt(k.count), formatNs(k.totalNs), formatBytes(k.bytes), formatBytes(k.avgBytes)]),
          ),
        )
      }
      lines.push("")
      lines.push("【CUDA API 与同步】")
      lines.push(`API ${formatInt(api.count)} 次，合计 ${formatNs(api.totalNs)}；同步 ${formatInt(sync.count)} 次，合计 ${formatNs(sync.totalNs)}`)
      if (api.top.length) {
        lines.push(
          renderTable(
            ["API", "次数", "总耗时", "最长单次"],
            api.top.slice(0, Math.min(top, 8)).map((a) => [a.name, formatInt(a.count), formatNs(a.totalNs), formatNs(a.maxNs)]),
          ),
        )
      }
      if (sync.byKind.length) lines.push(`同步类型：${sync.byKind.map((s) => `${s.kind} ${formatInt(s.count)} 次/${formatNs(s.totalNs)}`).join("；")}`)
      lines.push("")
      lines.push("【流分布】")
      lines.push(
        renderTable(
          ["流", "内核数", "内核耗时", "传输数", "传输字节"],
          facts.streams.slice(0, top).map((s) => [String(s.streamId), formatInt(s.kernelInstances), formatNs(s.kernelTotalNs), formatInt(s.memcpyCount), formatBytes(s.memcpyBytes)]),
        ),
      )
      if (nvtx.available && nvtx.top.length) {
        lines.push("")
        lines.push("【NVTX 阶段】Top（按区间总耗时）")
        lines.push(renderTable(["区间", "次数", "总耗时"], nvtx.top.slice(0, top).map((n) => [n.text, formatInt(n.count), formatNs(n.totalNs)])))
      }
      lines.push("")
      lines.push("下一步：nsight_findings 定位问题清单（含代码位置）、nsight_timeline 看空闲缝与启动间隔细节、nsight_kernels 下钻单个内核。")
      return {
        output: lines.join("\n"),
        data: {
          metrics: {
            利用率: facts.utilization,
            忙碌ns: facts.busyNs,
            窗口ns: facts.windowNs,
            空闲ns: facts.gapTotalNs,
            kernel总耗时ns: facts.kernelTotalNs,
            传输总耗时ns: facts.memcpyTotalNs,
            同步总耗时ns: sync.totalNs,
            最大并发: facts.maxConcurrent,
            流数: facts.streams.length,
          },
          timeline: facts.timeline,
          kernels: facts.kernels.slice(0, top),
          scale,
          analysisMs: elapsed,
        },
      }
    } finally {
      report.close()
    }
  },
}

// ---------------------------------------------------------------- kernels

export const kernelsTool: Tool = {
  name: "kernels",
  description:
    "内核热点与下钻：不带 kernel 参数时按总耗时/平均耗时/调用次数/峰值耗时排行（可用 filter 正则筛选内核名）；指定 kernel 时给出该内核的调用统计、网格/块/寄存器/共享内存、所在流、耗时分布与相邻启动间隔（定位调用模式的代码)。",
  parameters: schema({
    ...REPORT_PARAM,
    kernel: { type: "string", description: "下钻的内核名（子串匹配；不带则返回排行）" },
    filter: { type: "string", description: "排行筛选：内核名正则" },
    sort_by: { type: "string", enum: ["total", "avg", "count", "max"], description: "排序键（默认 total）" },
    top: { type: "number", description: "条数（默认 15，上限 100）" },
  }, ["report"]),
  outputSchema: schema({
    kernels: { type: "array", description: "内核统计列表" },
    detail: { type: "object", description: "下钻结果（kernel 给定时）" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, "nsys")
    if (missing) return { output: missing, data: {} }
    const top = Math.max(1, Math.min(100, Number(args.top ?? 15)))
    const report = await openNsysReport(ctx, env, String(args.report))
    try {
      const t = withTiming()
      const agg = await resolveTimelineFacts(report)
      const facts = agg.facts
      const elapsed = t()
      const kernelArg = args.kernel ? String(args.kernel) : ""
      if (kernelArg) {
        // 下钻：先按子串在排行内定位；排行只含 Top-N，故未命中时用 SQL 精确取该内核的聚合
        const hit = facts.kernels.find((k) => k.name.includes(kernelArg) || k.mangled.includes(kernelArg))
        const rows = hit
          ? [hit]
          : tryAll<{ demangledName: number; instances: number; totalNs: number; minNs: number; maxNs: number }>(
              report.db,
              `SELECT demangledName, COUNT(*) AS instances, SUM(end - start) AS totalNs, MIN(end - start) AS minNs, MAX(end - start) AS maxNs
               FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE demangledName IN (SELECT id FROM StringIds WHERE value LIKE ?)
               GROUP BY demangledName ORDER BY totalNs DESC LIMIT 5`,
              `%${kernelArg}%`,
            )?.map((r) => ({
              name: kernelArg,
              mangled: "",
              instances: r.instances,
              totalNs: r.totalNs,
              avgNs: r.totalNs / Math.max(1, r.instances),
              minNs: r.minNs,
              maxNs: r.maxNs,
              p50Ns: 0,
              p50Sampled: true,
              grid: [0, 0, 0] as [number, number, number],
              block: [0, 0, 0] as [number, number, number],
              registersPerThread: 0,
              smemBytes: 0,
              streams: [] as number[],
              threadsPerBlock: 0,
              gridBlocks: 0,
              totalThreads: 0,
            })) ?? []
        if (!rows.length) {
          return { output: `未找到匹配「${kernelArg}」的内核。可用 nsight_kernels 不带 kernel 参数查看热点排行（共 ${formatInt(facts.kernelDistinctGroups)} 个内核）。`, data: {} }
        }
        const lines: string[] = [`内核下钻：${kernelArg}（匹配 ${rows.length} 项，分析耗时 ${(elapsed / 1000).toFixed(2)}s）`]
        for (const k of rows) {
          lines.push("")
          lines.push(`${k.name}`)
          lines.push(`  调用 ${formatInt(k.instances)} 次，合计 ${formatNs(k.totalNs)}（占内核总时长 ${formatPct(k.totalNs / Math.max(1, facts.kernelTotalNs))}）`)
          lines.push(`  单次：平均 ${formatNs(k.avgNs)}，最小 ${formatNs(k.minNs)}，最大 ${formatNs(k.maxNs)}${k.p50Sampled ? "" : `，中位 ${formatNs(k.p50Ns)}`}`)
          if (k.gridBlocks) lines.push(`  网格 ${k.grid.join("×")}，块 ${k.block.join("×")}（单次 ${formatInt(k.totalThreads)} 线程），寄存器 ${k.registersPerThread}，共享内存 ${formatBytes(k.smemBytes)}`)
          if (k.streams.length) lines.push(`  所在流：${k.streams.join("、")}`)
          if (k.gridBlocks && k.totalThreads < 100_000) lines.push(`  提示：单次网格线程数偏小（${formatInt(k.totalThreads)}），可能未填满设备（见 nsight_findings 的 grid-undersized）`)
          if (k.avgNs < 10_000) lines.push("  提示：单次耗时很短（<10μs），启动开销占比可能很高（见 launch-bound 规则）")
        }
        const related = facts.launchGaps.filter((g) => g.from.includes(kernelArg) || g.to.includes(kernelArg)).slice(0, 5)
        if (related.length) {
          lines.push("")
          lines.push("相邻启动间隔（同流，内核间空隙）：")
          for (const g of related) lines.push(`  ${formatNs(g.gapNs)}：${g.from.slice(0, 50)} → ${g.to.slice(0, 50)}（流 ${g.streamId}）`)
        }
        return { output: lines.join("\n"), data: { detail: rows } }
      }

      const filterRe = args.filter ? safeRegex(String(args.filter)) : null
      const sortBy = (["total", "avg", "count", "max"] as const).includes(args.sort_by as "total") ? (args.sort_by as "total" | "avg" | "count" | "max") : "total"
      let list = facts.kernels
      if (filterRe) {
        // 排行只含 Top-N：带筛选时改用 SQL 聚合，避免因 Top-N 截断漏掉目标内核
        const like = `%${String(args.filter).replace(/[%_]/g, "")}%`
        const rows = tryAll<{ demangledName: number; instances: number; totalNs: number; maxNs: number }>(
          report.db,
          `SELECT k.demangledName AS demangledName, COUNT(*) AS instances, SUM(k.end - k.start) AS totalNs, MAX(k.end - k.start) AS maxNs
           FROM CUPTI_ACTIVITY_KIND_KERNEL k JOIN StringIds s ON s.id = k.demangledName
           WHERE s.value LIKE ? GROUP BY k.demangledName ORDER BY totalNs DESC LIMIT ?`,
          like,
          top,
        )
        if (rows) {
          const names = new Map<number, string>()
          for (const r of tryAll<{ id: number; value: string }>(report.db, "SELECT id, value FROM StringIds") ?? []) names.set(r.id, r.value)
          list = rows
            .filter((r) => (filterRe ? filterRe.test(names.get(r.demangledName) ?? "") : true))
            .map((r) => ({
              name: names.get(r.demangledName) ?? String(r.demangledName),
              mangled: "",
              instances: r.instances,
              totalNs: r.totalNs,
              avgNs: r.totalNs / Math.max(1, r.instances),
              minNs: 0,
              maxNs: r.maxNs,
              p50Ns: 0,
              p50Sampled: true,
              grid: [0, 0, 0] as [number, number, number],
              block: [0, 0, 0] as [number, number, number],
              registersPerThread: 0,
              smemBytes: 0,
              streams: [] as number[],
              threadsPerBlock: 0,
              gridBlocks: 0,
              totalThreads: 0,
            }))
        }
      }
      const sorted = [...list].sort((a, b) =>
        sortBy === "avg" ? b.avgNs - a.avgNs : sortBy === "count" ? b.instances - a.instances : sortBy === "max" ? b.maxNs - a.maxNs : b.totalNs - a.totalNs,
      )
      const lines = [
        `内核排行（按 ${sortBy}；共 ${formatInt(facts.kernelDistinctGroups)} 个不同内核、${formatInt(facts.kernelInstances)} 次调用；聚合 ${aggregateNote(agg)}，分析总耗时 ${(elapsed / 1000).toFixed(2)}s${report.importNote ? "，含首次解析" : ""}）`,
        "",
        renderTable(
          ["内核", "调用", "总耗时", "占比", "平均", "最大", "网格", "块"],
          sorted.slice(0, top).map((k) => [
            k.name.length > 52 ? `${k.name.slice(0, 49)}...` : k.name,
            formatInt(k.instances),
            formatNs(k.totalNs),
            formatPct(k.totalNs / Math.max(1, facts.kernelTotalNs)),
            formatNs(k.avgNs),
            formatNs(k.maxNs),
            k.grid.join("×"),
            k.block.join("×"),
          ]),
        ),
      ]
      if (facts.kernelDistinctGroups > ANALYSIS_LIMITS.topRows) {
        lines.push("")
        lines.push(`注：默认排行取自单趟扫描的 Top-${ANALYSIS_LIMITS.topRows} 聚合；如需查看不在排行内的内核，用 kernel 参数下钻或 filter 筛选（会走 SQL 精确聚合）。`)
      }
      return { output: lines.join("\n"), data: { kernels: sorted.slice(0, top) } }
    } finally {
      report.close()
    }
  },
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i")
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- timeline

export const timelineTool: Tool = {
  name: "timeline",
  description:
    "时间线细节：GPU 空闲缝排行（含前后邻接活动，定位「谁把 GPU 挂住了」）、同流相邻内核的启动间隔、流并行度（是否多流重叠）、分桶占用序列（用于定位空闲集中出现的时段）。排查利用率低与串行化的主工具。",
  parameters: schema({
    ...REPORT_PARAM,
    gap_min_ms: { type: "number", description: "空闲缝下限（毫秒，默认 0.05）" },
    ...WINDOW_PARAMS,
    top: { type: "number", description: "条数（默认 10）" },
  }, ["report"]),
  outputSchema: schema({
    gaps: { type: "array", description: "空闲缝（含前后邻接活动）" },
    launchGaps: { type: "array", description: "同流启动间隔排行" },
    streams: { type: "array", description: "流统计" },
    timeline: { type: "array", description: "占用序列" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, "nsys")
    if (missing) return { output: missing, data: {} }
    const gapMinNs = Math.max(0, Number(args.gap_min_ms ?? 0.05) * 1e6)
    const top = Math.max(1, Math.min(50, Number(args.top ?? 10)))
    const report = await openNsysReport(ctx, env, String(args.report))
    try {
      const t = withTiming()
      const win = await resolveWindow(report, args as Record<string, unknown>)
      const agg = await resolveTimelineFacts(report, { gapMinNs, fromNs: win.fromNs, toNs: win.toNs })
      const facts = agg.facts
      const topGaps = facts.gaps.slice(0, top)
      const neighbours = topGaps.length ? gapNeighbours(report, topGaps) : []
      const elapsed = t()
      const lines: string[] = []
      lines.push(`报告：${report.ref.path}｜活动窗口 ${formatNs(facts.windowNs)}｜利用率 ${formatPct(facts.utilization)}｜聚合 ${aggregateNote(agg)}｜分析总耗时 ${(elapsed / 1000).toFixed(2)}s`)
      lines.push("")
      lines.push(`【GPU 空闲缝】共 ${facts.gapCount} 段（≥ ${formatNs(gapMinNs)}），合计 ${formatNs(facts.gapTotalNs)}${facts.gapsTruncated ? "（段数过多，仅保留前 5 万段）" : ""}`)
      if (!facts.gapCount) lines.push("（无显著空闲缝——GPU 持续有活动）")
      else {
        lines.push(
          renderTable(
            ["空闲时长", "起始", "前序活动", "后续活动"],
            topGaps.map((g, i) => [
              formatNs(g.durNs),
              formatNs(g.start),
              (neighbours[i]?.before ?? "（无内核）").slice(0, 42),
              (neighbours[i]?.after ?? "（无内核）").slice(0, 42),
            ]),
          ),
        )
        lines.push("解读：空闲缝前序是 kernel → 看后续 kernel 的启动延迟（主机侧准备或同步）；前序为空 → 空闲出现在采集初期或纯主机阶段。")
      }
      lines.push("")
      lines.push("【同流启动间隔】Top（相邻内核之间的空隙，反映主机侧提交节奏）")
      if (!facts.launchGaps.length) lines.push("（同流内核之间无明显空隙）")
      else {
        lines.push(
          renderTable(
            ["间隔", "流", "从", "到"],
            facts.launchGaps.slice(0, top).map((g) => [formatNs(g.gapNs), String(g.streamId), g.from.slice(0, 40), g.to.slice(0, 40)]),
          ),
        )
      }
      lines.push("")
      lines.push("【流与并行度】")
      lines.push(`流数 ${facts.streams.length}，最大并发内核 ${facts.maxConcurrent}${facts.maxConcurrent <= 1 ? "（无并行——全部工作串行）" : "（存在并行执行）"}`)
      lines.push(
        renderTable(
          ["流", "内核数", "内核耗时", "传输数", "传输字节", "首次活动", "末次活动"],
          facts.streams.slice(0, top).map((s) => [
            String(s.streamId),
            formatInt(s.kernelInstances),
            formatNs(s.kernelTotalNs),
            formatInt(s.memcpyCount),
            formatBytes(s.memcpyBytes),
            formatNs(s.firstStart),
            formatNs(s.lastEnd),
          ]),
        ),
      )
      const scaleInfo = timelineScale(facts)
      lines.push("")
      lines.push(`【时间线占用】每字符 ≈ ${formatNs(scaleInfo.spanNs / Math.max(1, scaleInfo.points))}（宽度 = 占用率）`)
      lines.push(`  ${sparkline(facts.timeline)}`)
      return {
        output: lines.join("\n"),
        data: { gaps: topGaps.map((g, i) => ({ ...g, ...neighbours[i] })), launchGaps: facts.launchGaps, streams: facts.streams, timeline: facts.timeline },
      }
    } finally {
      report.close()
    }
  },
}

// ---------------------------------------------------------------- query

export const queryTool: Tool = {
  name: "query",
  description:
    "事件库只读查询：schema 动作列出事件表与行列结构（含行数，便于确认报告采集了哪些维度）；run 动作执行单条只读 SQL（SELECT/WITH/PRAGMA）直接查事件表——标准报告未覆盖的维度（自定义聚合、特定时间窗、特定流/内核明细）用 SQL 精确获取。",
  parameters: schema({
    ...REPORT_PARAM,
    action: { type: "string", enum: ["schema", "run"], description: "动作（默认 schema）" },
    sql: { type: "string", description: "只读 SQL（action=run；仅限单条 SELECT/WITH/PRAGMA）" },
    table_filter: { type: "string", description: "schema 动作的表名正则筛选（如 CUPTI_ACTIVITY）" },
    limit: { type: "number", description: "结果行数上限（默认 50，上限 500）" },
  }, ["report"]),
  outputSchema: schema({
    tables: { type: "array", description: "schema 动作：表名/行数/列结构" },
    rows: { type: "array", description: "run 动作：查询结果行" },
    truncated: { type: "boolean", description: "结果是否被行数上限截断" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, "nsys")
    if (missing) return { output: missing, data: {} }
    const report = await openNsysReport(ctx, env, String(args.report))
    try {
      const action = String(args.action ?? "schema")
      if (action === "schema") {
        const filter = args.table_filter ? safeRegex(String(args.table_filter)) : null
        const allTables = listTables(report.db)
          .filter((t) => !/^ENUM_/.test(t))
          .filter((t) => /ACTIVITY|NVTX|StringIds|TARGET_INFO|META_DATA|ProcessStreams|ThreadNames/.test(t))
        const tables = filter ? allTables.filter((t) => filter.test(t)) : allTables
        const described = describeTables(report.db, tables)
        const loaded = described.filter((t) => t.rows > 0)
        const empty = described.filter((t) => t.rows === 0)
        const enumTables = listTables(report.db).filter((t) => /^ENUM_/.test(t))
        const lines = [
          `事件表 ${described.length} 个（非空 ${loaded.length}，空 ${empty.length}）` +
            (filter ? `｜已按 table_filter 过滤：全部候选 ${allTables.length} 个` : "") +
            `｜枚举表 ${enumTables.length} 个（可用 action=run 直接查）：`,
          "",
          renderTable(["表", "行数", "列数"], loaded.map((t) => [t.table, formatInt(t.rows), String(t.columns.length)])),
          // 空表同样列出：它们回答的是「哪些维度没采到」，隐藏会让人误以为不存在该维度
          ...(empty.length
            ? ["", `存在但 0 行（该维度本次未采集）：${empty.map((t) => t.table).join("、")}`]
            : []),
          "",
          "列结构（按表）:",
          ...loaded.map((t) => `  ${t.table}: ${t.columns.map((c) => c.name).join(", ")}`),
          "",
          `枚举列取值映射：直接查对应 ENUM_ 表（如 SELECT * FROM ENUM_CUDA_SYNC_TYPE LIMIT 20）。` +
            `**枚举列本身是数值，直接过滤/分组即可**（如 WHERE syncType = 2），不要 JOIN 枚举表。` +
            (enumTables.length ? `可用：${enumTables.slice(0, 12).join("、")}${enumTables.length > 12 ? "…" : ""}` : ""),
          `字符串表 StringIds(id, value) 用于把 demangledName/mangledName/nameId/textId 还原为名称。`,
          "",
          "常用查询示例：",
          "  · 最慢的 10 次传输：SELECT (end-start) AS dur, bytes, copyKind FROM CUPTI_ACTIVITY_KIND_MEMCPY ORDER BY dur DESC LIMIT 10",
          "  · 某内核的调用序列：SELECT start, end-start AS dur, streamId FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE demangledName IN (SELECT id FROM StringIds WHERE value LIKE '%名字%') ORDER BY start LIMIT 50",
          "  · 时间窗内的活动：SELECT COUNT(*), SUM(end-start) FROM CUPTI_ACTIVITY_KIND_KERNEL WHERE start BETWEEN ? AND ?",
        ]
        return { output: lines.join("\n"), data: { tables: described } }
      }
      if (!args.sql) return { output: "action=run 需要 sql 参数（单条只读 SELECT/WITH/PRAGMA）", data: {} }
      const sql = String(args.sql)
      assertReadOnlySql(sql)
      const limit = Math.max(1, Math.min(500, Number(args.limit ?? 50)))
      const t = withTiming()
      const all = tryAll<Record<string, unknown>>(report.db, sql)
      const elapsed = t()
      if (!all) {
        // 失败时直接给出可用表名与枚举列用法：避免“想看表名得先知道表名”的往返
        const available = listTables(report.db).filter(
          (t) => !/^ENUM_/.test(t) && /ACTIVITY|NVTX|StringIds|TARGET_INFO|ProcessStreams|ThreadNames/.test(t),
        )
        return {
          output: [
            `查询失败（SQL 语法或表/列不存在）：`,
            sql,
            "",
            "排查提示：",
            `  · 可用事件表：${available.join("、") || "（无）"}`,
            "  · 枚举列（如 syncType / copyKind）本身存的就是数值：直接过滤或分组（WHERE syncType = 2），**不要 JOIN 枚举表**；",
            "    id → 标签的映射去查 ENUM_* 表自身（如 SELECT * FROM ENUM_CUDA_SYNC_TYPE）。",
            "  · 完整列结构（含空表）用 action=schema 查看。",
            "  · 内核/API 名称需经 StringIds 还原：JOIN StringIds s ON x.demangledName = s.id。",
          ].join("\n"),
          data: {},
        }
      }
      const truncated = all.length > limit
      const rows = all.slice(0, limit)
      if (!rows.length) return { output: `查询无结果（${(elapsed / 1000).toFixed(2)}s）：\n${sql}`, data: { rows: [], truncated: false } }
      const headers = Object.keys(rows[0]!)
      const lines = [
        `查询返回 ${formatInt(all.length)} 行${truncated ? `（仅显示前 ${limit} 行）` : ""}，耗时 ${(elapsed / 1000).toFixed(2)}s`,
        "",
        renderTable(headers, rows.map((r) => headers.map((h) => String(r[h] ?? "")))),
      ]
      return { output: lines.join("\n"), data: { rows, truncated } }
    } finally {
      report.close()
    }
  },
}

// ---------------------------------------------------------------- findings

export const findingsTool: Tool = {
  name: "findings",
  description:
    "性能问题诊断（核心工具）：把时间线度量转成按严重度与可回收时间排序的问题清单——每条含量化证据（报告中实测值）、根因、修复方向与关联符号。配合 nsight_locate 可把符号落到源码 文件:行；配合 nsight_kernel_detail 对热点内核做硬件计数器级确认。",
  parameters: schema({
    ...REPORT_PARAM,
    gap_min_ms: { type: "number", description: "空闲缝下限（毫秒，默认 0.05）" },
    severity_min: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "最低严重度（默认 info 全量）" },
    locate: { type: "boolean", description: "是否自动把问题符号定位到项目源码（默认 false；需 project 参数指向工程）" },
    project: { type: "string", description: "源码工程根（预置项目名/路径/保留名 tmp）——locate=true 时的搜索范围" },
    ...EXPORT_PARAMS,
    ...WINDOW_PARAMS,
  }, ["report"]),
  outputSchema: schema({
    findings: { type: "array", description: "问题清单：id/severity/title/evidence/cause/suggestion/symbols/reclaimableNs" },
    metrics: { type: "object", description: "判定依据的会话级度量" },
    skipped: { type: "array", description: "未能分析的维度说明" },
    locations: { type: "array", description: "locate=true 时的源码定位结果" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, "nsys")
    if (missing) return { output: missing, data: {} }
    const gapMinNs = Math.max(0, Number(args.gap_min_ms ?? 0.05) * 1e6)
    const report = await openNsysReport(ctx, env, String(args.report))
    try {
      const t = withTiming()
      const win = await resolveWindow(report, args as Record<string, unknown>)
      const agg = await resolveTimelineFacts(report, { gapMinNs, fromNs: win.fromNs, toNs: win.toNs })
      const facts = agg.facts
      const api = apiFacts(report)
      const sync = syncFacts(report)
      const nvtx = nvtxFacts(report)
      const dev = deviceFacts(report)
      const overhead = overheadFacts(report, { fromNs: facts.firstActivityNs, toNs: facts.lastActivityNs })
      const graph = graphFacts(report)
      const topGaps = facts.gaps.slice(0, 5)
      const diagnosis = diagnoseNsys({
        facts,
        api,
        sync,
        nvtx,
        devices: dev.devices,
        overhead,
        graph,
        gapNeighbours: topGaps.length ? gapNeighbours(report, topGaps) : undefined,
      })
      const elapsed = t()
      const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
      const minSev = (args.severity_min as Severity) ?? "info"
      const shown = diagnosis.findings.filter((f) => rank[f.severity] <= rank[minSev])

      const lines: string[] = []
      lines.push(`报告：${report.ref.path}`)
      lines.push(`${scaleNote(reportScale(report))}｜聚合 ${aggregateNote(agg)}｜分析总耗时 ${(elapsed / 1000).toFixed(2)}s（问题判定基于流式聚合事实，与报告规模无关）`)
      if (win.note) lines.push(win.note)
      lines.push("")
      lines.push(`【问题清单】${shown.length} 项（按严重度与可回收时间排序）`)
      for (const f of shown) {
        lines.push("")
        lines.push(`● [${severityLabel(f.severity)}] ${f.title}`)
        for (const e of f.evidence) lines.push(`    证据：${e}`)
        lines.push(`    根因：${f.cause}`)
        lines.push(`    建议：${f.suggestion}`)
        if (f.reclaimableNs > 0) lines.push(`    可回收时间上限：${formatNs(f.reclaimableNs)}`)
      }
      if (diagnosis.skipped.length) {
        lines.push("")
        lines.push(`【未分析的维度】${diagnosis.skipped.join("；")}`)
      }
      lines.push("")
      lines.push("【度量摘要】")
      for (const [k, v] of Object.entries(diagnosis.metrics)) lines.push(`  ${k}: ${v}`)

      // 符号汇总：交由 locate 定位（或提示可用 nsight_locate）
      const symbols = [...new Map(diagnosis.findings.flatMap((f) => f.symbols).map((s) => [`${s.kind}:${s.value}`, s])).values()]
      const kernelSyms = symbols.filter((s) => s.kind === "kernel")
      lines.push("")
      lines.push(`【关联符号】${symbols.length} 个（内核 ${kernelSyms.length}、API ${symbols.filter((s) => s.kind === "api").length}、NVTX ${symbols.filter((s) => s.kind === "nvtx").length}）`)
      for (const s of symbols.slice(0, 8)) lines.push(`  ${s.kind}: ${s.value.slice(0, 100)}${s.weightNs ? `（${formatNs(s.weightNs)}）` : ""}`)

      let locations: unknown[] | undefined
      let locSummary: Awaited<ReturnType<typeof locateSymbols>> | undefined
      if (args.locate === true) {
        const locT = withTiming()
        const summary = await locateSymbols(ctx, symbols.filter((s) => s.kind !== "api").slice(0, 12))
        locSummary = summary
        locations = summary.results as unknown[]
        lines.push("")
        lines.push(`【源码定位】（扫描 ${formatInt(summary.scannedFiles)} 个源文件、${formatBytes(summary.scannedBytes)}，耗时 ${(locT() / 1000).toFixed(2)}s）`)
        lines.push(...renderLocate(summary))
      } else {
        lines.push("")
        lines.push("下一步：把符号落到源码用 nsight_locate（传 report 可自动取本报告的问题符号，或显式传 kernel 名）；对热点内核做硬件计数器级确认用 nsight_kernel_detail（需 .ncu-rep）。")
      }

      // 导出：把本次分析落成 Markdown（证据与源码位置一并保留，便于归档/贴给同事）
      const wantExport = parseExportArgs(args as Record<string, unknown>)
      let saved: SaveResult | null = null
      if (wantExport) {
        const md = renderMarkdown({
          title: `Nsight 报告分析：${report.ref.name}`,
          meta: [
            `报告：${report.ref.path}`,
            `${scaleNote(reportScale(report))}｜聚合 ${aggregateNote(agg)}｜分析耗时 ${(elapsed / 1000).toFixed(2)}s`,
            `生成时间：${new Date().toISOString()}`,
          ],
          sections: [
            {
              title: "问题清单",
              lines: shown.flatMap((f) => [
                `### [${severityLabel(f.severity)}] ${f.title}`,
                "",
                ...f.evidence.map((e) => `- 证据：${e}`),
                `- 根因：${f.cause}`,
                `- 建议：${f.suggestion}`,
                ...(f.reclaimableNs > 0 ? [`- 可回收时间上限：${formatNs(f.reclaimableNs)}`] : []),
                "",
              ]),
            },
            ...(diagnosis.skipped.length ? [{ title: "未分析的维度", lines: diagnosis.skipped.map((s) => `- ${s}`) }] : []),
            { title: "度量摘要", lines: Object.entries(diagnosis.metrics).map(([k, v]) => `- ${k}: ${v}`) },
            {
              title: "关联符号",
              lines: symbols.map((s) => `- ${s.kind}: \`${s.value}\`${s.weightNs ? `（${formatNs(s.weightNs)}）` : ""}`),
            },
            ...(locSummary ? [{ title: "源码定位", lines: ["\`\`\`text", ...renderLocate(locSummary), "\`\`\`"] }] : []),
          ],
        })
        try {
          saved = saveMarkdown({ dir: wantExport.dir, base: `nsight-${report.ref.stem}`, projectRoot: ctx.workdir, text: md })
        } catch (e) {
          lines.push("", exportNote(null, e))
        }
        if (saved) lines.push("", exportNote(saved))
      }

      return {
        output: lines.join("\n"),
        data: { findings: shown, metrics: diagnosis.metrics, skipped: diagnosis.skipped, locations, savedPath: saved?.path },
      }
    } finally {
      report.close()
    }
  },
}


// ---------------------------------------------------------------- compare

/**
 * 度量方向：只给**确实有好坏之分**的度量声明方向。
 *
 * 「GPU 利用率」越高越好（同一负载下）故列高优；「GPU 忙碌时间」「内核总时长」是描述性指标
 * （忙不等于好、内核时间短也可能是活变少），故不声明方向——只给变化量，不下判断。
 */
const HIGHER_IS_BETTER = new Set(["GPU 利用率"])
const LOWER_IS_BETTER = new Set([
  "会话时长",
  "空闲缝总时长",
  "空闲缝数量",
  "同步等待总时长",
  "显存传输总时长",
  "CUDA API 总时长",
  "采集开销占比（窗口内）",
])

/**
 * 把诊断度量转成可对比项：数值 + **单位** + 方向。
 *
 * 单位必须解析出来——"3.9 MB" 与 "679.0 KB" 若都按裸数字比较会得出完全相反的结论。
 * 展示文本形如 "1.23 ms" / "45.6%" / 纯计数，单位按后缀识别（缺后缀视为无单位）。
 */
function metricsOf(metrics: Record<string, number | string>): CompareMetric[] {
  return Object.entries(metrics).map(([name, raw]) => {
    const text = String(raw)
    const m = /^\s*(-?[0-9.]+)\s*([A-Za-z%μ]*)\s*$/.exec(text)
    const higher = HIGHER_IS_BETTER.has(name) ? true : LOWER_IS_BETTER.has(name) ? false : undefined
    if (!m) return { name, higherIsBetter: higher, text }
    const value = Number.parseFloat(m[1]!)
    return { name, value: Number.isFinite(value) ? value : undefined, unit: m[2] || "", higherIsBetter: higher, text }
  })
}

/** 派生一份报告的对比快照（复用 findings 的取数与诊断路径，保证与单据分析同一口径）。 */
async function snapshotOf(
  ctx: ToolContext,
  env: Awaited<ReturnType<typeof resolveNsightEnv>>,
  reportPath: string,
  gapMinNs: number,
  gapMinNsDefault: number,
): Promise<SideSnapshot> {
  const report = await openNsysReport(ctx, env, reportPath)
  try {
    const agg = await resolveTimelineFacts(report, { gapMinNs })
    const facts = agg.facts
    const api = apiFacts(report)
    const sync = syncFacts(report)
    const nvtx = nvtxFacts(report)
    const dev = deviceFacts(report)
    const overhead = overheadFacts(report, { fromNs: facts.firstActivityNs, toNs: facts.lastActivityNs })
    const graph = graphFacts(report)
    const diagnosis = diagnoseNsys({ facts, api, sync, nvtx, devices: dev.devices, overhead, graph })
    void gapMinNsDefault
    return {
      label: report.ref.name,
      metrics: metricsOf(diagnosis.metrics),
      findings: diagnosis.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, reclaimableNs: f.reclaimableNs })),
    }
  } finally {
    report.close()
  }
}

export const compareTool: Tool = {
  name: "compare",
  description:
    "报告间对比（改前改后 / 两次采集）：把两份 Nsight 报告的关键度量与问题清单做差异比对——利用率与忙碌是否改善、空闲与同步是否下降、哪些问题消失、哪些新出现。度量按同名对齐（仅一侧有的如实标注，不做推算），问题按 id 对齐。",
  parameters: schema(
    {
      before: { type: "string", description: "基准报告路径（改前）" },
      after: { type: "string", description: "对比报告路径（改后）" },
      gap_min_ms: { type: "number", description: "空闲缝下限（毫秒，默认 0.05；两侧同口径）" },
    },
    ["before", "after"],
  ),
  outputSchema: schema({
    metrics: { type: "array", description: "度量差异（name/kind/beforeText/afterText/changePct）" },
    findings: { type: "array", description: "问题差异（id/title/kind 新增或消失或变化）" },
    reclaimableDeltaNs: { type: "number", description: "问题总代价净变化（后侧全部问题 − 前侧全部问题，含新增/消失；负 = 下降）" },
    beforeReclaimableNs: { type: "number", description: "前侧问题可回收时间合计" },
    afterReclaimableNs: { type: "number", description: "后侧问题可回收时间合计" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, "nsys")
    if (missing) return { output: missing, data: {} }
    const t = withTiming()
    const gapMinNs = Math.max(0, Number(args.gap_min_ms ?? 0.05) * 1e6)
    const before = await snapshotOf(ctx, env, String(args.before), gapMinNs, 0)
    const after = await snapshotOf(ctx, env, String(args.after), gapMinNs, 0)
    const result = compareSnapshots(before, after)
    const lines: string[] = []
    lines.push(...renderCompare(before, after, result, formatNs))
    lines.push("")
    lines.push(`（两份报告的分析总耗时 ${(t() / 1000).toFixed(2)}s；两侧均按同一空闲缝下限 ${formatNs(gapMinNs)} 口径）`)
    return { output: lines.join("\n"), data: result as unknown as Record<string, unknown> }
  },
}

// ---------------------------------------------------------------- locate

export const locateTool: Tool = {
  name: "locate",
  description:
    "把报告符号定位到工程源码（定位到代码问题的关键一步）：输入内核符号/NVTX 名/源文件名（或直接给 report 自动取该报告的问题符号），在工程内搜索内核定义（__global__）、启动点（<<<>>>）、NVTX 打点与名称引用，返回 文件:行 与上下文。",
  parameters: schema(
    {
      ...REPORT_PARAM,
      symbols: { type: "array", items: { type: "string" }, description: "要定位的符号（内核名可用报告中的 demangled 全名，工具会自动去模板参数归一）" },
      extra_terms: { type: "array", items: { type: "string" }, description: "附加搜索词（如工程内的函数名/文件名）" },
    },
    [],
  ),
  outputSchema: schema({
    results: { type: "array", description: "每个符号的定位结果（matches 含 path/line/kind/text）" },
    scannedFiles: { type: "number" },
    scanTruncated: { type: "boolean", description: "扫描是否因上限提前结束（结果可能不完整）" },
  }),
  async execute(args, ctx): Promise<ToolResult> {
    let symbols: SymbolHint[] = []
    if (args.symbols) {
      const list = Array.isArray(args.symbols) ? args.symbols : [args.symbols]
      symbols = list.map((s) => ({ kind: inferKind(String(s)), value: String(s) }))
    }
    if (args.report) {
      const env = await resolveNsightEnv(ctx)
      const missing = missingToolchainNote(env, "nsys")
      if (missing) return { output: missing, data: {} }
      const report = await openNsysReport(ctx, env, String(args.report))
      try {
        const agg = await resolveTimelineFacts(report)
      const facts = agg.facts
        const collected: SymbolHint[] = [
          ...facts.kernels.slice(0, 8).map((k) => ({ kind: "kernel" as const, value: k.mangled || k.name, weightNs: k.totalNs })),
        ]
        // 该报告的自由查询：把已有的发现符号也带上（不重跑诊断时给内核为主）
        symbols = [...symbols, ...collected]
      } finally {
        report.close()
      }
    }
    if (!symbols.length) {
      return { output: "需要 symbols 参数（符号列表）或 report 参数（自动取该报告的热点内核符号）。", data: {} }
    }
    const uniq = [...new Map(symbols.map((s) => [`${s.kind}:${s.value}`, s])).values()].slice(0, 15)
    const t = withTiming()
    const summary = await locateSymbols(ctx, uniq, { extraTerms: Array.isArray(args.extra_terms) ? (args.extra_terms as unknown[]).map(String) : [] })
    const elapsed = t()
    const lines = [
      `源码定位：搜索 ${formatInt(summary.scannedFiles)} 个源文件、${formatBytes(summary.scannedBytes)}，耗时 ${(elapsed / 1000).toFixed(2)}s`,
      `工程根：${summary.root}${summary.scanTruncated ? "（扫描达上限，可能不完整——可用 project 缩小范围）" : ""}`,
      "",
      ...renderLocate(summary),
    ]
    return { output: lines.join("\n"), data: { results: summary.results, scannedFiles: summary.scannedFiles, scanTruncated: summary.scanTruncated } }
  },
}

/** 符号类型推断：内核名含模板/括号或 __global__ 迹象；纯路径视为文件；其余按引用处理。 */
function inferKind(value: string): SymbolHint["kind"] {
  if (/\.(cu|cuh|cpp|h|hpp|py)$/i.test(value)) return "file"
  if (/^_Z|\(|<.*>/.test(value)) return "kernel"
  return "kernel"
}

/** 供 nsight.ts 汇总。 */
export const analysisTools: Record<string, Tool> = {
  doctor: doctorTool,
  reports: reportsTool,
  overview: overviewTool,
  kernels: kernelsTool,
  timeline: timelineTool,
  query: queryTool,
  findings: findingsTool,
  locate: locateTool,
  compare: compareTool,
}
