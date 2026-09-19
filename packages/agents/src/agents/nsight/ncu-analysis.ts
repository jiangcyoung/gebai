/**
 * Nsight Compute 报告分析（单内核深度分析）：SOL/占用率/停顿分解/访存效率与 NVIDIA 官方优化规则。
 *
 * - 数据来源为 `ncu --import --page <页> --csv` 导出的 CSV 页，全部**流式解析**（大型采集的 raw/source
 *   页可达数百 MB，逐行消费保证内存与报告规模解耦）；
 * - 分析输出分三层：① 官方规则（带预估收益，权威且可直接行动）；② 量化分类（瓶颈单元、占用率上限、
 *   停顿主因、访存效率）；③ 指令级热点（stall 采样最高的 SASS 指令与访存越界扇区），
 *   再由 nsight_locate 把内核符号/源文件映射到工程源码位置。
 */
import type { NsightEnvState } from "./env"
import { cellAt, headerIndex, num, stallColumns, streamCsvFile } from "./csv"
import { ncuPagePath } from "./db"
import type { ReportRef } from "./report"
import { existsSync } from "node:fs"

/** 单个内核的 Nsight Compute 摘要（有界结构）。 */
export interface NcuKernel {
  id: string
  kernelName: string
  processName: string
  device: string
  computeCap: string
  gridSize: string
  blockSize: string
  /** 分区指标：区块名 → 指标名 → 值（含单位）。 */
  sections: Record<string, Record<string, string>>
  /** NVIDIA 官方优化规则（含预估收益）。 */
  rules: Array<{ name: string; type: string; description: string; speedup?: string; speedupType?: string }>
}

const MAX_KERNELS = 40
const KEPT_SECTIONS = new Set([
  "GPU Speed Of Light Throughput",
  "Compute Workload Analysis",
  "Memory Workload Analysis",
  "Scheduler Statistics",
  "Warp State Statistics",
  "Launch Statistics",
  "Occupancy",
  "Source Counters",
  "Instruction Statistics",
  "PM Sampling",
  "Memory Workload Analysis Tables",
])

/** 详情页流式解析：按内核聚合分区指标与规则（内核数上限 MAX_KERNELS，超出丢弃但计数）。 */
export async function readNcuKernels(env: NsightEnvState, ref: ReportRef): Promise<{ kernels: NcuKernel[]; truncated: boolean }> {
  const path = ncuPagePath(env, ref, "details")
  if (!existsSync(path)) throw new Error(`缺少 ncu 详情页缓存：${path}（先执行导入）`)
  const kernels = new Map<string, NcuKernel>()
  let truncated = false
  let index = new Map<string, number>()
  let sawHeader = false
  for await (const row of streamCsvFile(path)) {
    if (!sawHeader && row[0] === "ID") {
      index = headerIndex(row)
      sawHeader = true
      continue
    }
    if (!index.size) continue
    const id = cellAt(row, index, "ID") ?? ""
    const kernelName = cellAt(row, index, "Kernel Name") ?? "(未知内核)"
    const key = `${id}\u0000${kernelName}`
    let kernel = kernels.get(key)
    if (!kernel) {
      if (kernels.size >= MAX_KERNELS) {
        truncated = true
        continue
      }
      kernel = {
        id,
        kernelName,
        processName: cellAt(row, index, "Process Name") ?? "",
        device: cellAt(row, index, "Device") ?? "",
        computeCap: cellAt(row, index, "CC") ?? "",
        gridSize: cellAt(row, index, "Grid Size") ?? "",
        blockSize: cellAt(row, index, "Block Size") ?? "",
        sections: {},
        rules: [],
      }
      kernels.set(key, kernel)
    }
    const ruleName = cellAt(row, index, "Rule Name")
    if (ruleName) {
      kernel.rules.push({
        name: ruleName,
        type: cellAt(row, index, "Rule Type") ?? "",
        description: cellAt(row, index, "Rule Description") ?? "",
        speedup: cellAt(row, index, "Estimated Speedup"),
        speedupType: cellAt(row, index, "Estimated Speedup Type"),
      })
      continue
    }
    const section = cellAt(row, index, "Section Name") ?? ""
    const metric = cellAt(row, index, "Metric Name")
    const value = cellAt(row, index, "Metric Value")
    if (!metric || value === undefined) continue
    if (!KEPT_SECTIONS.has(section)) continue
    const unit = cellAt(row, index, "Metric Unit") ?? ""
    const bucket = (kernel.sections[section] ??= {})
    // 同名指标在不同配置下会重复出现：保留首个非空值（ncu 输出以首个为默认配置口径）
    if (bucket[metric] === undefined) bucket[metric] = unit ? `${value} ${unit}` : value
  }
  return { kernels: [...kernels.values()], truncated }
}

