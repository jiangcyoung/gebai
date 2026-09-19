/**
 * Nsight Compute 深查工具：单内核的 SOL/占用率/停顿分解/访存效率 + NVIDIA 官方规则 + 指令级热点。
 *
 * - 输入 .ncu-rep 报告；若给的是 .nsys-rep，则降级为该内核在时间线上的调用模式分析，
 *   并给出获取 ncu 报告的确切采集命令（不把「时间线证据」冒充「硬件计数器证据」）；
 * - 报告解析全程流式（raw/source 页可达数百 MB），结果条数有界；
 * - 内核符号与（若报告含源码关联的）源文件一并交给定位层，落到工程 文件:行。
 */
import type { Tool, ToolContext, ToolResult } from "@gebai/sdk"
import { statReport, importNcu } from "./report"
import { missingToolchainNote, resolveNsightEnv } from "./env"
import { readNcuKernels, readNcuSource, diagnoseNcu, renderKernelSections, accessEfficiencyText, type NcuKernel } from "./ncu-analysis"
import { openNsysReport } from "./db"
import { kernelRowText, resolveTimelineFacts } from "./nsys-analysis"
import { locateSymbols, renderLocate } from "../../core/perf/locate"
import { formatInt, formatNs, renderTable } from "../../core/perf/format"
import { schema } from "./tools"
import { withTiming } from "../../core/perf/timing"
import type { SymbolHint } from "../../core/perf/locate"

const severityLabel: Record<string, string> = { critical: "严重", high: "高", medium: "中", low: "低", info: "信息" }

