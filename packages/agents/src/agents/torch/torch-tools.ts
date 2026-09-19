/**
 * PyTorch Profiler（Chrome Trace / Kineto）工具集：概览、算子排行、显存分析、问题诊断。
 *
 * 与 nsys 工具集同一纪律：全部只读、结果有界、耗时与数据来源如实回报；
 * 判定按 trace 实际具备的维度裁剪，缺维度时**明确说明缺什么、怎么补**（不当作没问题）。
 */
import type { Tool, ToolContext, ToolResult } from "@gebai/sdk"
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_SCAN_BUDGET_MS, aggregateTorchTrace, readTraceFlags, type TorchFacts, type TorchOpStat } from "./torch-trace"
import type { JsonArrayScanStats } from "./jsonstream"
import { diagnoseTorch, isUserCode, TORCH_THRESHOLDS, userSites, type TorchFinding } from "./torch-findings"
import { statTrace, traceAccessError, traceChangedReason, type TraceRef } from "./torch-report"
import { fingerprintOf } from "../../core/perf/input"
import { locateSymbols, renderLocate, type SymbolHint } from "../../core/perf/locate"
import { EXPORT_PARAMS, exportNote, parseExportArgs, renderMarkdown, saveMarkdown, type SaveResult } from "../../core/perf/export"
import { compareSnapshots, renderCompare, type CompareMetric, type SideSnapshot } from "../../core/perf/compare"
import { formatBytes, formatInt, formatPct, renderTable, schema, sparkline } from "../../core/perf/format"
import { withTiming } from "../../core/perf/timing"

const REPORT_PARAM = {
  report: { type: "string", description: "PyTorch Profiler trace 路径（*.pt.trace.json / *.pt.trace.json.gz / *.trace.json / *.json，可带 .gz）；相对路径以当前工作目录或 project 根为基准" },
}
const BUDGET_PARAM = {
  budget: { type: "number", description: `本次扫描的时间预算（秒；缺省 ${Math.round(DEFAULT_SCAN_BUDGET_MS / 1000)}）。超预算会返回「未完成」与可后台执行的命令，不抛超时错误；传 0 表示不限（受引擎单次工具调用 9 分钟上限约束）` },
}
const LOCATE_PARAM = { locate: { type: "boolean", description: "是否把热点定位到工程源码（用 trace 里 python_function 的 `文件(行)`）" } }
void LOCATE_PARAM

// ---------------------------------------------------------------- 事实缓存

/**
 * 聚合事实按「路径 + 大小 + mtime」缓存（同报告二次分析秒回）。
 * 两级：内存（本进程）→ 落盘（{GEBAI_HOME}/cache/torch，指纹同名文件）——
 * 落盘缓存让「后台跑一次完整分析 → 下次工具调用直接命中」可行（见 pendingResult）。
 */
interface Cached {
  key: string
  facts: TorchFacts
}
const cache = new Map<string, Cached>()

/** 扫描耗时超过此值的 trace 才落盘（小 trace 重扫本就是毫秒级，落盘只是额外写入）。 */
export const PERSIST_MIN_SCAN_MS = 2_000

/** 事实缓存键：文件路径 + 大小 + mtime（与共用指纹口径一致）。 */
function cacheKeyOf(ref: TraceRef): string {
  return fingerprintOf(ref)
}

/** 清空事实缓存（测试用）。 */
export function resetTorchFactsCache(): void {
  cache.clear()
}

/** 事实落盘目录（TORCH_CACHE_DIR 覆盖，缺省 {GEBAI_HOME}/cache/torch）。 */
export function torchCacheDir(ctx: ToolContext): string {
  return ctx.env.TORCH_CACHE_DIR?.trim() || join(ctx.home, "cache", "torch")
}

/** 事实缓存文件路径（缓存键入名，与内存缓存同一指纹口径）。 */
export function factsCachePath(ctx: ToolContext, ref: { name: string; size: number; mtimeMs: number }): string {
  const stem = ref.name.replace(/[^\w.-]+/g, "_").slice(0, 80)
  return join(torchCacheDir(ctx), `${stem}-${ref.size}-${Math.round(ref.mtimeMs)}.json`)
}

/** 读落盘事实（结构不符/损坏均当未命中，回退重新扫描）。 */
export function readFactsCache(cacheFile: string): TorchFacts | undefined {
  try {
    if (!existsSync(cacheFile)) return undefined
    const v = JSON.parse(readFileSync(cacheFile, "utf8")) as TorchFacts
    if (!v || typeof v !== "object" || typeof v.scale?.events !== "number" || !Array.isArray(v.ops) || !v.timeline) return undefined
    return v.incomplete ? undefined : v
  } catch {
    return undefined
  }
}

/** 事实落盘（目录自动创建；失败不影响本次分析）。 */
async function writeFactsCache(cacheFile: string, facts: TorchFacts): Promise<void> {
  try {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(dirname(cacheFile), { recursive: true })
    await Bun.write(cacheFile, JSON.stringify(facts))
  } catch {
    // 落盘失败只影响下次是否命中缓存，不影响本次结果
  }
}

export interface LoadedFacts {
  ref: TraceRef
  facts: TorchFacts
  elapsedMs: number
  reused: boolean
  /** 本次 trace 的落盘事实文件（后台命令与缓存可见性用）。 */
  cacheFile: string
  /** 最近一次扫描进度（未完成时用于展示已扫多少）。 */
  progress?: JsonArrayScanStats
}

export async function loadTorchFacts(ctx: ToolContext, input: unknown): Promise<LoadedFacts> {
  const args = (input ?? {}) as { report?: string; budget?: number }
  if (!args.report) throw new Error("需要 report 参数（PyTorch Profiler trace 路径）")
  const ref = statTrace(ctx, args.report)
  const cacheFile = factsCachePath(ctx, ref)
  const key = cacheKeyOf(ref)
  const hit = cache.get(key)
  if (hit) return { ref, facts: hit.facts, elapsedMs: 0, reused: true, cacheFile }
  const onDisk = readFactsCache(cacheFile)
  if (onDisk) {
    cache.set(key, { key, facts: onDisk })
    return { ref, facts: onDisk, elapsedMs: 0, reused: true, cacheFile }
  }
  const budgetSec = Number(args.budget)
  const budgetMs = Number.isFinite(budgetSec) ? Math.max(0, budgetSec) * 1000 : undefined
  const t0 = withTiming()
  let progress: JsonArrayScanStats | undefined
  let facts: TorchFacts
  try {
    facts = await aggregateTorchTrace(ref.path, { budgetMs, onProgress: (s) => (progress = s) })
  } catch (err) {
    // TOCTOU：分析期间文件被删除/不可读时给可操作提示（不暴露原始系统错误）
    throw traceAccessError(ref, err) ?? err
  }
  const elapsedMs = t0()
  // TOCTOU：扫描前后一致性校验（大小/mtime 变化即视为分析期间被改写）
  const changed = traceChangedReason(ref)
  if (changed) throw new Error(changed)
  if (!facts.incomplete) {
    cache.set(key, { key, facts })
    if (facts.scanMs >= PERSIST_MIN_SCAN_MS) await writeFactsCache(cacheFile, facts)
  }
  return { ref, facts, elapsedMs, reused: false, cacheFile, progress }
}