export interface NcuSourceHotspot {
  address: string
  instruction: string
  samples: number
  /** 该指令上各 stall 原因的采样数（仅保留非零项）。 */
  stalls: Record<string, number>
  instructionsExecuted?: number
  /** 越界扇区（非合并访问的直接证据，本指令贡献量）。 */
  excessSectors?: number
  /** 共享内存 bank 冲突（N 路冲突计数）。 */
  bankConflicts?: number
  /** 关联源文件（报告导入源码时可得）。 */
  sourceFile?: string
  sourceLine?: number
}

export interface NcuSourceAggregate {
  /** stall 原因 → 采样总数（跨指令汇总）。 */
  stallTotals: Record<string, number>
  /** 访问效率汇总。 */
  excessSectors: number
  idealSectors: number
  bankConflicts: number
  bankWavefrontsExcessive: number
  hotspots: NcuSourceHotspot[]
  instructionRows: number
  /** 报告是否含源码关联（决定能否给出源码行）。 */
  hasSourceCorrelation: boolean
  sourceFiles: string[]
}

/**
 * 源码/指令页流式解析：汇总 stall 原因、访存效率，并保留 stall 采样最高的若干指令。
 * 单趟扫描，内存与页大小解耦（热点用有界集合维护）。
 */
export async function readNcuSource(env: NsightEnvState, ref: ReportRef, topHotspots = 25): Promise<NcuSourceAggregate> {
  const path = ncuPagePath(env, ref, "source")
  const agg: NcuSourceAggregate = {
    stallTotals: {},
    excessSectors: 0,
    idealSectors: 0,
    bankConflicts: 0,
    bankWavefrontsExcessive: 0,
    hotspots: [],
    instructionRows: 0,
    hasSourceCorrelation: false,
    sourceFiles: [],
  }
  if (!existsSync(path)) return agg
  let index = new Map<string, number>()
  let sawHeader = false
  let stallCols: Array<{ name: string; index: number }> = []
  // 源码文件名可能出现在表头之外的行（ncu 以 "Kernel Name","<name>" 形式给出关联文件）；按需收集
  for await (const row of streamCsvFile(path)) {
    if (!sawHeader && row[0] === "Address") {
      index = headerIndex(row)
      stallCols = stallColumns(row)
      sawHeader = true
      continue
    }
    if (!sawHeader) {
      // 页首的元信息行：收集可能的源文件条目
      const maybeFile = row[row.length - 1]
      if (maybeFile && /\.(cu|cuh|cpp|h|hpp)$/i.test(maybeFile.trim())) {
        const f = maybeFile.trim()
        if (!agg.sourceFiles.includes(f)) agg.sourceFiles.push(f)
        agg.hasSourceCorrelation = true
      }
      continue
    }
    agg.instructionRows++
    const stalls: Record<string, number> = {}
    for (const col of stallCols) {
      const v = num(cellAt(row, index, col.name))
      if (v && v > 0) {
        stalls[col.name] = v
        agg.stallTotals[col.name] = (agg.stallTotals[col.name] ?? 0) + v
      }
    }
    const excess = num(cellAt(row, index, "L2 Theoretical Sectors Global Excessive")) ?? 0
    const ideal = num(cellAt(row, index, "L2 Theoretical Sectors Global Ideal")) ?? 0
    const conflicts = num(cellAt(row, index, "L1 Conflicts Shared N-Way")) ?? 0
    const wavefrontsExcessive = num(cellAt(row, index, "L1 Wavefronts Shared Excessive")) ?? 0
    agg.excessSectors += excess
    agg.idealSectors += ideal
    agg.bankConflicts += conflicts
    agg.bankWavefrontsExcessive += wavefrontsExcessive

    const samples = num(cellAt(row, index, "Warp Stall Sampling (All Samples)")) ?? 0
    const address = cellAt(row, index, "Address") ?? ""
    const instruction = (cellAt(row, index, "Source") ?? "").trim()
    // 源文件列（不同版本命名不同）
    const fileCell = cellAt(row, index, "Source File") ?? cellAt(row, index, "File")
    const lineCell = cellAt(row, index, "Source Line") ?? cellAt(row, index, "Line")
    if (fileCell && /\.(cu|cuh|cpp|h|hpp)$/i.test(fileCell)) {
      agg.hasSourceCorrelation = true
      if (!agg.sourceFiles.includes(fileCell)) agg.sourceFiles.push(fileCell)
    }
    if (samples <= 0 && !excess && !conflicts) continue
    const hotspot: NcuSourceHotspot = {
      address,
      instruction,
      samples,
      stalls,
      instructionsExecuted: num(cellAt(row, index, "Instructions Executed")),
      excessSectors: excess || undefined,
      bankConflicts: conflicts || undefined,
      sourceFile: fileCell && /\.(cu|cuh|cpp|h|hpp)$/i.test(fileCell) ? fileCell : undefined,
      sourceLine: num(lineCell),
    }
    agg.hotspots.push(hotspot)
    if (agg.hotspots.length > topHotspots * 8) {
      // 有界维护：按采样数保留最高的若干条
      agg.hotspots.sort((a, b) => b.samples - a.samples)
      agg.hotspots.length = topHotspots
    }
  }
  agg.hotspots.sort((a, b) => b.samples - a.samples)
  agg.hotspots = agg.hotspots.slice(0, topHotspots)
  agg.sourceFiles = agg.sourceFiles.slice(0, 20)
  return agg
}

