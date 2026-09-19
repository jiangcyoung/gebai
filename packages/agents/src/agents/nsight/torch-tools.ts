/**
 * PyTorch Profiler（Chrome Trace / Kineto）工具集：概览、算子排行、显存分析、问题诊断。
 *
 * 与 nsys 工具集同一纪律：全部只读、结果有界、耗时与数据来源如实回报；
 * 判定按 trace 实际具备的维度裁剪，缺维度时**明确说明缺什么、怎么补**（不当作没问题）。
 */
import { existsSync } from "node:fs"
import type { Tool, ToolContext, ToolResult } from "@gebai/sdk"
import { aggregateTorchTrace, type TorchFacts, type TorchOpStat } from "./torch-trace"
import { diagnoseTorch, isUserCode, TORCH_THRESHOLDS, userSites, type TorchFinding } from "./torch-findings"
import { statReport, type ReportRef } from "./report"
import { locateSymbols, renderLocate } from "./locate"
import type { SymbolHint } from "./findings"
import { formatBytes, formatInt, formatPct, renderTable } from "./util"
import { withTiming } from "./timing"
import { schema, sparkline } from "./tools"

const REPORT_PARAM = {
  report: { type: "string", description: "PyTorch Profiler trace 路径（*.pt.trace.json / *.pt.trace.json.gz / *.trace.json / *.json，可带 .gz）；相对路径以当前工作目录或 project 根为基准" },
}
const LOCATE_PARAM = { locate: { type: "boolean", description: "是否把热点定位到工程源码（用 trace 里 python_function 的 `文件(行)`）" } }
void LOCATE_PARAM

// ---------------------------------------------------------------- 事实缓存

/**
 * 聚合事实按「路径 + 大小 + mtime」缓存（同报告二次分析秒回）。
 * trace 分析是单趟流式扫描，缓存后概览/算子/内存/诊断共享同一份结果。
 */
interface Cached {
  key: string
  facts: TorchFacts
}
const cache = new Map<string, Cached>()

function cacheKeyOf(ref: ReportRef): string {
  return `${ref.path}|${ref.size}|${ref.mtimeMs}`
}

/** 清空事实缓存（测试用）。 */
export function resetTorchFactsCache(): void {
  cache.clear()
}