/** 「未完成」结果的统一输出（四个分析工具共用）：不把部分结果当结论，并给出可后台执行的完整命令。 */
export function pendingResult(loaded: LoadedFacts): ToolResult {
  const { ref, facts, cacheFile, progress } = loaded
  const inc = facts.incomplete!
  const scanned = progress?.scannedChars ?? inc.scannedChars
  const command = scanCommand(ref, cacheFile)
  const lines: string[] = []
  lines.push(`trace：${ref.path}`)
  lines.push(
    `【本次分析未完成】trace 较大（${formatBytes(ref.size)}）：已扫描 ${formatBytes(scanned)}（${formatInt(inc.events)} 事件），用时 ${(inc.elapsedMs / 1000).toFixed(1)}s 触及本次时间预算 ${inc.budgetMs < 1000 ? `${Math.round(inc.budgetMs)}ms` : `${(inc.budgetMs / 1000).toFixed(0)}s`}，已中止扫描以避免工具调用超时。`,
  )
  lines.push("部分聚合结果不作结论（算子/内核/显存/问题清单均未覆盖全量）——请用下面任一方式取得完整结果：")
  lines.push("")
  if (command) {
    lines.push("1) 后台跑一次完整分析（复制执行；用 sh 的 async 形式运行，完成后用 bg_task 查询）：")
    lines.push(`   ${command}`)
    lines.push("   完成后再次调用本工具，即直接命中已落盘的事实缓存并秒回（无需重复扫描）。")
    lines.push(`2) 放宽本次预算：给工具加 budget 参数（秒；引擎单次工具调用上限 9 分钟）。`)
  } else {
    // 打包/二进制形态下不存在可引用的模块文件——不给跑不通的命令，只给可执行的那条路
    lines.push("本部署形态（无仓库源码）无法给出后台命令：请给工具传更大的 budget 参数重试（秒；引擎单次工具调用上限 9 分钟）。")
  }
  return {
    output: lines.join("\n"),
    data: { path: ref.path, incomplete: inc, cacheFile, command },
  }
}

/**
 * 后台完整分析的命令：单独进程扫描并把事实写入与工具同一路径的缓存文件，
 * 完成后本工具的落盘缓存就读得到（与工具内写入的同一份 JSON）。
 * 命令为单行 `bun -e "…"`：只用单引号（PowerShell 与 bash 均可直接执行）；
 * 路径统一用正斜杠（JS 字符串里的反斜杠会被当成转义符，Windows 路径必须换写法）。
 * 模块文件不在磁盘上（打包/二进制形态）时返回 undefined——不给跑不通的命令。
 */
export function scanCommand(ref: TraceRef, cacheFile: string): string | undefined {
  const modUrl = new URL("./torch-trace.ts", import.meta.url)
  try {
    if (!existsSync(fileURLToPath(modUrl))) return undefined
  } catch {
    return undefined
  }
  const mod = modUrl.href
  const fwd = (p: string): string => p.replace(/\\/g, "/")
  const body =
    `const m=await import('${mod}');` +
    `const f=await m.aggregateTorchTrace('${fwd(ref.path)}');` +
    `await Bun.write('${fwd(cacheFile)}',JSON.stringify(f));` +
    `console.log('torch facts 已落盘',f.scale.events,'事件，扫描',(f.scanMs/1000).toFixed(1)+'s')`
  return `bun -e "${body}"`
}

// ---------------------------------------------------------------- 渲染助手