/** 从分区指标里取数值（去掉单位）；缺列返回 undefined。 */
export function metricNum(kernel: NcuKernel, section: string, metric: string): number | undefined {
  const raw = kernel.sections[section]?.[metric]
  return raw === undefined ? undefined : num(raw.replace(/%|cycle|inst|warp|thread|block|register\/thread|byte\/block|Kbyte|Mbyte|Gbyte\/s|Ghz|us|ns|ms|/g, ""))
}

export function metricText(kernel: NcuKernel, section: string, metric: string): string | undefined {
  return kernel.sections[section]?.[metric]
}

export type NcuSeverity = "critical" | "high" | "medium" | "low" | "info"

export interface NcuFinding {
  id: string
  severity: NcuSeverity
  title: string
  evidence: string[]
  cause: string
  suggestion: string
  /** 官方规则的原始描述（NVIDIA 规则才有的权威说明）。 */
  official?: boolean
  /** 预估收益（官方规则携带，形如 local/11.31）。 */
  estimatedSpeedup?: string
}

const severityRank: Record<NcuSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

/** 官方规则类型 → 严重度（OPT=可优化建议、WRN=警告、INF=信息）。 */
function ruleSeverity(type: string, speedup?: string): NcuSeverity {
  const numeric = speedup ? Number(speedup.split("/").pop()) : 0
  if (type === "OPT") return numeric >= 20 ? "high" : numeric >= 5 ? "medium" : "low"
  if (type === "WRN") return "high"
  return "info"
}

export interface NcuDiagnosis {
  findings: NcuFinding[]
  /** 瓶颈分类（带宽受限 / 延迟受限 / 计算受限）。 */
  bottleneck: string
  /** SOL 指标表（渲染用）。 */
  sol: Record<string, string>
}

/**
 * Nsight Compute 诊断：官方规则优先，其次为量化分类（SOL/占用率/停顿/访存效率）。
 */