export async function loadTorchFacts(ctx: ToolContext, input: unknown): Promise<{ ref: ReportRef; facts: TorchFacts; elapsedMs: number; reused: boolean }> {
  const args = (input ?? {}) as { report?: string; onProgress?: never }
  if (!args.report) throw new Error("需要 report 参数（PyTorch Profiler trace 路径）")
  const ref = await statReport(ctx, args.report)
  if (ref.kind !== "torch") {
    throw new Error(
      `这不是 PyTorch Profiler trace（识别为 ${ref.kind}）：${ref.path}\n` +
        `PyTorch trace 用 torch.profiler.profile(...).export_chrome_trace("*.pt.trace.json") 导出（可 gzip）。`,
    )
  }
  if (!existsSync(ref.path)) throw new Error(`trace 文件不存在：${ref.path}`)
  const key = cacheKeyOf(ref)
  const hit = cache.get(key)
  if (hit) return { ref, facts: hit.facts, elapsedMs: 0, reused: true }
  const t0 = withTiming()
  const facts = await aggregateTorchTrace(ref.path)
  const elapsedMs = t0()
  cache.set(key, { key, facts })
  return { ref, facts, elapsedMs, reused: false }
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

/** 问题清单渲染（与 nsys findings 同构：严重度、证据、根因、建议、可回收上限、符号）。 */
function renderFindings(findings: TorchFinding[], symbolsHint: string): string {
  if (!findings.length) return "未命中任何诊断规则（trace 规模过小或未采集到可判定维度）。"
  const lines: string[] = []
  for (const f of findings) {
    const label = { critical: "严重", high: "高", medium: "中", low: "低", info: "提示" }[f.severity]
    lines.push(`● [${label}] ${f.title}`)
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
  name: "torch_overview",
  description:
    "PyTorch Profiler trace 总览：事件规模与采集开关、时间线与 CPU/GPU 忙碌占比、步级耗时（ProfilerStep）与抖动、算子/内核/CUDA API 数量、显存峰值与碎片率、用户代码热点位置。分析 PyTorch trace 的第一步。",
  parameters: schema({
    ...REPORT_PARAM,
    top: { type: "number", description: "各排行展示条数（默认 10，上限 50）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const { ref, facts, elapsedMs, reused } = await loadTorchFacts(ctx, input)
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
  name: "torch_ops",
  description:
    "PyTorch trace 算子/内核下钻：按名称子串筛选（如 aten::linear、elementwise、cutlass），给出调用次数、总/自身耗时、分位数、张量形状与 dtype、内核几何（网格/块/寄存器/占用率/流），以及内核到发起算子的归属（correlation 关联）。",
  parameters: schema({
    ...REPORT_PARAM,
    filter: { type: "string", description: "名称子串筛选（不区分大小写；省略则展示全部排行）" },
    kind: { type: "string", enum: ["op", "kernel", "cuda_api", "annotation", "python"], description: "查看对象类别（默认 op）" },
    top: { type: "number", description: "条数（默认 20，上限 200）" },
    sort: { type: "string", enum: ["self", "total", "count"], description: "排序键（默认：算子按 self、内核按 total）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as { report: string; filter?: string; kind?: string; top?: number; sort?: string }
    const { ref, facts, elapsedMs, reused } = await loadTorchFacts(ctx, input)
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
      lines.push("无匹配项——可用 torch_overview 查看全部排行，或放宽筛选。")
      return { output: lines.join("\n"), data: { path: ref.path, kind, rows: [] } }
    }
    lines.push("")
    lines.push(renderOps(rows, ["名称", "次数", "总耗时", "自身耗时", "p50", "形状/类型"]))
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
    // 内核归属（GPU 存在时）
    const kernelsForFilter = args.filter ? facts.kernelAttribution.filter((a) => re!.test(a.kernel) || re!.test(a.op)) : facts.kernelAttribution
    if (kind !== "kernel" && kernelsForFilter.length) {
      lines.push("")
      lines.push("内核 → 发起算子（correlation 关联）：")
      lines.push(
        renderTable(
          ["内核", "发起算子", "次数", "内核耗时"],
          kernelsForFilter.slice(0, 10).map((a) => [shortName(a.kernel, 40), shortName(a.op, 34), formatInt(a.count), us(a.kernelUs)]),
        ),
      )
    }
    return { output: lines.join("\n"), data: { path: ref.path, kind, filter: args.filter ?? null, rows, elapsedMs, reused } }
  },
}

const memoryTool: Tool = {
  name: "torch_memory",
  description:
    "PyTorch trace 显存分析（需 profile_memory=True）：峰值已分配/已保留、碎片化比率、分配与释放次数、累计分配量、最大单次分配、按设备分布、分配热点时间分布与最活跃的分配时刻。",
  parameters: schema({
    ...REPORT_PARAM,
    top: { type: "number", description: "最大分配条数（默认 10，上限 50）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const { ref, facts, elapsedMs, reused } = await loadTorchFacts(ctx, input)
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
  name: "torch_findings",
  description:
    "PyTorch trace 性能问题诊断（核心工具）：把聚合度量转成按严重度与可回收时间排序的问题清单——同步阻塞（.item()/主机往返）、CPU 受限、Python 开销、算子碎片化、autograd 开销、小内核/单内核主导/占用率压力、显存碎片与churn、步时抖动、精度与布局转换；每条含量化证据、根因、修复方向与关联符号，可选把热点定位到源码 文件:行。",
  parameters: schema({
    ...REPORT_PARAM,
    severity_min: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "最低严重度（默认 info 全量）" },
    locate: { type: "boolean", description: "是否把热点符号与用户代码位置定位到工程源码（默认 false）" },
  }, ["report"]),
  async execute(input, ctx): Promise<ToolResult> {
    const args = input as { report: string; severity_min?: string; locate?: boolean }
    const { ref, facts, elapsedMs, reused } = await loadTorchFacts(ctx, input)
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
      const hints: SymbolHint[] = [...new Set(normalized)].slice(0, 12).map((s) => ({ kind: "kernel", value: s }))
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

    return {
      output: lines.join("\n"),
      data: { path: ref.path, findings: shown, metrics: Object.fromEntries(summary), skipped, locations, elapsedMs, reused },
    }
  },
}

/** PyTorch trace 工具集（名称 → 工具）。 */
export const torchTools: Record<string, Tool> = {
  torch_overview: overviewTool,
  torch_ops: opsTool,
  torch_memory: memoryTool,
  torch_findings: torchFindingsTool,
}

/** 供测试与提示词引用：确保阈值常量被导出（文档与实现不漂移）。 */
export { TORCH_THRESHOLDS, isUserCode }