const us = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v.toFixed(1)} µs`)
const shortName = (s: string, max = 62): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

function scaleNote(facts: TorchFacts): string {
  const cats = Object.entries(facts.scale.byCategory)
    .slice(0, 5)
    .map(([k, v]) => `${k} ${formatInt(v)}`)
    .join("、")
  return `事件 ${formatInt(facts.scale.events)}（${cats}${Object.keys(facts.scale.byCategory).length > 5 ? " 等" : ""}）｜进程 ${facts.scale.processes.join("、") || "?"}｜线程 ${formatInt(facts.scale.threads)}`
}

function flagsNote(facts: TorchFacts): string {
  const flagKeys = ["profile_memory", "with_stack", "record_shapes", "with_modules"]
  const on = flagKeys.filter((k) => facts.scale.flags[k] === 1 || facts.scale.flags[k] === true)
  return on.length ? `采集开关：${on.join("、")}` : "采集开关：未记录"
}

function opRow(o: TorchOpStat): string[] {
  const shape = o.shapeSamples[0] ?? ""
  const dtype = o.dtypeSamples[0] ?? ""
  return [shortName(o.name, 46), formatInt(o.count), us(o.totalUs), us(o.selfUs), us(o.p50Us), `${shape}${dtype ? ` ${dtype}` : ""}`.slice(0, 40)]
}

function renderOps(rows: TorchOpStat[], headers: string[]): string {
  return renderTable(headers, rows.map(opRow))
}

/**
 * 前向/反向拆分一行（供 overview 与 findings 共用）：
 * trace 的 `cat:"fwdbwd"` 流事件连接前向 ATen 算子与其反向算子，故统计的是「带反向节点的那些算子」两侧耗时。
 */
function fwdBwdLine(facts: TorchFacts): string {
  const fb = facts.fwdBwd
  if (!fb.available) {
    return fb.marks > 0
      ? `前向/反向：存在 ${formatInt(fb.marks)} 对 fwdbwd 流事件但未跟随到算子活动（格式差异）——不计算拆分`
      : "前向/反向：未采集（trace 无 fwdbwd 流事件）"
  }
  const shares = fb.perStep.length && fb.perStep.length <= 6 ? `｜逐步前向/反向 ${fb.perStep.map((p) => `${p.step} ${us(p.forwardUs)}/${us(p.backwardUs)}（${formatPct(p.backwardShare)}）`).join("，")}` : ""
  return `前向/反向：前向算子合计 ${us(fb.forwardUs)}（${formatInt(fb.forwardCount)} 个，均值 ${us(fb.avgForwardUs)}）｜对应反向算子合计 ${us(fb.backwardUs)}（${formatInt(fb.backwardCount)} 个，均值 ${us(fb.avgBackwardUs)}）｜反向占比 ${formatPct(fb.backwardShare)}（${formatInt(fb.marks)} 对 fwdbwd 标记）${shares}`
}

/** 严重度的中文标签（对话输出与 Markdown 导出共用同一口径）。 */
function severityLabel(sev: TorchFinding["severity"]): string {
  return { critical: "严重", high: "高", medium: "中", low: "低", info: "提示" }[sev]
}

/** 问题清单渲染（与 nsys findings 同构：严重度、证据、根因、建议、可回收上限、符号）。 */
function renderFindings(findings: TorchFinding[], symbolsHint: string): string {
  if (!findings.length) return "未命中任何诊断规则（trace 规模过小或未采集到可判定维度）。"
  const lines: string[] = []
  for (const f of findings) {
    lines.push(`● [${severityLabel(f.severity)}] ${f.title}`)
    for (const e of f.evidence) lines.push(`    证据：${e}`)
    lines.push(`    根因：${f.cause}`)
    lines.push(`    建议：${f.suggestion}`)
    if (f.reclaimableUs > 0) lines.push(`    可回收时间上限：${us(f.reclaimableUs)}`)
    if (f.symbols.length) lines.push(`    关联符号：${f.symbols.slice(0, 4).map((s) => shortName(s, 40)).join("、")}`)
    lines.push(`    ${symbolsHint}`)
    lines.push("")
  }
  return lines.join("\n")
}

/** 收集定位用的符号（算子名归一：`aten::linear` → `linear`；python 位置直接可用）。 */
function symbolHints(facts: TorchFacts, findings: TorchFinding[]): string[] {
  const out = new Set<string>()
  for (const f of findings) for (const s of f.symbols) out.add(s)
  for (const o of facts.ops.slice(0, 6)) out.add(o.name)
  for (const k of facts.kernels.slice(0, 4)) out.add(k.name)
  return [...out].slice(0, 12)
}

// ---------------------------------------------------------------- 工具定义

const overviewTool: Tool = {
  name: "overview",
  description:
    "PyTorch Profiler trace 总览：事件规模与采集开关、时间线与 CPU/GPU 忙碌占比、步级耗时（ProfilerStep）与抖动、算子/内核/CUDA API 数量、显存峰值与碎片率、用户代码热点位置。分析 PyTorch trace 的第一步。",
  parameters: schema({
    ...REPORT_PARAM,
    ...BUDGET_PARAM,
    top: { type: "number", description: "各排行展示条数（默认 10，上限 50）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const loaded = await loadTorchFacts(ctx, input)
    if (loaded.facts.incomplete) return pendingResult(loaded)
    const { ref, facts, elapsedMs, reused } = loaded
    const top = Math.min(50, Math.max(1, Number((input as { top?: number }).top ?? 10)))
    const t = facts.timeline
    const lines: string[] = []
    lines.push(`trace：${ref.path}`)
    lines.push(`${scaleNote(facts)}｜${flagsNote(facts)}｜聚合耗时 ${(facts.scanMs / 1000).toFixed(2)}s${reused ? "（命中缓存）" : ""}`)
    lines.push(`时间窗口 ${us(t.spanUs)}｜CPU 忙碌 ${us(t.cpuBusyUs)}（${formatPct(t.cpuUtilization)}）｜CPU 占用序列 ${sparkline(t.cpuSeries)}`)
    if (facts.hasGpuEvents) {
      lines.push(
        `GPU 忙碌 ${us(t.gpuBusyUs)}（${formatPct(t.gpuUtilization)}）｜空闲缝 ${formatInt(t.gpuGapCount)} 段（合计 ${us(t.gpuGapTotalUs)}）｜最大并发 ${t.gpuMaxConcurrent}｜GPU 占用序列 ${sparkline(t.gpuSeries)}`,
      )
    } else {
      lines.push(`GPU 事件：无（本 trace 仅有 CPU/内存维度——GPU 侧时间线请用 nsight_capture kind=nsys 采集）`)
    }
    lines.push("")
    if (facts.stepStats.count) {
      const s = facts.stepStats
      lines.push(`步级（ProfilerStep，共 ${s.count} 步）：中位 ${us(s.medianUs)}｜p90 ${us(s.p90Us)}｜min ${us(s.minUs)}｜max ${us(s.maxUs)}｜抖动 ${(s.maxUs / Math.max(1, s.medianUs)).toFixed(2)}×`)
      lines.push(`  ${facts.steps.slice(0, 8).map((x) => `${x.name} ${us(x.durUs)}`).join("｜")}`)
    } else {
      lines.push("步级：无 ProfilerStep 标注（改用 torch.profiler.schedule(...) + prof.step() 可得步级视图）")
    }
    lines.push(fwdBwdLine(facts))
    lines.push("")
    lines.push(`算子：${formatInt(facts.opGroups)} 类｜内核：${formatInt(facts.kernelGroups)} 类｜CUDA API：${formatInt(facts.cudaApis.length)} 类（Top ${top} 展示）`)
    lines.push("")
    lines.push(`Top ${top} 算子（按自身耗时；self=不含同类子事件）：`)
    lines.push(renderOps(facts.ops.slice(0, top), ["算子", "次数", "总耗时", "自身耗时", "p50", "形状/类型"]))
    if (facts.kernels.length) {
      lines.push("")
      lines.push(`Top ${Math.min(top, facts.kernels.length)} 内核（按总耗时）：`)
      lines.push(
        renderTable(
          ["内核", "次数", "总耗时", "自身耗时", "p50", "网格/块/寄存器"],
          facts.kernels.slice(0, top).map((k) => [
            shortName(k.name, 46),
            formatInt(k.count),
            us(k.totalUs),
            us(k.selfUs),
            us(k.p50Us),
            `${k.grid?.join("×") ?? "?"} / ${k.block?.join("×") ?? "?"} / ${k.registers ?? "?"}`,
          ]),
        ),
      )
    }
    if (facts.transfers.length) {
      lines.push("")
      lines.push("显存传输（按方向）：")
      lines.push(
        renderTable(
          ["方向", "次数", "字节", "平均包", "总耗时"],
          facts.transfers.slice(0, 8).map((x) => [x.kind, formatInt(x.count), formatBytes(x.bytes), formatBytes(x.avgBytes), us(x.totalUs)]),
        ),
      )
    }
    if (facts.memory.available) {
      const m = facts.memory
      lines.push("")
      lines.push(
        `显存：分配 ${formatInt(m.allocCount)} 次 / 释放 ${formatInt(m.freeCount)} 次｜峰值分配 ${formatBytes(m.peakAllocatedBytes)}（来源 ${m.peakSource}）｜峰值保留 ${formatBytes(m.peakReservedBytes)}｜碎片率 ${m.fragmentation.toFixed(2)}｜累计分配 ${formatBytes(m.allocatedBytes)}`,
      )
    }
    const sites = userSites(facts, top)
    if (sites.length) {
      lines.push("")
      lines.push(`用户代码热点（python_function，按自身耗时）：`)
      lines.push(
        renderTable(
          ["位置", "函数", "次数", "自身耗时", "总耗时"],
          sites.map((s) => [`${s.file}:${s.line}`, s.func, formatInt(s.count), us(s.selfUs), us(s.totalUs)]),
        ),
      )
    }
    if (facts.notes.length) {
      lines.push("")
      for (const n of facts.notes) lines.push(`说明：${n}`)
    }
    return {
      output: lines.join("\n"),
      data: {
        path: ref.path,
        elapsedMs,
        reused,
        events: facts.scale.events,
        scanMs: facts.scanMs,
        hasGpuEvents: facts.hasGpuEvents,
        hasMemoryEvents: facts.hasMemoryEvents,
        steps: facts.stepStats,
        timeline: { spanUs: t.spanUs, cpuBusyUs: t.cpuBusyUs, gpuBusyUs: t.gpuBusyUs, gpuGapTotalUs: t.gpuGapTotalUs },
        topOps: facts.ops.slice(0, top),
        topKernels: facts.kernels.slice(0, top),
        pythonSites: sites,
        notes: facts.notes,
      },
    }
  },
}

const opsTool: Tool = {
  name: "ops",
  description:
    "PyTorch trace 算子/内核下钻：按名称子串筛选（如 aten::linear、elementwise、cutlass），给出调用次数、总/自身耗时、分位数、张量形状与 dtype、内核几何（网格/块/寄存器/占用率/流），以及内核到发起算子的归属（correlation 关联）。",
  parameters: schema({
    ...REPORT_PARAM,
    ...BUDGET_PARAM,
    filter: { type: "string", description: "名称子串筛选（不区分大小写；省略则展示全部排行）" },
    kind: { type: "string", enum: ["op", "kernel", "cuda_api", "annotation", "python"], description: "查看对象类别（默认 op）" },
    top: { type: "number", description: "条数（默认 20，上限 200）" },
    sort: { type: "string", enum: ["self", "total", "count"], description: "排序键（默认：算子按 self、内核按 total）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as { report: string; filter?: string; kind?: string; top?: number; sort?: string }
    const loaded = await loadTorchFacts(ctx, input)
    if (loaded.facts.incomplete) return pendingResult(loaded)
    const { ref, facts, elapsedMs, reused } = loaded
    const kind = args.kind ?? "op"
    const top = Math.min(200, Math.max(1, Number(args.top ?? 20)))
    const source =
      kind === "kernel" ? facts.kernels : kind === "cuda_api" ? facts.cudaApis : kind === "annotation" ? facts.annotations : facts.ops
    const re = args.filter ? new RegExp(args.filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : undefined
    let rows = re ? source.filter((o) => re.test(o.name)) : [...source]
    const sortKey = args.sort ?? (kind === "kernel" ? "total" : "self")
    rows.sort((a, b) => (sortKey === "count" ? b.count - a.count : sortKey === "total" ? b.totalUs - a.totalUs : b.selfUs - a.selfUs))
    rows = rows.slice(0, top)

    const lines: string[] = []
    lines.push(`trace：${ref.path}｜类别 ${kind}${args.filter ? `｜筛选 "${args.filter}"` : ""}｜匹配 ${formatInt(rows.length)} 项（已展示）｜聚合耗时 ${(facts.scanMs / 1000).toFixed(2)}s${reused ? "（命中缓存）" : ""}`)
    if (!rows.length) {
      // 无 kernel 事件时（Windows）不在这里返回：下面的退化归属（CUDA API → 发起位置）仍有信息
      if (!(kind === "kernel" && !facts.hasGpuEvents)) {
        lines.push(args.filter ? "无匹配项——可用 torch_overview 查看全部排行，或放宽筛选。" : "本 trace 中该类别的排行为空。")
        return { output: lines.join("\n"), data: { path: ref.path, kind, rows: [] } }
      }
    } else {
      lines.push("")
      lines.push(renderOps(rows, ["名称", "次数", "总耗时", "自身耗时", "p50", "形状/类型"]))
    }
    // 详列每项的附加维度（形状/类型/几何/流），便于直接读结论
    const detail: string[] = []
    for (const o of rows.slice(0, 10)) {
      const bits: string[] = []
      if (o.shapeSamples.length) bits.push(`形状样本 ${o.shapeSamples.join(" | ")}`)
      if (o.dtypeSamples.length) bits.push(`类型 ${[...new Set(o.dtypeSamples)].join(" | ")}`)
      if (o.grid) bits.push(`网格 ${o.grid.join("×")} 块 ${o.block?.join("×") ?? "?"}`)
      if (o.registers !== undefined) bits.push(`寄存器 ${o.registers}`)
      if (o.occupancy !== undefined) bits.push(`占用率 ${o.occupancy}%`)
      if (o.sharedMemory !== undefined) bits.push(`共享内存 ${formatBytes(o.sharedMemory)}`)
      if (o.streams.length) bits.push(`流 ${o.streams.join("、")}`)
      if (o.devices.length) bits.push(`设备 ${o.devices.join("、")}`)
      if (bits.length) detail.push(`  ${shortName(o.name, 52)}｜${bits.join("｜")}`)
    }
    if (detail.length) {
      lines.push("")
      lines.push("关键属性：")
      lines.push(...detail)
    }
    // 内核归属：correlation（内核↔CUDA API 的关联字段）与流事件（实测 cat:"ac2g"）两通道
    const kernelsForFilter = args.filter ? facts.kernelAttribution.filter((a) => re!.test(a.kernel) || re!.test(a.op) || (a.api !== undefined && re!.test(a.api))) : facts.kernelAttribution
    if (kernelsForFilter.length) {
      lines.push("")
      lines.push(`内核 → 发起方（correlation 关联${facts.flows.kernelLinks ? " + 流事件（ac2g）关联" : ""}；“发起算子”为内核启动时所在的最内层 cpu_op）：`)
      lines.push(
        renderTable(
          ["内核", "发起算子", "发起 API", "发起位置（Python）", "通道", "次数", "内核耗时"],
          kernelsForFilter.slice(0, 10).map((a) => [shortName(a.kernel, 34), shortName(a.op, 26), shortName(a.api ?? "-", 20), a.python ? shortName(a.python, 30) : "-", a.via === "flow" ? "flow" : "correlation", formatInt(a.count), us(a.kernelUs)]),
        ),
      )
      if (facts.kernelAttribution.length > kernelsForFilter.length) lines.push(`（共 ${formatInt(facts.kernelAttribution.length)} 组，已列前 ${Math.min(10, kernelsForFilter.length)} 组）`)
    } else if (facts.hasGpuEvents) {
      lines.push("")
      lines.push(
        facts.flows.available
          ? "未取得内核归属：本 trace 的流事件（ac2g）未指向内核，且内核事件缺 correlation 字段。"
          : "未取得内核归属：内核与 CUDA API 的连接依赖 correlation 字段或流事件（ac2g），本 trace 两者都不可用。",
      )
    }
    // Windows 上 PyTorch 的 CUPTI 采集不可用（无 kernel 事件）：退化为按 CUDA API/算子 → 发起位置（Python 帧样本）
    if (kind === "kernel" && !facts.hasGpuEvents) {
      const apis = facts.cudaApis.filter((a) => a.launchSites.length || a.launchOps.length)
      lines.push("")
      if (apis.length) {
        lines.push("无 kernel 事件（Windows 上 PyTorch 的 CUPTI 采集不可用）——退化为按 CUDA API 的发起位置归属（取样，非逐次对应）：")
        lines.push(
          renderTable(
            ["CUDA API", "次数", "发起算子（样本）", "发起位置（样本）"],
            apis.slice(0, 10).map((a) => [shortName(a.name, 30), formatInt(a.count), shortName(a.launchOps.join("、") || "-", 30), shortName(a.launchSites.join("、") || "-", 40)]),
          ),
        )
      } else {
        lines.push("无 kernel 事件（Windows 上 PyTorch 的 CUPTI 采集不可用），也没有可归属的 CUDA API 事件——GPU 内核级时间线请用 nsight_capture kind=nsys 采集后分析。")
      }
    }
    return { output: lines.join("\n"), data: { path: ref.path, kind, filter: args.filter ?? null, rows, attribution: kernelsForFilter.slice(0, 10), flows: facts.flows, elapsedMs, reused } }
  },
}

const memoryTool: Tool = {
  name: "memory",
  description:
    "PyTorch trace 显存分析（需 profile_memory=True）：峰值已分配/已保留、碎片化比率、分配与释放次数、累计分配量、最大单次分配、按设备分布、分配热点时间分布与最活跃的分配时刻。",
  parameters: schema({
    ...REPORT_PARAM,
    ...BUDGET_PARAM,
    top: { type: "number", description: "最大分配条数（默认 10，上限 50）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const loaded = await loadTorchFacts(ctx, input)
    if (loaded.facts.incomplete) return pendingResult(loaded)
    const { ref, facts, elapsedMs, reused } = loaded
    const top = Math.min(50, Math.max(1, Number((input as { top?: number }).top ?? 10)))
    const m = facts.memory
    const lines: string[] = []
    lines.push(`trace：${ref.path}｜聚合耗时 ${(facts.scanMs / 1000).toFixed(2)}s${reused ? "（命中缓存）" : ""}`)
    if (!m.available) {
      lines.push("")
      lines.push("trace 中没有分配器事件（`[memory]`）——需要重新采集：torch.profiler.profile(..., profile_memory=True)。")
      lines.push("（也可用 Nsight Systems 采集后分析显存传输与分配：nsight_capture kind=nsys + nsight_overview。）")
      return { output: lines.join("\n"), data: { path: ref.path, available: false } }
    }
    lines.push("")
    lines.push(
      `分配器事件 ${formatInt(m.events)}（分配 ${formatInt(m.allocCount)} / 释放 ${formatInt(m.freeCount)}）｜累计分配 ${formatBytes(m.allocatedBytes)}｜累计释放 ${formatBytes(m.freedBytes)}`,
    )
    lines.push(
      `峰值已分配 ${formatBytes(m.peakAllocatedBytes)}（来源：${m.peakSource === "trace" ? "trace 的 Total Allocated" : m.peakSource === "live-set" ? "按地址推算的活跃集" : "不可得"}）｜峰值已保留 ${formatBytes(m.peakReservedBytes)}｜碎片化比率 ${m.fragmentation.toFixed(2)}${m.fragmentation > TORCH_THRESHOLDS.fragmentation ? "（偏高）" : ""}`,
    )
    if (m.addrTrackingTruncated) lines.push("注意：地址数超出追踪上限，活跃集统计已降级（累计值仍精确）。")
    lines.push("")
    lines.push(`最大单次分配 Top ${Math.min(top, m.largestAllocs.length)}：`)
    lines.push(renderTable(["字节", "设备", "地址", "时刻（相对窗口，µs）"], m.largestAllocs.slice(0, top).map((a) => [formatBytes(a.bytes), String(a.deviceId), String(a.addr), String(Math.round(a.tsUs - facts.timeline.firstTsUs))])))
    if (m.byDevice.length) {
      lines.push("")
      lines.push("按设备：")
      lines.push(renderTable(["设备", "分配次数", "累计字节", "峰值活跃"], m.byDevice.map((d) => [String(d.deviceId), formatInt(d.allocCount), formatBytes(d.bytes), formatBytes(d.peakBytes)])))
    }
    lines.push("")
    lines.push(`窗口 ${us(facts.timeline.spanUs)}｜分配/释放密度 ${( (m.allocCount + m.freeCount) / Math.max(1, facts.timeline.spanUs)).toFixed(3)} 次/µs`)
    return { output: lines.join("\n"), data: { path: ref.path, memory: m, elapsedMs, reused } }
  },
}

const torchFindingsTool: Tool = {
  name: "findings",
  description:
    "PyTorch trace 性能问题诊断（核心工具）：把聚合度量转成按严重度与可回收时间排序的问题清单——同步阻塞（.item()/主机往返）、CPU 受限、Python 开销、算子碎片化、autograd 开销、小内核/单内核主导/占用率压力、显存碎片与churn、步时抖动、精度与布局转换；每条含量化证据、根因、修复方向与关联符号，可选把热点定位到源码 文件:行。",
  parameters: schema({
    ...REPORT_PARAM,
    ...BUDGET_PARAM,
    severity_min: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "最低严重度（默认 info 全量）" },
    locate: { type: "boolean", description: "是否把热点符号与用户代码位置定位到工程源码（默认 false）" },
    ...EXPORT_PARAMS,
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as { report: string; severity_min?: string; locate?: boolean; save?: boolean; save_dir?: string }
    const loaded = await loadTorchFacts(ctx, input)
    if (loaded.facts.incomplete) return pendingResult(loaded)
    const { ref, facts, elapsedMs, reused } = loaded
    const { findings, skipped } = diagnoseTorch(facts)
    const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const
    const min = (args.severity_min ?? "info") as keyof typeof order
    const shown = findings.filter((f) => order[f.severity] <= order[min])

    const lines: string[] = []
    lines.push(`trace：${ref.path}`)
    lines.push(`${scaleNote(facts)}｜聚合耗时 ${(facts.scanMs / 1000).toFixed(2)}s${reused ? "（命中缓存）" : ""}｜${flagsNote(facts)}`)
    lines.push("")
    lines.push(`【问题清单】${shown.length} 项（按严重度与可回收时间排序）`)
    lines.push("")
    lines.push(renderFindings(shown, args.locate ? "（已定位，见下方源码位置）" : "（可用 locate=true 或 torch_locate 定位到源码）"))

    // 度量摘要
    const t = facts.timeline
    lines.push("【度量摘要】")
    const mem = facts.memory
    const summary: Array<[string, string]> = [
      ["时间窗口", us(t.spanUs)],
      ["CPU 忙碌", `${us(t.cpuBusyUs)}（${formatPct(t.cpuUtilization)}）`],
      ["GPU 忙碌", facts.hasGpuEvents ? `${us(t.gpuBusyUs)}（${formatPct(t.gpuUtilization)}）` : "无 GPU 事件"],
      ["GPU 空闲缝", facts.hasGpuEvents ? `${formatInt(t.gpuGapCount)} 段 / ${us(t.gpuGapTotalUs)}` : "—"],
      ["步数", facts.stepStats.count ? `${facts.stepStats.count}（中位 ${us(facts.stepStats.medianUs)}）` : "无 ProfilerStep"],
      ["算子调用", `${formatInt(facts.ops.reduce((s, o) => s + o.count, 0))} 次 / ${formatInt(facts.opGroups)} 类`],
      ["内核调用", facts.hasGpuEvents ? `${formatInt(facts.kernels.reduce((s, k) => s + k.count, 0))} 次 / ${formatInt(facts.kernelGroups)} 类` : "—"],
      ["显存峰值分配", mem.available ? formatBytes(mem.peakAllocatedBytes) : "—"],
      ["显存碎片率", mem.available ? mem.fragmentation.toFixed(2) : "—"],
    ]
    for (const [k, v] of summary) lines.push(`  ${k}: ${v}`)
    lines.push("")
    lines.push(fwdBwdLine(facts))

    if (skipped.length) {
      lines.push("")
      lines.push("【未覆盖维度】")
      for (const s of skipped) lines.push(`  · ${s}`)
    }
    if (facts.notes.length) {
      lines.push("")
      for (const n of facts.notes) lines.push(`说明：${n}`)
    }

    // 源码定位
    let locations: unknown[] = []
    if (args.locate) {
      const terms = symbolHints(facts, shown)
      // 算子名归一：aten::linear → linear；autograd::engine::evaluate_function:X → X
      const normalized = terms
        .map((t2) =>
          t2
            .replace(/^aten::/, "")
            .replace(/^autograd::engine::evaluate_function:\s*/, "")
            .replace(/^torch::autograd::/, "")
            .replace(/^ProfilerStep#?\d*$/, ""),
        )
        .filter((t2) => t2.length >= 4 && /^[A-Za-z_]/.test(t2))
      const hints: SymbolHint[] = [...new Set(normalized)].slice(0, 12).map((s) => ({ kind: "op", value: s }))
      // 用户代码位置（trace 自带 `文件(行)`）直接作为搜索词，既能命中定义也能命中调用点
      const sites = userSites(facts, 6)
      const located = await locateSymbols(ctx, hints, { extraTerms: sites.map((s) => s.func).filter((f) => f.length >= 4) })
      locations = located.results
      lines.push("")
      lines.push(...renderLocate(located))
      if (sites.length) {
        lines.push("")
        lines.push("trace 自带用户代码位置（python_function 帧，直接可用）：")
        for (const s of sites) lines.push(`  ${s.file}:${s.line}  ${s.func}（自身 ${us(s.selfUs)}）`)
      }
    }

    // 导出 Markdown：证据与源码位置一并保留（便于归档/贴给同事）
    const wantExport = parseExportArgs(args as Record<string, unknown>)
    let saved: SaveResult | null = null
    if (wantExport) {
      const md = renderMarkdown({
        title: `PyTorch trace 分析：${ref.name}`,
        meta: [
          `trace：${ref.path}`,
          `${scaleNote(facts)}｜聚合耗时 ${(facts.scanMs / 1000).toFixed(2)}s${reused ? "（命中缓存）" : ""}`,
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
              ...(f.reclaimableUs > 0 ? [`- 可回收时间上限：${us(f.reclaimableUs)}`] : []),
              "",
            ]),
          },
          ...(skipped.length ? [{ title: "未覆盖维度", lines: skipped.map((s2) => `- ${s2}`) }] : []),
          { title: "度量摘要", lines: summary.map(([k, v]) => `- ${k}: ${v}`) },
          ...(facts.notes.length ? [{ title: "说明", lines: facts.notes.map((n) => `- ${n}`) }] : []),
        ],
      })
      try {
        saved = saveMarkdown({ dir: wantExport.dir, base: `torch-${ref.stem}`, projectRoot: ctx.workdir, text: md })
        lines.push("", exportNote(saved))
      } catch (e) {
        lines.push("", exportNote(null, e))
      }
    }

    return {
      output: lines.join("\n"),
      data: { path: ref.path, findings: shown, metrics: Object.fromEntries(summary), skipped, locations, elapsedMs, reused, savedPath: saved?.path },
    }
  },
}

// ---------------------------------------------------------------- reports（trace 索引）

/**
 * 文件名是否为 trace 形态（索引用的严格判据）：`*.pt.trace.json` / `*.trace.json`（可带 .gz）。
 *
 * 与 isTorchTrace 的区别：后者是「给定文件能否当 trace 分析」的宽松判据（含任意 .json），
 * 用于用户显式点名的 report 参数；索引场景沿用宽松判据会把目录里所有 JSON 都列成 trace。
 */
function isTraceShapedPath(path: string): boolean {
  return /\.(pt\.)?trace\.json(\.gz)?$/i.test(path)
}

const reportsTool: Tool = {
  name: "reports",
  description:
    "PyTorch trace 索引：list 扫描当前工作目录/工程内**文件名符合 trace 形态**的文件（*.pt.trace.json / *.trace.json，可带 .gz——裸 .json 不列入），按修改时间倒序列出路径/大小/修改时间与是否已有事实缓存；info 显示单个 trace 的规模、采集开关与缓存状态。不确定手上有哪些 trace、或想知道哪个已分析过时先用它。",
  parameters: schema(
    {
      ...REPORT_PARAM,
      action: { type: "string", enum: ["list", "info"], description: "动作（默认：给了 report 即 info，否则 list）" },
      filter: { type: "string", description: "list 的路径子串筛选（不区分大小写）" },
      top: { type: "number", description: "list 最多列出条数（默认 30）" },
    },
    [],
  ),
  outputSchema: schema({
    traces: { type: "array", description: "trace 清单：path/size/mtimeMs/cached" },
    trace: { type: "object", description: "info 结果：规模、采集开关与缓存状态" },
  }),
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as { report?: string; action?: string; filter?: string; top?: number }
    const action = String(args.action ?? (args.report ? "info" : "list"))
    const cacheDir = torchCacheDir(ctx)
    if (action === "list") {
      // 目录遍历走宿主注入的 ctx.listFiles（沙箱与范围约束由引擎统一执行）
      const files = await ctx.listFiles().catch(() => [])
      const re = args.filter ? new RegExp(args.filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : undefined
      const top = Math.min(200, Math.max(1, Number(args.top ?? 30)))
      // 收紧到「trace 形态文件名」：裸 .json 不算 trace（否则 tasks.json/import.json 一类配置文件会被当成可分析对象）。
      // 显式分析（overview/findings 的 report 参数）仍接受任意 .json（isTorchTrace）——那是用户点名的文件。
      const found = files
        .filter((f) => !f.isDir && isTraceShapedPath(f.path) && (!re || re.test(f.path)))
        .map((f) => ({
          path: f.path,
          size: f.size,
          mtimeMs: f.modifiedAt,
          cached: existsSync(factsCachePath(ctx, { name: basename(f.path), size: f.size, mtimeMs: f.modifiedAt })),
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs) // mtime 缺失（全 0）时等价于保持遍历顺序
        .slice(0, top)
      if (!found.length) {
        return {
          output: `当前工作目录/工程下未发现 PyTorch trace（*.pt.trace.json / *.pt.trace.json.gz / *.trace.json）。可用 project 参数指定工程根后再列；采集方式见 torch_capture。`,
          data: { traces: [], cacheDir },
        }
      }
      return {
        output: [
          `发现 ${found.length} 个 trace（按修改时间倒序；缓存目录 ${cacheDir}）：`,
          "",
          renderTable(
            ["路径", "大小", "修改时间", "事实缓存"],
            found.map((t) => [
              t.path,
              formatBytes(t.size),
              // 宿主未提供 mtime 时如实标「未知」——显示 1970 会让人以为文件很旧，且「按修改时间倒序」会变成谎话
              t.mtimeMs > 0 ? new Date(t.mtimeMs).toISOString().slice(0, 19).replace("T", " ") : "未知",
              t.cached ? "已落盘" : "未分析",
            ]),
          ),
          "",
          "下一步：torch_overview（report=<路径>）看全貌 → torch_findings 拿问题清单。",
        ].join("\n"),
        data: { traces: found, cacheDir },
      }
    }

    if (!args.report) return { output: "需要 report 参数（trace 路径），或改用 action=list 列出现有 trace。", data: {} }
    const ref = statTrace(ctx, args.report)
    const cacheFile = factsCachePath(ctx, ref)
    const flags = await readTraceFlags(ref.path)
    const onDisk = existsSync(cacheFile)
    const lines: string[] = []
    lines.push(`trace：${ref.path}`)
    lines.push(`大小：${formatBytes(ref.size)}（${formatInt(ref.size)} 字节）｜修改时间：${new Date(ref.mtimeMs).toISOString()}`)
    lines.push(`采集开关：${["profile_memory", "with_stack", "record_shapes", "with_modules"].filter((k) => flags[k] === 1 || flags[k] === true).join("、") || "未记录"}`)
    lines.push(`事实缓存：${onDisk ? `已落盘（${cacheFile}）——下一次分析直接命中` : `未落盘（首次分析需流式扫描；扫描耗时超过 ${(PERSIST_MIN_SCAN_MS / 1000).toFixed(0)}s 的 trace 会自动落盘）`}`)
    lines.push("")
    lines.push(`下一步：torch_overview report="${ref.path}"（总览）→ torch_findings（问题清单）。`)
    return {
      output: lines.join("\n"),
      data: { trace: { path: ref.path, size: ref.size, mtimeMs: ref.mtimeMs, flags, cacheFile, cached: onDisk }, cacheDir },
    }
  },
}

// ---------------------------------------------------------------- capture（采集）

/** 采集脚本生成参数。 */
export interface CaptureOptions {
  script: string
  output: string
  active: number
  wait: number
  warmup: number
  activities: string[]
  recordShapes: boolean
  profileMemory: boolean
  withStack: boolean
}

/**
 * 生成采集脚本：A 段可直接粘进训练循环（带 schedule + prof.step()，才有步级视图），
 * B 段直接运行本文件（用 runpy 执行目标脚本，整段采集——目标脚本不调 prof.step()，schedule 不会推进）。
 */
export function captureScript(o: CaptureOptions): string {
  const act = o.activities.map((a) => `torch.profiler.ProfilerActivity.${a.toUpperCase()}`).join(", ")
  return `"""PyTorch Profiler 采集脚本（由歌白 torch_capture 生成）。

两种用法：
  A. 把下面的片段粘进你的训练循环（推荐：有 prof.step() 才有步级视图与 schedule 生效）；
  B. 直接运行本文件（python <本文件>）：用 runpy 执行目标脚本整段采集（无步级标注）。

平台事实：Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 CUDA activity 仍无 kernel 事件），
本机 trace 通常只含 CPU/算子/显存维度；GPU 内核级时间线请用 Nsight Systems（歌白 nsight_capture kind=nsys）。
"""
import os
import runpy
import sys

