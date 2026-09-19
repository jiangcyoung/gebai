/**
 * 性能诊断引擎：把时间线事实转成「问题清单」——每条含量化证据、根因、修复方向与**待定位符号**。
 *
 * 设计要点：
 * - 规则只用报告内可直接观测的量（时间占比、并发度、包大小、网格/块规模、寄存器/共享内存）；
 *   需要硬件计数器才能判定的（SOL、占用率上限、stall 分解）交 ncu 侧，本层不越界推断；
 * - 每条 finding 带 `symbols`：kernel / NVTX / API 名，由 nsight_locate 映射到源码位置——
 *   这是「定位到代码问题」的接续点；
 * - 排序按严重度 + 可回收时间（先修占比大的），避免报告退化成告警堆；
 * - 全部输入为流式聚合事实（与报告规模无关的有界结构），因此诊断本身可对超大报告实时执行。
 */
import type { ApiFacts, GraphFacts, KernelStat, NvtxFacts, OverheadFacts, SyncFacts, TimelineFacts } from "./nsys-analysis"
import type { SymbolHint } from "../../core/perf/locate"
import { formatBytes, formatInt, formatNs, formatPct } from "../../core/perf/format"

/** 诊断阈值（集中定义便于复核）：值为经验值，报告文本带出实测值供判断。 */
export const FINDING_THRESHOLDS = {
  /** GPU 利用率低于此值视为存在明显空闲。 */
  lowUtilization: 0.6,
  /** 同步等待占会话窗比例上限。 */
  syncShare: 0.1,
  /** 单次同步等待超过此值即为显著阻塞（1 ms）。 */
  syncStallNs: 1_000_000,
  /** 视为「小内核」的时长上限（与分析的归类口径一致）。 */
  smallKernelNs: 10_000,
  /** 小内核调用数下限（超过则判定为启动开销受限）。 */
  smallKernelCount: 100,
  /** 单次传输平均包大小下限（低于此值的零散拷贝效率低）。 */
  minTransferBytes: 1_000_000,
  /** kernel 热点集中度：单 kernel 占总 kernel 时间比例。 */
  hotKernelShare: 0.5,
  /** 传输时间占会话窗比例。 */
  transferShare: 0.2,
  /** 多卡间的利用率差超此值即判为负载不均衡（单卡停滞会被合并口径掩盖）。 */
  deviceUtilSpread: 0.3,
  /** 采集器自身开销占活动窗口超过此值即提示「报告可能被扰动」。 */
  overheadShare: 0.05,
  /** CUDA Graph 执行占活动窗口超过此值时提示「图结构在逐内核视图里不可见」。 */
  graphShare: 0.3,
} as const

export type Severity = "critical" | "high" | "medium" | "low" | "info"

export interface Finding {
  id: string
  severity: Severity
  title: string
  /** 量化证据（报告实测值，可直接复核）。 */
  evidence: string[]
  /** 根因解释。 */
  cause: string
  /** 可执行的修复方向。 */
  suggestion: string
  /** 关联符号（交给 nsight_locate 定位源码）。 */
  symbols: SymbolHint[]
  /** 可回收时间估计（排序与优先级依据）。 */
  reclaimableNs: number
}

export interface Diagnosis {
  findings: Finding[]
  /** 会话级度量摘要（findings 的判定依据）。 */
  metrics: Record<string, number | string>
  /** 未能分析的维度说明（缺表/未采集）。 */
  skipped: string[]
}

const severityRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export function severityLabel(s: Severity): string {
  return { critical: "严重", high: "高", medium: "中", low: "低", info: "信息" }[s]
}

function kernelSymbols(stats: KernelStat[]): SymbolHint[] {
  return stats.map((k) => ({
    // 用 demangled 名（可直接在工程源码中搜索；mangled 名仅库内可见，不作搜索词）
    kind: "kernel" as const,
    value: k.name,
    weightNs: k.totalNs,
    note: `${k.instances} 次调用，平均 ${formatNs(k.avgNs)}`,
  }))
}

/** 证据文本里的符号缩写：内核 demangled 名可达数百字符（模板+lambda 展开），直接入报告会淹没结论。 */
export function shortSymbol(name: string, max = 72): string {
  if (name.length <= max) return name
  const head = name.slice(0, max - 12)
  // 模板内的 lambda 展开无信息量——裁到首个模板参数前即可辨认
  const cut = head.lastIndexOf("<")
  return `${cut > max / 2 ? head.slice(0, cut) : head}…(${name.length} 字符)`
}