export function diagnoseNcu(kernel: NcuKernel, source: NcuSourceAggregate): NcuDiagnosis {
  const findings: NcuFinding[] = []

  // ① NVIDIA 官方规则（权威、可直接行动）
  for (const rule of kernel.rules) {
    findings.push({
      id: `rule:${rule.name}`,
      severity: ruleSeverity(rule.type, rule.speedup),
      title: `官方规则 ${rule.name}：${rule.description.split(".")[0] ?? ""}`,
      evidence: [`规则类型 ${rule.type}${rule.speedup ? `，预估收益 ${rule.speedup}` : ""}`, rule.description],
      cause: "NVIDIA Nsight Compute 依据该内核的实测计数器判定（规则描述即根因说明）。",
      suggestion: rule.description,
      official: true,
      estimatedSpeedup: rule.speedup,
    })
  }

  // ② SOL：瓶颈单元
  const compute = metricNum(kernel, "GPU Speed Of Light Throughput", "Compute (SM) Throughput")
  const memory = metricNum(kernel, "GPU Speed Of Light Throughput", "Memory Throughput")
  const dram = metricNum(kernel, "GPU Speed Of Light Throughput", "DRAM Throughput")
  const l1 = metricNum(kernel, "GPU Speed Of Light Throughput", "L1/TEX Cache Throughput")
  const l2 = metricNum(kernel, "GPU Speed Of Light Throughput", "L2 Cache Throughput")
  const duration = kernel.sections["GPU Speed Of Light Throughput"]?.["Duration"]
  const sol: Record<string, string> = {}
  for (const [k, v] of Object.entries(kernel.sections["GPU Speed Of Light Throughput"] ?? {})) sol[k] = v
  if (duration) sol["Duration"] = duration

  let bottleneck = "未判定（缺少 SOL 指标）"
  if (memory !== undefined && compute !== undefined) {
    const parts: Array<[string, number]> = (
      [
        ["显存带宽（DRAM）", dram ?? memory],
        ["计算（SM）", compute],
        ["L1/TEX 缓存", l1 ?? 0],
        ["L2 缓存", l2 ?? 0],
      ] as Array<[string, number]>
    ).sort((a, b) => b[1] - a[1])
    const [unit, value] = parts[0]!
    bottleneck = value >= 60 ? `受限于${unit}（${value.toFixed(1)}% of peak）` : `无单一饱和单元（最高 ${unit} ${value.toFixed(1)}%），属延迟受限/占用率受限`
    if (value >= 60) {
      findings.push({
        id: "sol-bottleneck",
        severity: value >= 80 ? "high" : "medium",
        title: `性能单元饱和：${unit} 已达峰值的 ${value.toFixed(1)}%`,
        evidence: parts.map(([n, v]) => `${n}：${v.toFixed(1)}%`),
        cause: "该单元已接近硬件峰值，继续优化该单元收益有限，需把工作转移到其他单元或减少总工作量。",
        suggestion:
          unit.includes("显存")
            ? "减少访存总量（数据复用/分块入共享内存/降低精度），并核验访问是否合并（见访存效率项）。"
            : unit.includes("计算")
              ? "检查是否存在冗余计算；考虑用更快指令/降低精度；若为访存等待导致虚假饱和，先解决访存。"
              : "检查缓存命中率与扇区效率（L1/L2 命中率、越界扇区），改善数据局部性。",
      })
    }
  }

  // ③ 占用率
  const theoretical = metricNum(kernel, "Occupancy", "Theoretical Occupancy")
  const achieved = metricNum(kernel, "Occupancy", "Achieved Occupancy")
  const limitRegs = metricNum(kernel, "Occupancy", "Block Limit Registers")
  const limitSmem = metricNum(kernel, "Occupancy", "Block Limit Shared Mem")
  const limitWarps = metricNum(kernel, "Occupancy", "Block Limit Warps")
  const limitBlocks = metricNum(kernel, "Occupancy", "Block Limit SM")
  const warpsPerScheduler = metricNum(kernel, "Scheduler Statistics", "Active Warps Per Scheduler")
  const eligible = metricNum(kernel, "Scheduler Statistics", "No Eligible")
  if (achieved !== undefined && achieved < 40) {
    const limits: Array<[string, number | undefined]> = [
      ["寄存器", limitRegs],
      ["共享内存", limitSmem],
      ["线程/块配置（warp 上限）", limitWarps],
      ["每 SM 块数上限（硬件）", limitBlocks],
    ]
    const binding = limits.filter(([, v]) => v !== undefined).sort((a, b) => a[1]! - b[1]!)[0]
    findings.push({
      id: "low-occupancy",
      severity: achieved < 20 ? "high" : "medium",
      title: `占用率偏低：实达 ${achieved.toFixed(1)}%（理论上限 ${theoretical?.toFixed(1) ?? "?"}%）`,
      evidence: [
        `理论占用率 ${theoretical?.toFixed(1) ?? "?"}%，实达 ${achieved?.toFixed(1) ?? "?"}%`,
        ...limits.filter(([, v]) => v !== undefined).map(([n, v]) => `限制因素 ${n}：每 SM 最多 ${v} 个块`),
        binding ? `当前最紧的限制是「${binding[0]}」` : "",
        warpsPerScheduler !== undefined ? `每调度器活跃 warp ${warpsPerScheduler.toFixed(2)}` : "",
        eligible !== undefined ? `无合格 warp 的周期占比 ${eligible.toFixed(1)}%` : "",
      ].filter(Boolean),
      cause:
        "可驻留 warp 数不足，无法隐藏访存与指令延迟；若限制来自寄存器或共享内存，是内核资源占用过高所致；若理论占用率本身就低，则是块尺寸/共享内存配置导致的。",
      suggestion:
        "按限制因素处理：寄存器 → __launch_bounds__/maxrregcount 或拆分内核；共享内存 → 缩小分块或降低存储精度；块尺寸 → 调整为 warp 数成倍的块（如 128/256）并核对每 SM 块数上限。先看停顿主因确认延迟确实未被隐藏。",
    })
  }

  // ④ 停顿主因（源采样汇总）
  const stallEntries = Object.entries(source.stallTotals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
  if (stallEntries.length) {
    const total = stallEntries.reduce((s, [, v]) => s + v, 0)
    const top = stallEntries.slice(0, 5)
    const reasonText = (name: string): string =>
      ({
        long_sb: "长记分板（全局/纹理访存延迟）",
        short_sb: "短记分板（共享内存/常量访存）",
        wait: "执行依赖等待（固定延迟指令）",
        barrier: "块内屏障同步（CTABAR）",
        membar: "内存屏障",
        lg: "全局访存队列（LG Throttle）",
        mio: "MIO 指令队列（共享内存/特殊功能单元）",
        math: "数学流水线吞吐",
        tex: "纹理单元吞吐",
        imc: "常量缓存未命中",
        drain: "指令排空",
        dispatch: "调度停顿",
        no_inst: "无可发射指令",
        not_selected: "已就绪但未被选中（warp 过多竞争）",
        selected: "被选中发射",
        misc: "其他",
        sleep: "休眠等待",
        branch_resolving: "分支解析",
      })[name] ?? name
    findings.push({
      id: "stall-dominant",
      severity: top[0]![1] / total > 0.5 ? "high" : "medium",
      title: `停顿主因：${reasonText(top[0]![0])}（占停顿采样 ${((top[0]![1] / total) * 100).toFixed(1)}%）`,
      evidence: top.map(([n, v]) => `${reasonText(n)}（${n}）：${v} 采样，占 ${((v / total) * 100).toFixed(1)}%`),
      cause:
        top[0]![0] === "long_sb" || top[0]![0] === "short_sb"
          ? "warp 在等待访存数据返回——访存延迟未被足够多的并行 warp 隐藏（延迟受限）。"
          : top[0]![0] === "barrier"
            ? "warp 在块内屏障处等待同伴——块内负载不均或同步点前的代码路径不一致。"
            : top[0]![0] === "not_selected" || top[0]![0] === "no_inst"
              ? "warp 已就绪但发射槽不足或没有可发射指令——调度/指令供给侧受限。"
              : "该停顿原因主导了 warp 的等待时间（详见停顿分解）。",
      suggestion:
        top[0]![0] === "long_sb"
          ? "提高访存并行度：合并访问、向量化访存（float4/double2）、预取到共享内存、增加每线程独立访存量（展开循环）、或提高占用率以增加可切换 warp。"
          : top[0]![0] === "barrier"
            ? "均衡块内工作量（避免部分 warp 提前到达屏障）；减小块尺寸；把同步点前的长延迟操作（访存）提前或改到同步点之后。"
            : "核对指令供给与调度：减少指令依赖链、避免过高占用率造成发射竞争（not_selected 高时提高每 warp 的工作量）。",
    })
  }

  // ⑤ 访存效率（越界扇区 = 非合并访问）
  if (source.idealSectors > 0) {
    const ratio = (source.idealSectors + source.excessSectors) / source.idealSectors
    if (ratio > 1.15) {
      const topOffenders = source.hotspots.filter((h) => (h.excessSectors ?? 0) > 0).slice(0, 5)
      findings.push({
        id: "uncoalesced-access",
        severity: ratio > 2 ? "high" : "medium",
        title: `全局访存非合并：实际扇区数为理想值的 ${ratio.toFixed(2)} 倍`,
        evidence: [
          `理想扇区 ${source.idealSectors}，越界扇区 ${source.excessSectors}（多取 ${(((ratio - 1) * 100)).toFixed(1)}%）`,
          ...topOffenders.map((h) => `指令 ${h.address} ${h.instruction}：越界扇区 ${h.excessSectors}`),
        ],
        cause:
          "同一 warp 内线程访问的地址不连续，硬件按 32B 扇区取数时产生多余事务——有效带宽被浪费，且延迟更高。",
        suggestion:
          "让相邻线程访问相邻地址（索引改写为 threadIdx.x 连续维；结构体数组改数组结构体 SoA）；使用向量化访存；跨步访问改为共享内存转置后再连续读写。",
      })
    }
  }

  // ⑥ 共享内存 bank 冲突
  if (source.bankConflicts > 0 || source.bankWavefrontsExcessive > 0) {
    findings.push({
      id: "shared-bank-conflict",
      severity: source.bankConflicts > source.idealSectors * 0.1 ? "medium" : "low",
      title: `共享内存 bank 冲突：N 路冲突计数 ${source.bankConflicts}，多余 wavefront ${source.bankWavefrontsExcessive}`,
      evidence: [
        `L1 共享内存 N 路冲突合计 ${source.bankConflicts}`,
        `共享内存多余 wavefront ${source.bankWavefrontsExcessive}`,
        ...source.hotspots
          .filter((h) => (h.bankConflicts ?? 0) > 0)
          .slice(0, 5)
          .map((h) => `指令 ${h.address} ${h.instruction}：冲突 ${h.bankConflicts}`),
      ],
      cause: "同一 warp 内多个线程访问共享内存的同一 bank（不同地址），硬件需串行化这些访问。",
      suggestion: "调整共享内存布局或访问下标避免同 bank 冲突（如加 padding 打破 2 的幂步长、转置访问顺序、使用广播）。",
    })
  }

  // ⑦ 分支发散
  const branchEfficiency = metricNum(kernel, "Source Counters", "Branch Efficiency")
  const divergent = metricNum(kernel, "Source Counters", "Avg. Divergent Branches")
  if (branchEfficiency !== undefined && branchEfficiency < 100 && divergent !== undefined && divergent > 0) {
    findings.push({
      id: "branch-divergence",
      severity: branchEfficiency < 80 ? "medium" : "low",
      title: `分支发散：分支效率 ${branchEfficiency.toFixed(1)}%，平均发散分支 ${divergent.toFixed(2)}`,
      evidence: [`分支效率 ${branchEfficiency.toFixed(1)}%`, `平均发散分支数 ${divergent.toFixed(2)}`],
      cause: "同一 warp 内线程走了不同分支路径，两条路径被串行执行，有效并行度下降。",
      suggestion: "把发散分支改为谓词化运算（无副作用时），或按条件重排数据/线程映射使同 warp 走同一路径；避免 warp 内的条件循环。",
    })
  }

  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || 0)
  return { findings, bottleneck, sol }
}

/** 访存效率摘要文本（诊断输出的固定片段）。 */
export function accessEfficiencyText(source: NcuSourceAggregate): string {
  if (!source.idealSectors && !source.excessSectors) return "（源页无访存效率数据）"
  const ratio = source.idealSectors > 0 ? (source.idealSectors + source.excessSectors) / source.idealSectors : 0
  return `理想扇区 ${source.idealSectors}，越界扇区 ${source.excessSectors}（实际/理想 ${ratio.toFixed(2)}×）；共享内存 N 路冲突 ${source.bankConflicts}，多余 wavefront ${source.bankWavefrontsExcessive}`
}

/** 渲染内核指标摘要（按分区）。 */
export function renderKernelSections(kernel: NcuKernel, sections: string[] = ["GPU Speed Of Light Throughput", "Occupancy", "Launch Statistics", "Scheduler Statistics", "Memory Workload Analysis"]): string[] {
  const lines: string[] = []
  for (const s of sections) {
    const bucket = kernel.sections[s]
    if (!bucket) continue
    lines.push(`【${s}】`)
    for (const [k, v] of Object.entries(bucket)) lines.push(`  ${k} = ${v}`)
  }
  return lines
}