import torch

TARGET = r"${o.script}"     # 被采集的脚本
OUT = r"${o.output}"        # trace 输出（*.pt.trace.json）
ACTIVITIES = [${act}]
WAIT, WARMUP, ACTIVE = ${o.wait}, ${o.warmup}, ${o.active}

# ---- A. 粘进训练循环（推荐）----
# with torch.profiler.profile(
#     activities=ACTIVITIES,
#     schedule=torch.profiler.schedule(wait=WAIT, warmup=WARMUP, active=ACTIVE),
#     on_trace_ready=lambda p: p.export_chrome_trace(OUT),
#     record_shapes=${o.recordShapes ? "True" : "False"}, profile_memory=${o.profileMemory ? "True" : "False"}, with_stack=${o.withStack ? "True" : "False"},
# ) as prof:
#     for step, batch in enumerate(loader):
#         train_step(batch)        # 你的单步训练
#         prof.step()              # 必须调用，schedule 才会推进
#         if step >= WAIT + WARMUP + ACTIVE:
#             break

# ---- B. 直接运行本文件 ----
def main() -> int:
    if not os.path.exists(TARGET):
        print("目标脚本不存在：" + TARGET, file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    with torch.profiler.profile(
        activities=ACTIVITIES,
        on_trace_ready=lambda p: p.export_chrome_trace(OUT),
        record_shapes=${o.recordShapes ? "True" : "False"}, profile_memory=${o.profileMemory ? "True" : "False"}, with_stack=${o.withStack ? "True" : "False"},
    ):
        runpy.run_path(TARGET, run_name="__main__")
    print("trace: " + OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`
}

const captureTool: Tool = {
  name: "capture",
  description:
    "生成可直接运行的 PyTorch Profiler 采集脚本（torch.profiler.profile + schedule(wait/warmup/active) + export_chrome_trace，含 record_shapes/profile_memory/with_stack），并可选择执行它（mode=run，需审批）。注意：Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 CUDA activity 仍无 kernel 事件），需要 GPU 内核级时间线时用 nsight_capture kind=nsys；目标脚本不调 prof.step() 时 schedule 不会推进，退化为整段采集。",
  parameters: schema(
    {
      script: { type: "string", description: "被采集的目标 Python 脚本路径（相对路径以当前工作目录或 project 根为基准）" },
      output: { type: "string", description: "trace 输出路径（默认 <脚本名>-capture.pt.trace.json，与脚本同目录）" },
      save: { type: "string", description: "生成的采集脚本存放路径（默认与 trace 同目录，<脚本名>-capture.py）" },
      steps: { type: "number", description: "采集的活动步数 active（默认 3）" },
      wait: { type: "number", description: "schedule 的 wait（默认 1）" },
      warmup: { type: "number", description: "schedule 的 warmup（默认 1）" },
      activities: { type: "string", description: "采集活动（默认 cpu；Linux 上可加 cuda 以得到 kernel/传输事件；Windows 上 CUDA activity 无 kernel 事件）" },
      record_shapes: { type: "boolean", description: "是否记录张量形状（默认 true）" },
      profile_memory: { type: "boolean", description: "是否记录显存分配事件（默认 true）" },
      with_stack: { type: "boolean", description: "是否记录 Python 调用栈（默认 true；Python 位置定位靠它）" },
      mode: { type: "string", enum: ["script", "run"], description: "script=只生成采集脚本（默认）；run=生成并执行（需审批）" },
      python: { type: "string", description: "Python 解释器命令（默认 python）" },
      timeout: { type: "number", description: "执行超时秒数（默认 600）" },
    },
    ["script"],
  ),
  outputSchema: schema({
    script: { type: "string", description: "生成的采集脚本路径" },
    command: { type: "string", description: "可直接执行的命令" },
    report: { type: "string", description: "执行后产出的 trace 路径（mode=script 时为空）" },
    exitCode: { type: "number" },
  }),
  // 只生成脚本文件免审批；执行目标程序需审批（与 nsight_capture 同纪律）
  requiresApproval: (args) => String(args.mode ?? "script") === "run",
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as {
      script: string
      output?: string
      save?: string
      steps?: number
      wait?: number
      warmup?: number
      activities?: string
      record_shapes?: boolean
      profile_memory?: boolean
      with_stack?: boolean
      mode?: string
      python?: string
      timeout?: number
    }
    const target = String(args.script ?? "").trim()
    if (!target) return { output: "需要 script 参数（被采集的目标 Python 脚本路径）。", data: {} }
    const scriptAbs = /^[A-Za-z]:|^[\\/]/.test(target) ? target : ctx.resolvePath(target)
    const dir = dirname(scriptAbs)
    const stem = basename(scriptAbs).replace(/\.py$/i, "")
    const outRel = String(args.output ?? `${stem}-capture.pt.trace.json`)
    const outPath = /^[A-Za-z]:|^[\\/]/.test(outRel) ? outRel : join(dir, outRel)
    const saveRel = String(args.save ?? `${stem}-capture.py`)
    const savePath = /^[A-Za-z]:|^[\\/]/.test(saveRel) ? saveRel : join(dir, saveRel)
    const activities = String(args.activities ?? "cpu")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const bad = activities.filter((a) => a !== "cpu" && a !== "cuda")
    if (bad.length) return { output: `activities 只支持 cpu/cuda（收到：${bad.join("、")}）`, data: {} }

    const script = captureScript({
      script: scriptAbs,
      output: outPath,
      active: Math.max(1, Math.min(1_000, Number(args.steps ?? 3))),
      wait: Math.max(0, Number(args.wait ?? 1)),
      warmup: Math.max(0, Number(args.warmup ?? 1)),
      activities: activities.length ? activities : ["cpu"],
      recordShapes: args.record_shapes !== false,
      profileMemory: args.profile_memory !== false,
      withStack: args.with_stack !== false,
    })
    await ctx.writeFile(savePath, script)
    const python = String(args.python ?? "python")
    const command = `${python} "${savePath}"`

    const lines: string[] = []
    lines.push(`采集脚本已生成：${savePath}`)
    lines.push(`运行命令：${command}`)
    lines.push(`trace 输出：${outPath}`)
    lines.push("")
    lines.push(
      `采集配置：activities=[${activities.join(",")}]｜schedule(wait=${Math.max(0, Number(args.wait ?? 1))}, warmup=${Math.max(0, Number(args.warmup ?? 1))}, active=${Math.max(1, Number(args.steps ?? 3))})｜record_shapes=${args.record_shapes !== false}｜profile_memory=${args.profile_memory !== false}｜with_stack=${args.with_stack !== false}`,
    )
    lines.push("脚本内含两段：A 段粘进训练循环（推荐，带 prof.step() 才有步级视图）；B 段直接运行本文件（用 runpy 执行目标脚本，整段采集）。")
    if (activities.includes("cuda")) {
      lines.push("注意：Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 CUDA activity 仍无 kernel 事件）——需要 GPU 内核级时间线时用 nsight_capture kind=nsys。")
    }

    if (String(args.mode ?? "script") !== "run") {
      lines.push("")
      lines.push(`采集（需审批）：torch_capture mode=run script="${target}"（或直接跑上面的命令）。`)
      return { output: lines.join("\n"), data: { script: savePath, command, report: undefined } }
    }

    const timeoutMs = Math.max(10_000, Number(args.timeout ?? 600) * 1000)
    const t = withTiming()
    const r = await ctx.runCommand(command, { timeoutMs, workdir: dir })
    const ms = t()
    const produced = existsSync(outPath)
    lines.push("")
    lines.push(`执行耗时 ${(ms / 1000).toFixed(1)}s，退出码 ${r.code}`)
    if (!produced) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-12)
      lines.push("未生成 trace——按错误信息定位：")
      lines.push(...tail)
      return { output: lines.join("\n"), data: { script: savePath, command, report: undefined, exitCode: r.code } }
    }
    lines.push(`trace：${outPath}（${formatBytes(Bun.file(outPath).size)}）`)
    lines.push("")
    lines.push(`下一步：torch_overview report="${outPath}" → torch_findings（问题清单）→ torch_ops kind=kernel（内核下钻）。`)
    return { output: lines.join("\n"), data: { script: savePath, command, report: outPath, exitCode: r.code, analysisMs: ms } }
  },
}

// ---------------------------------------------------------------- compare（改前改后）

/**
 * 度量方向：只有**确实有好坏之分**的度量才声明方向——决定差异显示为「改善/退化」还是「变化（不判好坏）」。
 *
 * 刻意不声明方向的：「CPU/GPU 忙碌时长」（描述性指标，忙不一定是好）、「步数」「算子调用」（规模量）。
 * 对它们好坏的判断依赖上下文（改了什么、期望什么），工具不该替用户下结论。
 */
const LOWER_IS_BETTER_T = new Set(["时间窗口", "GPU 空闲缝", "显存峰值分配", "显存碎片率"])

/** 把 findings 的度量摘要（展示文本数组）转成可对比项：解析数值与单位，按名声明方向。 */
function torchMetricsOf(pairs: Array<[string, string]>): CompareMetric[] {
  return pairs.map(([name, text]) => {
    // 展示文本形如 "12.34 ms" / "45.6%" / "19.05 ms（78.7%）"——取**前导数值 + 单位**参与比较，
    // 尾部注解（括号内的占比等）不参与；整体无前导数值的（如「无 GPU 事件」）标为不可比。
    const m = /^\s*(-?[0-9.]+)\s*([A-Za-z%μ]*)/.exec(text)
    const higher = LOWER_IS_BETTER_T.has(name) ? false : undefined
    if (!m) return { name, higherIsBetter: higher, text }
    const value = Number.parseFloat(m[1]!)
    return { name, value: Number.isFinite(value) ? value : undefined, unit: m[2] || "", higherIsBetter: higher, text }
  })
}

/** 取一份 trace 的对比快照（复用与 findings 相同的取数与诊断路径，保证口径一致）。 */
async function torchSnapshotOf(ctx: ToolContext, reportPath: string): Promise<SideSnapshot> {
  const loaded = await loadTorchFacts(ctx, { report: reportPath })
  if (loaded.facts.incomplete) {
    throw new Error(`${loaded.ref.name} 的扫描未完成（触及时间预算）——请先单独分析该 trace 使其落盘缓存，或调大 budget 后重试。`)
  }
  const { ref, facts } = loaded
  const { findings } = diagnoseTorch(facts)
  const t = facts.timeline
  const mem = facts.memory
  const metrics: Array<[string, string]> = [
    ["时间窗口", us(t.spanUs)],
    ["CPU 忙碌", `${us(t.cpuBusyUs)}（${formatPct(t.cpuUtilization)}）`],
    ["GPU 忙碌", facts.hasGpuEvents ? `${us(t.gpuBusyUs)}（${formatPct(t.gpuUtilization)}）` : "无 GPU 事件"],
    ["GPU 空闲缝", facts.hasGpuEvents ? `${formatInt(t.gpuGapCount)} 段 / ${us(t.gpuGapTotalUs)}` : "—"],
    ["步数", facts.stepStats.count ? `${facts.stepStats.count}（中位 ${us(facts.stepStats.medianUs)}）` : "无 ProfilerStep"],
    ["算子调用", `${formatInt(facts.ops.reduce((a, o) => a + o.count, 0))} 次 / ${formatInt(facts.opGroups)} 类`],
    ["显存峰值分配", mem.available ? formatBytes(mem.peakAllocatedBytes) : "—"],
    ["显存碎片率", mem.available ? mem.fragmentation.toFixed(2) : "—"],
  ]
  return {
    label: ref.name,
    metrics: torchMetricsOf(metrics),
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title, reclaimableNs: Math.round(f.reclaimableUs * 1000) })),
  }
}

const compareTool: Tool = {
  name: "compare",
  description:
    "trace 间对比（改前改后 / 两次采集）：把两份 PyTorch trace 的关键度量与问题清单做差异比对——步时与 CPU/GPU 忙碌是否改善、显存与碎片是否下降、哪些问题消失、哪些新出现。度量按同名对齐（仅一侧有的如实标注，不做推算；单位不同不比数值），问题按 id 对齐，净变化含消失的问题（修好的问题省了多少看得见）。",
  parameters: schema(
    {
      before: { type: "string", description: "基准 trace 路径（改前）" },
      after: { type: "string", description: "对比 trace 路径（改后）" },
    },
    ["before", "after"],
  ),
  outputSchema: schema({
    metrics: { type: "array", description: "度量差异（name/kind/beforeText/afterText/changePct）" },
    findings: { type: "array", description: "问题差异（id/title/kind 新增或消失或变化）" },
    reclaimableDeltaNs: { type: "number", description: "问题总代价净变化（负 = 下降）" },
  }),
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as { before: string; after: string }
    const t0 = withTiming()
    const before = await torchSnapshotOf(ctx, args.before)
    const after = await torchSnapshotOf(ctx, args.after)
    const result = compareSnapshots(before, after)
    const lines = renderCompare(before, after, result, (ns) => us(ns / 1000))
    lines.push("")
    lines.push(`（两份 trace 的分析总耗时 ${(t0() / 1000).toFixed(2)}s）`)
    return { output: lines.join("\n"), data: result as unknown as Record<string, unknown> }
  },
}

/** PyTorch trace 工具集（名称 → 工具）。 */
export const torchTools: Record<string, Tool> = {
  reports: reportsTool,
  overview: overviewTool,
  ops: opsTool,
  memory: memoryTool,
  findings: torchFindingsTool,
  compare: compareTool,
  capture: captureTool,
}

/** 供测试与提示词引用：确保阈值常量被导出（文档与实现不漂移）。 */
export { TORCH_THRESHOLDS, isUserCode }