export interface DiagnoseInput {
  facts: TimelineFacts
  api: ApiFacts
  sync: SyncFacts
  nvtx: NvtxFacts
  devices: Array<{ gpuId: number; name?: string; computeCap?: string; pid: number }>
  /** 采集器自身开销（可缺——缺时不做扰动判定）。 */
  overhead?: OverheadFacts
  /** CUDA Graph 维度（可缺；未采集时如实列入 skipped）。 */
  graph?: GraphFacts
  /** 最长空闲缝的邻接活动（按需查询所得，长度与 gaps 一致）。 */
  gapNeighbours?: Array<{ before?: string; after?: string; beforeStream?: number; afterStream?: number }>
}

export function diagnoseNsys(input: DiagnoseInput): Diagnosis {
  const { facts, api, sync, nvtx, devices, overhead, graph } = input
  const findings: Finding[] = []
  const skipped: string[] = []
  const windowNs = Math.max(facts.windowNs, 1)
  const kernelShareOfWindow = facts.kernelTotalNs / windowNs

  const metrics: Record<string, number | string> = {
    会话时长: formatNs(facts.windowNs),
    "GPU 忙碌时间": formatNs(facts.busyNs),
    "GPU 利用率": formatPct(facts.utilization),
    "空闲缝总时长": formatNs(facts.gapTotalNs),
    "空闲缝数量": facts.gapCount,
    "内核调用次数": facts.kernelInstances,
    "内核分组数": facts.kernelDistinctGroups,
    "内核总时长": formatNs(facts.kernelTotalNs),
    "显存传输次数": facts.memcpyCount,
    "显存传输总时长": formatNs(facts.memcpyTotalNs),
    "显存传输字节": formatBytes(facts.memcpyBytes),
    "CUDA API 调用": api.count,
    "CUDA API 总时长": formatNs(api.totalNs),
    同步次数: sync.count,
    同步等待总时长: formatNs(sync.totalNs),
    流数量: facts.streams.length,
    "最大并发内核数": facts.maxConcurrent,
    NVTX区间数: nvtx.count,
  }
  if (!facts.kernelInstances) skipped.push("报告内无内核事件（纯传输/纯 CPU 采集，或采集时未启用 CUDA trace）")
  if (!sync.count) skipped.push("报告内无同步事件（CUPTI 同步跟踪未启用）")
  if (!nvtx.available) skipped.push("报告内无 NVTX 表（采集未启用 nvtx trace）")
  if (overhead && !overhead.available) skipped.push("报告内无 PROFILER_OVERHEAD 表（采集未启用开销跟踪）——无法判定采集扰动是否影响其他结论")
  if (graph && !graph.available) skipped.push(graph.note ?? "报告内无 CUDA Graph 事件表（采集未启用图跟踪）——不代表程序没有用图")

  // ---- 规则 1：GPU 空闲占比高 ----
  if (facts.windowNs > 0 && facts.utilization < FINDING_THRESHOLDS.lowUtilization) {
    const gapShare = facts.gapTotalNs / windowNs
    const top = facts.gaps.slice(0, 5)
    const neigh = input.gapNeighbours ?? []
    findings.push({
      id: "gpu-idle",
      severity: gapShare > 0.5 ? "critical" : "high",
      title: `GPU 空闲占比高：利用率 ${formatPct(facts.utilization)}，空闲 ${formatNs(facts.gapTotalNs)}`,
      evidence: [
        `GPU 活动窗口 ${formatNs(facts.windowNs)}，其中有活动 ${formatNs(facts.busyNs)}（利用率 ${formatPct(facts.utilization)}）`,
        `空闲缝 ${facts.gapCount} 段，合计 ${formatNs(facts.gapTotalNs)}（占窗口 ${formatPct(gapShare)}）${facts.gapsTruncated ? "（空闲缝过多，仅统计前 5 万段）" : ""}`,
        ...top.map((g, i) => {
          const n = neigh[i]
          return `第 ${i + 1} 长空闲缝 ${formatNs(g.durNs)}：前序「${shortSymbol(n?.before ?? "（无内核，可能是传输或主机侧）", 56)}」→ 后续「${shortSymbol(n?.after ?? "（无内核）", 56)}」`
        }),
      ],
      cause:
        "GPU 在等待主机侧工作（内核启动、同步、数据准备）或计算与传输未重叠——空闲区间内设备算力完全未被利用。",
      suggestion:
        "沿最长空闲缝的邻接活动排查：前序是同步等待 → 去同步化（流/事件替代设备级同步）；空闲夹在传输与计算之间 → 多流重叠；后续内核间隔大 → 检查主机侧准备（页锁定内存、预分配缓冲、避免每步重建上下文）。",
      symbols: [...nvtx.top.slice(0, 3).map((n) => ({ kind: "nvtx" as const, value: n.text, weightNs: n.totalNs })), ...kernelSymbols(facts.kernels.slice(0, 5))],
      reclaimableNs: facts.gapTotalNs,
    })
  }

  // ---- 规则 1b：多卡不均衡/单卡停滞（合并口径会把「一卡忙一卡闲」掩盖成利用率正常）----
  if (facts.devices.length > 1) {
    const maxUtil = Math.max(...facts.devices.map((d) => d.utilization))
    const minDev = facts.devices.reduce((a, b) => (b.utilization < a.utilization ? b : a))
    const minUtil = minDev.utilization
    const spread = maxUtil - minUtil
    for (const d of facts.devices) {
      metrics[`device ${d.deviceId} 利用率`] = formatPct(d.utilization)
      metrics[`device ${d.deviceId} 忙碌`] = formatNs(d.busyNs)
    }
    // 某卡明显比最忙的卡闲（差值超阈值）→ 该卡的算力在浪费，必须单独指出（不能只看合并利用率）
    if (spread >= FINDING_THRESHOLDS.deviceUtilSpread) {
      const idleDevices = facts.devices.filter((d) => maxUtil - d.utilization >= FINDING_THRESHOLDS.deviceUtilSpread)
      const idleTotal = idleDevices.reduce((acc, d) => acc + (facts.windowNs - d.busyNs), 0)
      findings.push({
        id: "device-imbalance",
        severity: minUtil < FINDING_THRESHOLDS.lowUtilization ? "high" : "medium",
        title: `多卡负载不均衡：device ${minDev.deviceId} 利用率 ${formatPct(minUtil)}，最忙的卡 ${formatPct(maxUtil)}（相差 ${formatPct(spread)}）`,
        evidence: [
          `报告内含 ${facts.devices.length} 张 GPU（合并口径利用率 ${formatPct(facts.utilization)}——它只回答「机器有活干吗」，不回答「哪张卡被困住」）`,
          ...facts.devices.map((d) => `device ${d.deviceId}：忙碌 ${formatNs(d.busyNs)}，利用率 ${formatPct(d.utilization)}，内核 ${d.kernelInstances} 次，卡内空闲缝 ${formatNs(d.gapTotalNs)}（${d.gapCount} 段）`),
          `空闲侧共 ${idleDevices.length} 张卡低于最忙卡 ${formatPct(FINDING_THRESHOLDS.deviceUtilSpread)} 以上，合计闲置 ${formatNs(idleTotal)}`,
        ],
        cause:
          "负载没铺满所有 GPU：数据并行未生效、批次被切成不等份、或某卡的依赖链更长（串行段、同步点、只在一卡上分配的张量）——被闲置卡的时间与显存全浪费。",
        suggestion:
          "先查任务划分：DataParallel/DDP 是否真把 batch 均分到各卡；再看是否有单卡串行段（在一张卡上初始化/聚合/拷贝后再分发）；若各卡工作量本就不同（模型并行/流水线）则按阶段名（NVTX）对齐各卡时间线看瓶颈阶段落在哪张卡。",
        symbols: [...nvtx.top.slice(0, 3).map((n) => ({ kind: "nvtx" as const, value: n.text, weightNs: n.totalNs }))],
        reclaimableNs: idleTotal,
      })
    }
  }

  // ---- 规则 1c：采集本身的开销扰动（判断报告里的空闲/等待是否可信）----
  if (overhead?.available && overhead.count > 0 && facts.windowNs > 0) {
    // 只用**落在活动窗口内**的开销算扰动：启动/退出阶段的一次性开销不影响窗口内结论
    const overheadShare = overhead.inWindowNs / facts.windowNs
    metrics["采集开销占比（窗口内）"] = formatPct(overheadShare)
    if (overhead.beforeWindowNs > 0 || overhead.afterWindowNs > 0) {
      metrics["采集开销（窗口外）"] = `${formatNs(overhead.beforeWindowNs)} 启动 + ${formatNs(overhead.afterWindowNs)} 退出`
    }
    if (overheadShare > FINDING_THRESHOLDS.overheadShare) {
      findings.push({
        id: "profiler-overhead",
        severity: overheadShare > 0.2 ? "high" : "medium",
        title: `采集器自身开销占活动窗口 ${formatPct(overheadShare)}（窗口内 ${formatNs(overhead.inWindowNs)}）——窗口内的测量可能被采集扰动`,
        evidence: [
          `窗口内开销 ${formatNs(overhead.inWindowNs)}（占活动窗口 ${formatPct(overheadShare)}）`,
          `窗口外开销（不影响窗口内结论）：启动阶段 ${formatNs(overhead.beforeWindowNs)}、退出阶段 ${formatNs(overhead.afterWindowNs)}`,
          `开销点共 ${formatInt(overhead.count)} 个、合计 ${formatNs(overhead.totalNs)}`,
          ...overhead.top.slice(0, 3).map((o) => `开销点 ${o.name}：${formatInt(o.count)} 次，合计 ${formatNs(o.totalNs)}，最长 ${formatNs(o.maxNs)}`),
          `活动窗口 ${formatNs(facts.windowNs)}`,
        ],
        cause:
          "CUPTI 插桩会给被测程序引入额外开销（记录事件、写缓冲、必要时同步）。开销占比高时，报告里的空闲缝与同步等待可能部分是采集扰动而非程序本身的问题——按本报告下的结论需要打折看。",
        suggestion:
          "降低采集粒度确认：减少 trace 项（只留需要的：cuda,nvtx）、加大缓冲（--cuda-buffer-size）、或改用分段采集（--capture-range=cudaProfilerApi 只采关键区间）后再对比同一负载的空闲与同步指标；若结论只在开销高时出现，先复测再动手改代码。",
        symbols: [],
        reclaimableNs: 0,
      })
    }
  }

  // ---- 规则 1d：CUDA Graph 结构在逐内核视图里不可见（提示，非缺陷）----
  if (graph?.available && graph.graphCount > 0 && facts.windowNs > 0) {
    const graphShare = graph.graphTotalNs / facts.windowNs
    metrics["CUDA Graph 执行时长"] = formatNs(graph.graphTotalNs)
    if (graphShare > FINDING_THRESHOLDS.graphShare) {
      findings.push({
        id: "cuda-graph-opaque",
        severity: "info",
        title: `CUDA Graph 占活动窗口 ${formatPct(graphShare)}（${formatNs(graph.graphTotalNs)}）——图内部结构不在逐内核视图里`,
        evidence: [
          `图执行 ${formatInt(graph.graphCount)} 次、总时长 ${formatNs(graph.graphTotalNs)}、图内节点合计 ${formatInt(graph.nodeCount)}`,
          `活动窗口 ${formatNs(facts.windowNs)}`,
        ],
        cause:
          "图执行时内核由驱动按图内依赖一次性提交：逐内核时间线看不到节点间的依赖与图的重放逻辑，因此「内核启动间隔大/并发低」这类结论在图主导的区间里可能反映的是图结构而非代码问题。",
        suggestion:
          "按图节点维度看：用 nsys 的 --cuda-graph-trace=node 采集后在 Nsight Systems 界面按 graph node 展开；优化点在图的构建与重放策略（图捕获是否覆盖了该覆盖的段、是否每次迭代重建图）。",
        symbols: [],
        reclaimableNs: 0,
      })
    }
  }

  // ---- 规则 2：同步阻塞 ----
  const syncShare = sync.totalNs / windowNs
  if (sync.totalNs > 0 && (syncShare > FINDING_THRESHOLDS.syncShare || (sync.longest[0]?.durNs ?? 0) > FINDING_THRESHOLDS.syncStallNs)) {
    const longest = sync.longest[0]
    findings.push({
      id: "sync-stall",
      severity: syncShare > 0.3 ? "critical" : "high",
      title: `同步等待成为瓶颈：共 ${formatNs(sync.totalNs)}（占会话 ${formatPct(syncShare)}）`,
      evidence: [
        ...sync.byKind.map((k) => `${k.kind}：${k.count} 次，合计 ${formatNs(k.totalNs)}`),
        ...(longest ? [`最长单次同步 ${formatNs(longest.durNs)}（${longest.kind}）`] : []),
        ...api.blocking.slice(0, 5).map((a) => `阻塞型 API ${a.name}：${a.count} 次，合计 ${formatNs(a.totalNs)}，最长 ${formatNs(a.maxNs)}`),
      ],
      cause:
        "主机线程被设备同步调用挂住（cudaDeviceSynchronize / cudaEventSynchronize / 同步 cudaMemcpy / 每步 .item() ），CPU 在此期间无法继续提交工作，形成「提交—等待—再提交」的串行循环。",
      suggestion:
        "用流与事件替代设备级同步；同步拷贝改异步拷贝（cudaMemcpyAsync + 页锁定内存）并延后到真正需要结果时等待；训练/推理循环里避免每步设备同步（计时、日志打印、取标量值都会隐含触发）。",
      symbols: [...api.blocking.slice(0, 5).map((a) => ({ kind: "api" as const, value: a.name, weightNs: a.totalNs })), ...kernelSymbols(facts.kernels.slice(0, 3))],
      reclaimableNs: sync.totalNs,
    })
  }

  // ---- 规则 3：热点内核集中 ----
  const hottest = facts.kernels[0]
  if (hottest && facts.kernelTotalNs > 0 && hottest.totalNs / facts.kernelTotalNs > FINDING_THRESHOLDS.hotKernelShare) {
    findings.push({
      id: "hot-kernel",
      severity: "high",
      title: `单一内核主导：${formatPct(hottest.totalNs / facts.kernelTotalNs)} 的内核时间花在 ${shortSymbol(hottest.name, 56)}`,
      evidence: [
        `${hottest.instances} 次调用，合计 ${formatNs(hottest.totalNs)}（占内核总时长 ${formatPct(hottest.totalNs / facts.kernelTotalNs)}、占会话窗口 ${formatPct(hottest.totalNs / windowNs)}）`,
        `单次：平均 ${formatNs(hottest.avgNs)}，中位 ${formatNs(hottest.p50Ns)}${hottest.p50Sampled ? "（抽样估计）" : ""}，最小 ${formatNs(hottest.minNs)}，最大 ${formatNs(hottest.maxNs)}`,
        `网格 ${hottest.grid.join("×")}，块 ${hottest.block.join("×")}，每线程寄存器 ${hottest.registersPerThread}，共享内存 ${formatBytes(hottest.smemBytes)}`,
        `符号：${shortSymbol(hottest.name, 120)}`,
      ],
      cause: "总耗时被单个内核主导——优化它的收益上限最高，其余内核不是当前瓶颈。",
      suggestion:
        "先对该内核做 Nsight Compute 详查（nsight_capture kind=ncu 重新采集，或对已有 .ncu-rep 用 nsight_kernel_detail）判断带宽受限还是延迟受限；再针对性调整：访存模式（合并访问、向量化、共享内存分块）、占用率（寄存器/共享内存削减、块大小）、算法层面削减冗余计算。",
      symbols: kernelSymbols([hottest]),
      reclaimableNs: hottest.totalNs,
    })
  }

  // ---- 规则 4：启动开销受限（大量小内核） ----
  const totalInstances = facts.kernelInstances
  if (facts.smallKernelInstances >= FINDING_THRESHOLDS.smallKernelCount && totalInstances > 0) {
    const avgGap = facts.launchGaps.length ? facts.launchGaps.reduce((s, g) => s + g.gapNs, 0) / facts.launchGaps.length : 0
    findings.push({
      id: "launch-bound",
      severity: facts.smallKernelInstances / totalInstances > 0.7 ? "high" : "medium",
      title: `小内核过多：${facts.smallKernelInstances} 次调用耗时低于 ${formatNs(FINDING_THRESHOLDS.smallKernelNs)}（占全部调用 ${formatPct(facts.smallKernelInstances / totalInstances)}）`,
      evidence: [
        ...facts.smallKernelGroups
          .slice(0, 5)
          .map((k) => `${shortSymbol(k.name, 56)}：${k.instances} 次，平均 ${formatNs(k.avgNs)}，合计 ${formatNs(k.totalNs)}`),
        `小内核总耗时 ${formatNs(facts.smallKernelTotalNs)}`,
        ...facts.launchGaps.slice(0, 3).map((g) => `同流启动间隔 ${formatNs(g.gapNs)}：${shortSymbol(g.from, 40)} → ${shortSymbol(g.to, 40)}（流 ${g.streamId}）`),
        avgGap > 0 ? `同流相邻内核平均间隔 ${formatNs(avgGap)}（含主机侧启动开销）` : "",
      ].filter(Boolean),
      cause:
        "单次内核工作量太小，时间花在启动与调度上；这类负载对启动延迟敏感，而启动开销无法被硬件隐藏。",
      suggestion:
        "算子融合（多次小内核合并为一次）、批量化（增大单次工作量）、对固定 shape 的重复序列用 CUDA Graph 捕获（推理/迭代循环收益明显）。",
      symbols: kernelSymbols(facts.kernels.filter((k) => k.avgNs < FINDING_THRESHOLDS.smallKernelNs).slice(0, 8)),
      reclaimableNs: facts.smallKernelTotalNs,
    })
  }

  // ---- 规则 5：网格规模不足 ----
  if (facts.undersizedGroups.length) {
    const top = facts.undersizedGroups[0]!
    findings.push({
      id: "grid-undersized",
      severity: top.totalNs / Math.max(facts.kernelTotalNs, 1) > 0.3 ? "high" : "medium",
      title: `网格线程总数偏小，设备并行度未填满（${facts.undersizedGroups.length} 个内核）`,
      evidence: facts.undersizedGroups
        .slice(0, 5)
        .map(
          (k) =>
            `${shortSymbol(k.name, 56)}：网格 ${k.grid.join("×")}，块 ${k.block.join("×")} → 单次共 ${k.totalThreads.toLocaleString("en-US")} 线程，合计耗时 ${formatNs(k.totalNs)}`,
        ),
      cause:
        "单次启动的线程总数低于设备可驻留规模（现代 GPU 单卡十万级），SM 无法填满，内核提前结束而部分算力闲置。",
      suggestion:
        "提高网格规模（更细划分、每线程处理更少元素）；问题规模受限时改用持久化内核 + 网格步长循环，或块内并行/向量化提高单线程效率。",
      symbols: facts.undersizedGroups.slice(0, 5).map((k) => ({ kind: "kernel" as const, value: k.name, weightNs: k.totalNs })),
      reclaimableNs: facts.undersizedGroups.reduce((s, k) => s + k.totalNs, 0),
    })
  }

  // ---- 规则 6：传输效率 ----
  const transferShare = facts.memcpyTotalNs / windowNs
  const smallPackets = facts.memcpyKinds.filter((k) => k.avgBytes > 0 && k.avgBytes < FINDING_THRESHOLDS.minTransferBytes && k.count >= 3)
  if (facts.memcpyCount > 0 && (transferShare > FINDING_THRESHOLDS.transferShare || smallPackets.length)) {
    const hostKinds = facts.memcpyKinds.filter((k) => /Host-to-Device|Device-to-Host/.test(k.kind))
    findings.push({
      id: "transfer-inefficient",
      severity: transferShare > 0.35 ? "high" : "medium",
      title:
        smallPackets.length > 0
          ? `显存传输包偏小（平均低于 ${formatBytes(FINDING_THRESHOLDS.minTransferBytes)}），传输占会话 ${formatPct(transferShare)}`
          : `显存传输占用会话的 ${formatPct(transferShare)}`,
      evidence: [
        ...facts.memcpyKinds.map((k) => `${k.kind}：${k.count} 次，合计 ${formatNs(k.totalNs)}，平均每次 ${formatBytes(k.avgBytes)}`),
        `传输字节 ${formatBytes(facts.memcpyBytes)}，平均有效带宽 ${formatBytes(facts.memcpyTotalNs > 0 ? facts.memcpyBytes / (facts.memcpyTotalNs / 1e9) : 0)}/s`,
        ...facts.memcpySlowest.slice(0, 3).map((s) => `最慢单次：${s.kind} ${formatBytes(s.bytes)} 用 ${formatNs(s.durNs)}`),
      ],
      cause:
        "主机↔设备传输是同步路径上的串行环节；包越小、调用越频繁，固定开销占比越高，且传输期间计算无法推进（未重叠）。",
      suggestion:
        "合并小拷贝为大批次；使用页锁定内存（cudaHostAlloc/cudaMallocHost）提高拷贝带宽；传输放独立流与计算重叠（cudaMemcpyAsync）；能在设备端生成的数据避免往返主机。",
      symbols: hostKinds.map((k) => ({ kind: "api" as const, value: k.kind, weightNs: k.totalNs })),
      reclaimableNs: facts.memcpyTotalNs,
    })
  }

  // ---- 规则 7：无并发（串行执行） ----
  if (facts.kernelInstances > 2 && facts.streams.length <= 1) {
    findings.push({
      id: "no-concurrency",
      severity: "low",
      title: "全部工作串行在单流上执行，无计算/传输重叠",
      evidence: [
        `报告中仅 ${facts.streams.length} 个流（${facts.streams.map((s) => `#${s.streamId}`).join("、")}），最大并发内核数 ${facts.maxConcurrent}`,
        `内核总时长 ${formatNs(facts.kernelTotalNs)}，显存传输 ${formatNs(facts.memcpyTotalNs)}，会话窗口 ${formatNs(facts.windowNs)}`,
        `内核时间占会话 ${formatPct(kernelShareOfWindow)}`,
      ],
      cause:
        "默认流上的操作严格串行：内核之间、内核与拷贝之间都无法重叠；存在可并行工作时会线性放大总时长。",
      suggestion:
        "为独立工作流分配不同 cudaStream，使计算与传输、多个内核并行；用事件表达必要依赖而不阻断主机线程。",
      symbols: kernelSymbols(facts.kernels.slice(0, 3)),
      reclaimableNs: 0,
    })
  }

  // ---- 规则 8：寄存器/共享内存占用压力 ----
  if (facts.pressuredGroups.length) {
    findings.push({
      id: "occupancy-pressure",
      severity: "medium",
      title: `寄存器/共享内存占用偏高，可能限制驻留块数（${facts.pressuredGroups.length} 个内核）`,
      evidence: facts.pressuredGroups
        .slice(0, 5)
        .map(
          (k) =>
            `${shortSymbol(k.name, 56)}：每线程 ${k.registersPerThread} 寄存器、每块共享内存 ${formatBytes(k.smemBytes)}、块 ${k.block.join("×")}，合计耗时 ${formatNs(k.totalNs)}`,
        ),
      cause:
        "每线程寄存器数与每块共享内存共同决定 SM 上可驻留的块数；超过阈值时占用率下降、延迟隐藏能力变弱（是否真受限需 ncu 的占用率与 stall 分析确认）。",
      suggestion:
        "用 nsight_kernel_detail 查看该内核的 Occupancy/Stall 分布确认受限因素：寄存器压力用 __launch_bounds__ / maxrregcount 限制或拆分内核；共享内存压力减小分块尺寸或降低存储精度。",
      symbols: facts.pressuredGroups.slice(0, 5).map((k) => ({ kind: "kernel" as const, value: k.name, weightNs: k.totalNs })),
      reclaimableNs: 0,
    })
  }

  // ---- 信息项：会话与设备 ----
  findings.push({
    id: "session-info",
    severity: "info",
    title: devices.length ? `采集会话：${devices.map((d) => d.name ?? `GPU ${d.gpuId}`).join("、")}` : "采集会话信息",
    evidence: [
      `会话开始 ${facts.sessionStartUtc || "未知"}，活动窗口 ${formatNs(facts.windowNs)}`,
      ...devices.map((d) => `GPU ${d.gpuId}（计算能力 ${d.computeCap ?? "未知"}），进程 ${d.pid}`),
      `NVTX 区间 ${nvtx.count} 个${nvtx.available ? "" : "（未采集）"}`,
    ],
    cause: "会话元信息，用于确认分析对象与上下文（非问题项）。",
    suggestion: "如需按阶段归因，在目标程序加入 NVTX 区间（关键阶段/迭代），报告即可按阶段聚合耗时。",
    symbols: nvtx.top.slice(0, 5).map((n) => ({ kind: "nvtx" as const, value: n.text, weightNs: n.totalNs })),
    reclaimableNs: 0,
  })

  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.reclaimableNs - a.reclaimableNs)
  return { findings, metrics, skipped }
}