export const kernelDetailTool: Tool = {
  name: "kernel_detail",
  description:
    "单内核深度分析（需 Nsight Compute 报告 .ncu-rep）：SOL 瓶颈单元、占用率上限与限制因素、停顿原因分解、访存效率（非合并访问/共享内存 bank 冲突）、NVIDIA 官方优化规则（含预估收益）与停顿最高的 SASS 指令；给出精确采集该报告的命令。传 .nsys-rep 时降级为该内核的时间线调用模式分析（并说明差异）。",
  parameters: schema(
    {
      report: { type: "string", description: "报告路径（.ncu-rep 优先；.nsys-rep 则降级分析）" },
      kernel: { type: "string", description: "目标内核名（子串匹配；省略则分析报告中耗时最长的内核）" },
      kernel_id: { type: "string", description: "ncu 报告中的内核 ID（多内核报告时按 ID 精确选择）" },
      locate: { type: "boolean", description: "是否把内核符号定位到项目源码（默认 true）" },
      locate_project: { type: "string", description: "源码工程根（预置项目名/路径）——locate 的搜索范围" },
      top: { type: "number", description: "指令热点条数（默认 12）" },
    },
    ["report"],
  ),
  outputSchema: schema({
    kernel: { type: "object", description: "内核元信息与分区指标" },
    bottleneck: { type: "string", description: "瓶颈分类" },
    findings: { type: "array", description: "问题清单（官方规则 + 量化分类）" },
    hotspots: { type: "array", description: "停顿/访存热点指令" },
    locations: { type: "array", description: "源码定位结果" },
  }),
  requiresApproval: false,
  async execute(args, ctx): Promise<ToolResult> {
    const env = await resolveNsightEnv(ctx)
    const reportInput = String(args.report)
    const ref = await statReport(ctx, reportInput)
    const top = Math.max(1, Math.min(50, Number(args.top ?? 12)))

    if (ref.kind === "nsys") {
      return analyzeFromNsys(ctx, reportInput, args)
    }

    const missing = missingToolchainNote(env, "ncu")
    if (missing) return { output: `分析 .ncu-rep 需要 ncu 命令行：\n${missing}`, data: {} }

    const t = withTiming()
    const imp = await importNcu(ctx, env, ref, ["details", "raw", "source"])
    if (imp.pending || !imp.artifacts.length) {
      return { output: `ncu 报告指标页未就绪：\n${imp.note}${imp.command ? `\n可后台执行：\n${imp.command}` : ""}`, data: {} }
    }
    const { kernels, truncated } = await readNcuKernels(env, ref)
    const importedMs = t()
    if (!kernels.length) {
      return { output: `报告 ${ref.path} 内未解析到内核指标行（可能报告为空或版本不兼容）。`, data: {} }
    }
    const wanted = args.kernel ? String(args.kernel) : ""
    const wantedId = args.kernel_id ? String(args.kernel_id) : ""
    let target: NcuKernel | undefined
    if (wantedId) target = kernels.find((k) => k.id === wantedId)
    if (!target && wanted) target = kernels.find((k) => k.kernelName.includes(wanted))
    const allKernels = target ? [target] : kernels
    const lines: string[] = []
    const t2 = withTiming()
    const source = await readNcuSource(env, ref, Math.max(top, 12))
    const sourceMs = t2()

    lines.push(`报告：${ref.path}（Nsight Compute）`)
    lines.push(
      `报告内核数 ${kernels.length}${truncated ? "（含更多内核，已按上限截断）" : ""}｜指标页解析 ${(importedMs / 1000).toFixed(2)}s（${imp.reused ? "缓存复用" : "本次导出"}）｜源页流式解析 ${(sourceMs / 1000).toFixed(2)}s（指令行 ${formatInt(source.instructionRows)}）`,
    )
    if (source.hasSourceCorrelation) lines.push(`报告含源码关联：${source.sourceFiles.slice(0, 5).join("、")}`)

    const findingsOut: unknown[] = []
    let bottleneck = ""
    for (const k of allKernels.slice(0, 3)) {
      lines.push("")
      lines.push(`══ 内核：${k.kernelName}`)
      lines.push(`  ID ${k.id}｜进程 ${k.processName}｜设备 ${k.device}（CC ${k.computeCap}）｜网格 ${k.gridSize}｜块 ${k.blockSize}`)
      const diag = diagnoseNcu(k, source)
      bottleneck = diag.bottleneck
      lines.push(`  瓶颈分类：${diag.bottleneck}`)
      lines.push("")
      lines.push("  【关键指标】")
      for (const l of renderKernelSections(k)) lines.push(`  ${l}`)
      lines.push("")
      lines.push("  【访存效率】")
      lines.push(`  ${accessEfficiencyText(source)}`)
      if (diag.findings.length) {
        lines.push("")
        lines.push(`  【问题清单】${diag.findings.length} 项`)
        for (const f of diag.findings) {
          lines.push(`  ● [${severityLabel[f.severity]}] ${f.title}`)
          for (const e of f.evidence) lines.push(`      证据：${e}`)
          lines.push(`      根因：${f.cause}`)
          lines.push(`      建议：${f.suggestion}`)
        }
        findingsOut.push(...diag.findings)
      }
    }

    if (source.hotspots.length) {
      lines.push("")
      lines.push("【停顿/访存热点指令】Top（按 warp 停顿采样；SASS 级定位——源码行需采集时带 --import-source）")
      lines.push(
        renderTable(
          ["地址", "SASS 指令", "停顿采样", "主要停顿原因", "越界扇区", "bank 冲突"],
          source.hotspots.slice(0, top).map((h) => [
            h.address,
            h.instruction.slice(0, 40),
            formatInt(h.samples),
            Object.entries(h.stalls)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 2)
              .map(([n, v]) => `${n}:${v}`)
              .join(" "),
            h.excessSectors ? formatInt(h.excessSectors) : "-",
            h.bankConflicts ? formatInt(h.bankConflicts) : "-",
          ]),
        ),
      )
    }
    if (source.sourceFiles.length && !source.hasSourceCorrelation) {
      lines.push("（报告未含源码关联：重新采集时加 --import-source on --source-folders <工程目录> 可获得源码行级热点）")
    }

    let locations: unknown[] | undefined
    if (args.locate !== false) {
      const symbols: SymbolHint[] = allKernels.slice(0, 3).map((k) => ({ kind: "kernel" as const, value: k.kernelName }))
      if (source.sourceFiles.length) for (const f of source.sourceFiles.slice(0, 3)) symbols.push({ kind: "file", value: f })
      const locT = withTiming()
      const summary = await locateSymbols(ctx, symbols, { extraTerms: [] })
      locations = summary.results as unknown[]
      lines.push("")
      lines.push(`【源码定位】（扫描 ${formatInt(summary.scannedFiles)} 个源文件，耗时 ${(locT() / 1000).toFixed(2)}s）`)
      lines.push(...renderLocate(summary))
    }

    lines.push("")
    lines.push("【复现该报告】")
    lines.push(`  ${buildNcuCommandHint(env.ncu?.path ?? "ncu", ref.path)}`)

    return {
      output: lines.join("\n"),
      data: { kernel: allKernels[0], bottleneck, findings: findingsOut, hotspots: source.hotspots, locations },
    }
  },
}

function buildNcuCommandHint(ncu: string, reportPath: string): string {
  return `${ncu} --import ${reportPath} --page details --csv   # 重新查看指标；采集命令见 nsight_capture（kind=ncu）`
}

/** .nsys-rep 降级路径：给出该内核的时间线调用模式，并说明与 ncu 证据的差异。 */
async function analyzeFromNsys(ctx: ToolContext, reportInput: string, args: Record<string, unknown>): Promise<ToolResult> {
  const env = await resolveNsightEnv(ctx)
  const missing = missingToolchainNote(env, "nsys")
  if (missing) return { output: missing, data: {} }
  const report = await openNsysReport(ctx, env, reportInput)
  try {
    const t = withTiming()
    const { facts } = await resolveTimelineFacts(report)
    const wanted = args.kernel ? String(args.kernel) : ""
    const kernel = wanted ? facts.kernels.find((k) => k.name.includes(wanted)) : facts.kernels[0]
    const elapsed = t()
    const lines: string[] = []
    lines.push(`报告：${report.ref.path}（Nsight Systems：时间线报告）`)
    lines.push(
      "说明：这是时间线报告，只包含内核的调用次数/单次耗时/网格块几何与相邻间隙——不含硬件计数器（SOL、占用率、停顿分解、访存效率）。要判定「为什么慢」需 Nsight Compute 报告（采集命令见文末）。下面给出该内核的时间线调用模式。",
    )
    lines.push("")
    if (!kernel) {
      lines.push(`未在报告中找到匹配「${wanted}」的内核（共 ${formatInt(facts.kernelDistinctGroups)} 个内核，用 nsight_kernels 查看排行）。`)
    } else {
      lines.push(`内核：${kernelRowText(kernel)}（分析耗时 ${(elapsed / 1000).toFixed(2)}s）`)
      lines.push(`  单次：平均 ${formatNs(kernel.avgNs)}，最小 ${formatNs(kernel.minNs)}，最大 ${formatNs(kernel.maxNs)}`)
      lines.push(`  网格 ${kernel.grid.join("×")}，块 ${kernel.block.join("×")}（单次 ${formatInt(kernel.totalThreads)} 线程），寄存器 ${kernel.registersPerThread}，共享内存 ${kernel.smemBytes} B`)
      lines.push(`  所在流：${kernel.streams.join("、")}`)
      const related = facts.launchGaps.filter((g) => g.from.includes(kernel.name.slice(0, 30)) || g.to.includes(kernel.name.slice(0, 30))).slice(0, 5)
      if (related.length) {
        lines.push("  相邻启动间隔：")
        for (const g of related) lines.push(`    ${formatNs(g.gapNs)}：${g.from.slice(0, 40)} → ${g.to.slice(0, 40)}（流 ${g.streamId}）`)
      }
      lines.push(`  在内核总时长中占 ${((kernel.totalNs / Math.max(1, facts.kernelTotalNs)) * 100).toFixed(1)}%`)
    }
    lines.push("")
    lines.push("【获取 Nsight Compute 报告】供 nsight_capture 或手工执行（需 GPU 性能计数器权限）：")
    lines.push(`  ncu --set full --target-processes all -o <输出名> --force-overwrite true <可执行文件及参数>`)
    lines.push("  提示：nsight_doctor 可探测计数器权限；受限时以管理员权限运行，或在 NVIDIA 控制面板开启「开发者 → 管理 GPU 性能计数器」。")
    return { output: lines.join("\n"), data: { kernel } }
  } finally {
    report.close()
  }
}
