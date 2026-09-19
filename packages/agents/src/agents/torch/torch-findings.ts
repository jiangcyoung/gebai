/**
 * PyTorch Profiler trace 的诊断规则引擎。
 *
 * 与 nsys 侧同一纪律：**每条结论都带 trace 中的实测值**，并按「可回收时间」排序；
 * 阈值集中在 `TORCH_THRESHOLDS`，测试直接断言这些常量以防文档与实现漂移。
 *
 * 规则按 trace 具备的维度自动裁剪：无 GPU 事件时不做内核级判定（如实说明缺什么、怎么补），
 * 只做 CPU/算子/内存维度的判定——不把「未采集」当成「没问题」。
 */
import type { TorchFacts, TorchOpStat, TorchPythonSite } from "./torch-trace"
import { MIN_KERNELS_FOR_LAUNCH_BOUND, SMALL_KERNEL_US, TINY_OP_US } from "./torch-trace"
import { formatBytes } from "../../core/perf/format"

/** 判定阈值（集中定义；测试锁定）。 */
export const TORCH_THRESHOLDS = {
  /** GPU 利用率低于此值且空闲缝中有 CPU 忙碌 → CPU 受限。 */
  gpuIdleUtilization: 0.5,
  /** 同步等待（.item()/同步 API）自身耗时占窗口比例上限。 */
  syncShare: 0.02,
  /** `.item()` 类同步算子调用次数上限（每步）。 */
  syncOpsPerStep: 1,
  /** python_function 自身耗时占窗口比例上限。 */
  pythonShare: 0.3,
  /** 微小算子（自身耗时 < TINY_OP_US）的次数占比上限。 */
  tinyOpCountShare: 0.5,
  /** autograd 引擎自身耗时占窗口比例上限。 */
  autogradShare: 0.15,
  /** 小内核（< SMALL_KERNEL_US）次数占比上限。 */
  smallKernelShare: 0.5,
  /** 单个内核占内核总耗时比例上限。 */
  topKernelShare: 0.5,
  /** 碎片化比率（峰值保留/峰值分配）上限。 */
  fragmentation: 1.5,
  /** 步时最大/中位比上限（步间抖动）。 */
  stepJitter: 1.5,
  /** 反向算子耗时占（前向 + 反向）比例上限：超过即提示反向偏重。 */
  backwardShare: 0.6,
  /** 传输平均包大小下限（字节）：低于此值提示合并小传输。 */
  smallTransferBytes: 1 << 20,
  /** 用户代码自身耗时占比下限：低于此值提示热点在框架内部。 */
  userCodeShare: 0.2,
} as const

export interface TorchFinding {
  id: string
  severity: "critical" | "high" | "medium" | "low" | "info"
  title: string
  evidence: string[]
  cause: string
  suggestion: string
  /** 可回收时间上限（微秒；定性问题为 0）。 */
  reclaimableUs: number
  /** 关联符号（算子/内核名），可交给 locate 定位。 */
  symbols: string[]
  /** 关联的 Python 位置（trace 自带 `文件(行)`，可直接落到源码）。 */
  sites: TorchPythonSite[]
}

/** CPython 标准库模块（无路径前缀的帧名，如 `inspect.py`）——不是用户工程代码，热点榜应排除。 */
const STDLIB_MODULES = new Set([
  "abc.py",
  "argparse.py",
  "contextlib.py",
  "enum.py",
  "functools.py",
  "importlib",
  "inspect.py",
  "linecache.py",
  "logging",
  "os.py",
  "threading.py",
  "traceback.py",
  "typing.py",
  "warnings.py",
])

/** 是否为用户代码位置（排除框架/标准库，用于把「热点在哪」指向用户自己的文件）。 */
export function isUserCode(file: string): boolean {
  const p = file.replace(/\\/g, "/")
  if (p.startsWith("torch/") || p.includes("/torch/")) return false
  if (p.includes("site-packages") || p.includes("dist-packages")) return false
  if (/^lib\/python|^\.\.\/|^<.*>$/.test(p)) return false
  if (p.startsWith("python")) return false
  // 无路径前缀的标准库帧（`inspect.py`、`functools.py` 等）
  const base = p.split("/").pop() ?? p
  if (!p.includes("/") && STDLIB_MODULES.has(base)) return false
  for (const mod of STDLIB_MODULES) {
    if (p === mod || p.startsWith(`${mod}/`)) return false
  }
  return true
}

const us = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} ms` : `${v.toFixed(1)} µs`)
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** 汇总用户的 python 热点（供诊断与定位共用）。 */
export function userSites(facts: TorchFacts, limit = 8): TorchPythonSite[] {
  return facts.pythonSites.filter((s) => isUserCode(s.file)).slice(0, limit)
}

/** 按名称前缀查找算子分组（返回自身耗时最大的那个）。 */
function findOp(ops: TorchOpStat[], re: RegExp): TorchOpStat | undefined {
  return ops.filter((o) => re.test(o.name)).sort((a, b) => b.selfUs - a.selfUs)[0]
}

function sumMatching(ops: TorchOpStat[], re: RegExp): { count: number; selfUs: number; totalUs: number; names: string[] } {
  const hits = ops.filter((o) => re.test(o.name))
  return {
    count: hits.reduce((s, o) => s + o.count, 0),
    selfUs: hits.reduce((s, o) => s + o.selfUs, 0),
    totalUs: hits.reduce((s, o) => s + o.totalUs, 0),
    names: hits.map((o) => o.name),
  }
}

/**
 * 生成 PyTorch trace 的问题清单（按严重度与可回收时间排序）。
 */
export function diagnoseTorch(facts: TorchFacts): { findings: TorchFinding[]; skipped: string[] } {
  const findings: TorchFinding[] = []
  const skipped: string[] = []
  const span = facts.timeline.spanUs
  const steps = facts.stepStats.count
  const sites = userSites(facts)
  const userSelfUs = sites.reduce((s, v) => s + v.selfUs, 0)

  // —— 前向/反向拆分（trace 的 cat:"fwdbwd" 流事件：前向 ATen 算子与其反向算子的成对关联）——
  const fb = facts.fwdBwd
  if (fb.available && (fb.forwardUs > 0 || fb.backwardUs > 0)) {
    if (fb.backwardShare > TORCH_THRESHOLDS.backwardShare) {
      findings.push({
        id: "backward-share",
        severity: "medium",
        title: `反向占比偏高：${pct(fb.backwardShare)}（前向算子合计 ${us(fb.forwardUs)}，对应反向算子合计 ${us(fb.backwardUs)}）`,
        evidence: [
          `配对标记 ${fb.marks} 对（可用 ${fb.linked} 对）｜前向均值 ${us(fb.avgForwardUs)}，反向均值 ${us(fb.avgBackwardUs)}`,
          fb.perStep.length ? `逐步（前向/反向）：${fb.perStep.map((p) => `${p.step} ${us(p.forwardUs)}/${us(p.backwardUs)}`).join("，")}` : "",
          ...fb.samples.slice(0, 3).map((s) => `${s.forward} ${us(s.forwardUs)} → ${s.backward} ${us(s.backwardUs)}`),
        ].filter(Boolean),
        cause:
          "前向/反向标记只跟随带反向节点的算子：比例偏高意味着这些算子的反向调用与注册开销超过了它们的前向（反向图节点多、梯度存储/拷贝重或反向内核效率低）。",
        suggestion:
          "逐对看上面的样本：优先查反向耗时远大于前向的那几个算子（梯度存储布局/dtype 与反向内核不匹配、不必要的中间变量）；训练可用 bf16/amp 降低反向访存压力；确认没有重复的反向计算（torch.utils.checkpoint 反而会增加反向计算量）。",
        reclaimableUs: 0,
        symbols: fb.samples.slice(0, 4).map((s) => s.backward),
        sites,
      })
    }
  } else if (!fb.available) {
    skipped.push(fb.marks > 0 ? "前向/反向拆分——有 fwdbwd 流事件但未跟随到算子活动" : "前向/反向拆分——trace 无 fwdbwd 流事件（torch.profiler 的 forward/backward 关联标记）")
  }

  // —— GPU 维度缺失：如实说明（不是「没问题」）——
  if (!facts.hasGpuEvents) {
    findings.push({
      id: "no-gpu-events",
      severity: "info",
      title: "trace 中没有 GPU 事件，无法判定内核级问题",
      evidence: [`事件类别：${Object.entries(facts.scale.byCategory).map(([k, v]) => `${k}=${v}`).join("、")}`],
      cause:
        "Windows 上 PyTorch 的 CUPTI 采集不可用（实测显式启用 `ProfilerActivity.CUDA` 仍无任何 kernel 事件）；或采集时只启用了 CPU activity。",
      suggestion:
        "GPU 侧时间线用 `nsight_capture kind=nsys` 采集（Nsight Systems 在 Windows 可用，且本会话已支持其分析）；在 Linux 上用 activities=[ProfilerActivity.CUDA] 重新采集可得到内核/传输事件。",
      reclaimableUs: 0,
      symbols: [],
      sites: [],
    })
    skipped.push("内核级判定（启动开销/内核集中度/占用率/网格并行度）——无 kernel 事件")
    skipped.push("显存传输重叠与流并行度——无 gpu_memcpy/gpu_memset 事件")
  }

  // —— 同步与主机往返 ——
  const syncOps = sumMatching(facts.ops, /^aten::(_local_scalar_dense|item|_numpy|numpy)$/)
  const hostCopies = sumMatching(facts.ops, /^aten::(to|_to_copy)$/)
  const syncApis = sumMatching(facts.cudaApis, /^(cudaStreamSynchronize|cudaDeviceSynchronize|cudaMemcpy)/i)
  const syncSelfUs = syncOps.selfUs + syncApis.selfUs
  const syncPerStep = steps > 0 ? syncOps.count / steps : syncOps.count
  if (syncOps.count > 0 && (syncPerStep > TORCH_THRESHOLDS.syncOpsPerStep || syncSelfUs / Math.max(1, span) > TORCH_THRESHOLDS.syncShare)) {
    const itemOp = findOp(facts.ops, /^aten::_local_scalar_dense$/)
    findings.push({
      id: "sync-per-step",
      severity: "high",
      title: `逐步强制同步：每步 ${syncPerStep.toFixed(1)} 次标量取值，自身耗时 ${us(syncSelfUs)}`,
      evidence: [
        `同步类算子 ${syncOps.count} 次（${syncOps.names.slice(0, 4).join("、")}），自身耗时合计 ${us(syncOps.selfUs)}`,
        itemOp ? `aten::_local_scalar_dense（等价于 `.concat("`.item()`") + `）：${itemOp.count} 次，自身 ${us(itemOp.selfUs)}，p50 ${us(itemOp.p50Us)}` : `未出现 aten::_local_scalar_dense`,
        steps > 0 ? `步数 ${steps}（ProfilerStep 标注）` : "无 ProfilerStep 标注，按总次数评估",
        syncApis.count > 0 ? `同步 CUDA API ${syncApis.count} 次，自身 ${us(syncApis.selfUs)}` : "无同步 CUDA API 记录",
      ],
      cause:
        "`.item()` / `float(tensor)` / `.cpu()` 等操作会强制等待设备完成并同步主机，形成「提交—等待—再提交」的串行循环，设备在等待期间完全空闲。",
      suggestion:
        "把标量取值移出训练步（累加到 GPU 张量上，每 N 步或训练结束后取一次）；日志/指标用 detach() 暂存到 GPU 列表再批量汇总；确需逐步读取时用非阻塞拷贝（tensor.to('cpu', non_blocking=True) + 页锁定内存）并延后同步。",
      reclaimableUs: syncSelfUs,
      symbols: syncOps.names,
      sites,
    })
  }

  // —— 主机往返（小块拷贝）——
  if (hostCopies.count > 0 || facts.transferCount > 0) {
    const dtoh = facts.transfers.find((t) => /DtoH/i.test(t.kind))
    const smallPackets = facts.transfers.filter((t) => t.count > 0 && t.avgBytes < TORCH_THRESHOLDS.smallTransferBytes)
    if (dtoh && dtoh.avgBytes < TORCH_THRESHOLDS.smallTransferBytes) {
      findings.push({
        id: "host-roundtrip",
        severity: "medium",
        title: `主机往返拷贝包偏小：Device→Host 平均 ${formatBytes(dtoh.avgBytes)}`,
        evidence: [
          `Device→Host：${dtoh.count} 次，合计 ${formatBytes(dtoh.bytes)}，平均 ${formatBytes(dtoh.avgBytes)}`,
          hostCopies.count > 0 ? `设备迁移算子 ${hostCopies.count} 次（${hostCopies.names.slice(0, 3).join("、")}），自身 ${us(hostCopies.selfUs)}` : "",
          smallPackets.length ? `平均包小于 1 MB 的方向：${smallPackets.map((t) => t.kind).join("、")}` : "",
        ].filter(Boolean),
        cause: "小包传输的固定开销占比高，且同步路径上传输期间计算无法推进。",
        suggestion: "合并小拷贝为大批次；改用页锁定内存与异步拷贝（non_blocking=True）并放到独立流；能在设备端生成的数据不要往返主机。",
        reclaimableUs: dtoh.totalUs,
        symbols: hostCopies.names,
        sites,
      })
    }
  }

  // —— CPU 受限（需要 GPU 事件才能量化「等 CPU」）——
  if (facts.hasGpuEvents && facts.timeline.gpuUtilization < TORCH_THRESHOLDS.gpuIdleUtilization) {
    const gpuIdle = Math.max(0, span - facts.timeline.gpuBusyUs)
    const cpuBusyInGaps = facts.timeline.gpuGaps.reduce((s, g) => s + Math.min(g.cpuBusyUs, g.durUs), 0)
    findings.push({
      id: "cpu-bound",
      severity: "critical",
      title: `GPU 利用率仅 ${pct(facts.timeline.gpuUtilization)}，空闲 ${us(gpuIdle)}——CPU 侧成为瓶颈`,
      evidence: [
        `窗口 ${us(span)}，GPU 忙碌 ${us(facts.timeline.gpuBusyUs)}（${pct(facts.timeline.gpuUtilization)}），空闲 ${us(gpuIdle)}`,
        `空闲缝 ${facts.timeline.gpuGapCount} 段，其中 CPU 仍在忙 ${us(cpuBusyInGaps)}（${pct(cpuBusyInGaps / Math.max(1, gpuIdle))} 的空闲时间 CPU 并未闲着）`,
        ...facts.timeline.gpuGaps.slice(0, 3).map((g) => `空闲缝 ${us(g.durUs)}：其中 CPU 忙碌 ${us(g.cpuBusyUs)}`),
        `CPU 侧忙碌 ${us(facts.timeline.cpuBusyUs)}（${pct(facts.timeline.cpuUtilization)}）`,
      ],
      cause: "GPU 在等主机侧提交工作（Python/算子调度、同步、数据准备），设备算力未被利用。",
      suggestion:
        "减少每步的 Python 与算子调度开销（融合算子、增大 batch、torch.compile）；用多流/预取重叠数据加载；检查是否有逐步同步点（见同步规则）。",
      reclaimableUs: gpuIdle,
      symbols: facts.kernels.slice(0, 3).map((k) => k.name),
      sites,
    })
  }

  // —— Python 侧开销 ——
  const pythonCat = facts.categories.find((c) => c.cat === "python_function")
  if (pythonCat && span > 0 && pythonCat.selfUs / span > TORCH_THRESHOLDS.pythonShare) {
    findings.push({
      id: "python-overhead",
      severity: facts.hasGpuEvents ? "high" : "medium",
      title: `Python 侧自身耗时占窗口 ${pct(pythonCat.selfUs / span)}`,
      evidence: [
        `python_function 自身耗时 ${us(pythonCat.selfUs)}（窗口 ${us(span)}）`,
        `用户代码热点：${sites.slice(0, 4).map((s) => `${s.location} ${s.func}（自身 ${us(s.selfUs)}）`).join("；") || "(无用户代码帧)"}`,
      ],
      cause: "Python 解释执行与逐算子调度构成固定开销；小算子越多、步越小，占比越高。",
      suggestion: "提高单步计算量（增大 batch）；用 torch.compile/脚本化减少 Python 调度；把 Python 侧的逐元素循环改成张量运算。",
      reclaimableUs: Math.max(0, pythonCat.selfUs - userSelfUs),
      symbols: [],
      sites,
    })
  }

  // —— 算子碎片化（小算子过多）——
  const tinyOps = facts.ops.filter((o) => o.p50Us < TINY_OP_US || o.totalUs / Math.max(1, o.count) < TINY_OP_US)
  const opTotalCount = facts.ops.reduce((s, o) => s + o.count, 0)
  const tinyCount = tinyOps.reduce((s, o) => s + o.count, 0)
  if (opTotalCount > 50 && tinyCount / opTotalCount > TORCH_THRESHOLDS.tinyOpCountShare) {
    findings.push({
      id: "op-fragmentation",
      severity: "medium",
      title: `微小算子占比 ${pct(tinyCount / opTotalCount)}（${tinyCount}/${opTotalCount}）`,
      evidence: [
        `平均耗时低于 ${TINY_OP_US} µs 的算子：${tinyOps.slice(0, 5).map((o) => `${o.name}×${o.count}`).join("、")}`,
        `CPU 侧算子总调用 ${opTotalCount} 次，自身耗时合计 ${us(facts.ops.reduce((s, o) => s + o.selfUs, 0))}`,
      ],
      cause: "每个算子都有固定的调度/派发开销；大量微小算子时固定开销超过计算本身，并放大 Python 与启动开销。",
      suggestion: "算子融合（torch.compile / fused optimizer / 手写融合 kernel）；把逐元素链式操作合并；用 foreach/批量 API 替代逐张量循环。",
      reclaimableUs: tinyOps.reduce((s, o) => s + o.selfUs, 0),
      symbols: tinyOps.slice(0, 5).map((o) => o.name),
      sites,
    })
  }

  // —— autograd 引擎开销 ——
  const autograd = sumMatching(facts.ops, /^autograd::engine::evaluate_function:/)
  if (autograd.selfUs / Math.max(1, span) > TORCH_THRESHOLDS.autogradShare) {
    findings.push({
      id: "autograd-overhead",
      severity: "medium",
      title: `反向传播引擎自身耗时占窗口 ${pct(autograd.selfUs / span)}`,
      evidence: [
        `autograd::engine::evaluate_function:* 共 ${autograd.count} 次，自身 ${us(autograd.selfUs)}`,
        `涉及的节点：${autograd.names.slice(0, 4).join("、")}`,
      ],
      cause: "反向图节点越多、梯度越碎，autograd 引擎的调度与累加开销越高。",
      suggestion: "推理路径用 torch.no_grad()/inference_mode；训练中用 set_to_none=True 减少梯度清零开销；减少不必要的中间张量（原地操作、融合损失）。",
      reclaimableUs: autograd.selfUs,
      symbols: autograd.names,
      sites,
    })
  }

  // —— 内核级（GPU 事件存在时）——
  if (facts.hasGpuEvents) {
    const kernelCount = facts.kernels.reduce((s, k) => s + k.count, 0)
    const smallKernels = facts.kernels.filter((k) => k.totalUs / Math.max(1, k.count) < SMALL_KERNEL_US)
    const smallCount = smallKernels.reduce((s, k) => s + k.count, 0)
    if (kernelCount >= MIN_KERNELS_FOR_LAUNCH_BOUND && smallCount / kernelCount > TORCH_THRESHOLDS.smallKernelShare) {
      findings.push({
        id: "small-kernels",
        severity: "high",
        title: `小内核占比 ${pct(smallCount / kernelCount)}（${smallCount}/${kernelCount}），启动开销受限`,
        evidence: [
          `单次耗时低于 ${SMALL_KERNEL_US} µs 的内核：${smallKernels.slice(0, 5).map((k) => `${k.name.slice(0, 48)}×${k.count}`).join("、")}`,
          `内核总调用 ${kernelCount} 次，总耗时 ${us(facts.kernels.reduce((s, k) => s + k.totalUs, 0))}`,
        ],
        cause: "内核启动与调度开销（约数微秒量级）超过内核本身的计算时间，GPU 时间被启动间隔吞掉。",
        suggestion: "融合小算子；增大并行粒度（每线程处理更多元素）；用 CUDA Graph 捕获整段启动序列消除重复启动开销。",
        reclaimableUs: smallKernels.reduce((s, k) => s + k.totalUs, 0),
        symbols: smallKernels.slice(0, 5).map((k) => k.name),
        sites,
      })
    }

    const top = facts.kernels[0]
    const kernelTotal = facts.kernels.reduce((s, k) => s + k.totalUs, 0)
    if (top && kernelTotal > 0 && top.totalUs / kernelTotal > TORCH_THRESHOLDS.topKernelShare) {
      findings.push({
        id: "top-kernel",
        severity: "high",
        title: `单一内核占内核总耗时 ${pct(top.totalUs / kernelTotal)}`,
        evidence: [
          `${top.name}（截断显示）：${top.count} 次，合计 ${us(top.totalUs)}，p50 ${us(top.p50Us)}`,
          top.grid && top.block ? `网格 ${top.grid.join("×")}，块 ${top.block.join("×")}，寄存器 ${top.registers ?? "?"}，占用率 ${top.occupancy ?? "?"}%` : "",
          `所占流：${top.streams.join("、") || "(未记录)"}`,
        ].filter(Boolean),
        cause: "总耗时被单个内核主导，优化它的收益上限最高。",
        suggestion: "对该内核做 Nsight Compute 详查（先 nsys 采集再 ncu 定位）判断带宽/延迟受限；再调访存模式、占用率或算法。",
        reclaimableUs: top.totalUs,
        symbols: [top.name],
        sites,
      })
    }

    const pressured = facts.kernels.filter((k) => (k.occupancy !== undefined && k.occupancy < 25) || (k.registers !== undefined && k.registers > 128))
    if (pressured.length) {
      findings.push({
        id: "occupancy-pressure",
        severity: "medium",
        title: `${pressured.length} 个内核存在占用率/寄存器压力`,
        evidence: pressured.slice(0, 4).map((k) => `${k.name.slice(0, 48)}：占用率 ${k.occupancy ?? "?"}%，寄存器 ${k.registers ?? "?"}，块 ${k.block?.join("×") ?? "?"}`),
        cause: "寄存器或共享内存占用偏高会限制 SM 上可驻留的块数，降低延迟隐藏能力。",
        suggestion: "用 __launch_bounds__/maxrregcount 限制寄存器，或缩小分块尺寸、降低共享内存用量；随后用 ncu 的占用率与 stall 分布确认。",
        reclaimableUs: 0,
        symbols: pressured.slice(0, 4).map((k) => k.name),
        sites,
      })
    }
  } else {
    skipped.push("小内核/内核集中度/占用率判定——无 kernel 事件")
  }

  // —— 内存 ——
  if (facts.memory.available) {
    const m = facts.memory
    if (m.fragmentation > TORCH_THRESHOLDS.fragmentation) {
      findings.push({
        id: "memory-fragmentation",
        severity: "medium",
        title: `显存碎片化：峰值保留 ${formatBytes(m.peakReservedBytes)} 对峰值分配 ${formatBytes(m.peakAllocatedBytes)}（比率 ${m.fragmentation.toFixed(2)}）`,
        evidence: [
          `峰值已分配 ${formatBytes(m.peakAllocatedBytes)}（来源：${m.peakSource === "trace" ? "trace 的 Total Allocated" : m.peakSource === "live-set" ? "按地址推算的活跃集" : "无"}）`,
          `峰值保留 ${formatBytes(m.peakReservedBytes)}`,
          `分配 ${m.allocCount} 次 / 释放 ${m.freeCount} 次，累计分配 ${formatBytes(m.allocatedBytes)}`,
          m.largestAllocs.length ? `最大单次分配 ${formatBytes(m.largestAllocs[0]!.bytes)}` : "",
          m.addrTrackingTruncated ? "地址追踪超出上限，活跃集已降级为累计统计" : "",
        ].filter(Boolean),
        cause: "保留量远高于实际使用量：缓存分配器保留已释放的块以备复用，但也意味着可复用块尺寸与实际请求不匹配（尺寸多样或峰值波动大）。",
        suggestion:
          "统一张量形状/批量大小以减少尺寸种类；避免在步内创建长短不一的临时张量；必要时 torch.cuda.empty_cache() 释放保留块（会拖慢后续分配），或调整 PYTORCH_CUDA_ALLOC_CONF（max_split_size_mb）。",
        reclaimableUs: 0,
        symbols: [],
        sites,
      })
    }
    const churn = m.allocCount + m.freeCount
    if (churn > 0 && span > 0 && churn / Math.max(1, span) > 0.5) {
      findings.push({
        id: "memory-churn",
        severity: "low",
        title: `分配器事件密集：每毫秒 ${(churn / span).toFixed(2)} 次分配/释放`,
        evidence: [
          `分配 ${m.allocCount} 次、释放 ${m.freeCount} 次（窗口 ${us(span)}）`,
          `累计分配 ${formatBytes(m.allocatedBytes)}，净使用 ${formatBytes(m.allocatedBytes - m.freedBytes)}`,
        ],
        cause: "逐算子分配临时张量会让分配器频繁进出，热点路径上的分配/释放本身成为开销。",
        suggestion: "复用缓冲区（out= 参数、预分配张量）；用 inference_mode/no_grad 减少中间量；批量拼接小张量。",
        reclaimableUs: 0,
        symbols: [],
        sites,
      })
    }
  } else {
    skipped.push("显存分配分析——trace 无 `[memory]` 事件（需 profile_memory=True 重新采集）")
  }

  // —— 步时抖动 / 无步骤标注 ——
  if (steps >= 3) {
    const ratio = facts.stepStats.maxUs / Math.max(1, facts.stepStats.medianUs)
    if (ratio > TORCH_THRESHOLDS.stepJitter) {
      const first = facts.steps[0]
      findings.push({
        id: "step-jitter",
        severity: "medium",
        title: `步间耗时不均：最大 ${us(facts.stepStats.maxUs)} / 中位 ${us(facts.stepStats.medianUs)} = ${ratio.toFixed(2)}×`,
        evidence: [
          `各步耗时：${facts.steps.map((s) => `${s.name}=${us(s.durUs)}`).join("，")}`,
          first ? `首步 ${first.name} 耗时 ${us(first.durUs)}（通常含预热：算子选择、显存池扩张、cuDNN 基准测试）` : "",
          `中位 ${us(facts.stepStats.medianUs)}，p90 ${us(facts.stepStats.p90Us)}`,
        ].filter(Boolean),
        cause: "首个采集步包含一次性初始化；后续步骤的不均通常来自数据依赖的分支、动态形状或显存分配波动。",
        suggestion: "用 schedule(wait/warmup) 跳过预热步再统计稳态步时；对动态形状固定输入尺寸；检查数据加载是否与计算重叠。",
        reclaimableUs: Math.max(0, facts.stepStats.maxUs - facts.stepStats.medianUs),
        symbols: [],
        sites,
      })
    }
  } else if (steps === 0) {
    findings.push({
      id: "no-step-annotation",
      severity: "info",
      title: "trace 无 ProfilerStep 标注，缺少步级视图",
      evidence: [`user_annotation 事件：${facts.annotations.map((a) => a.name).slice(0, 5).join("、") || "(无)"}`],
      cause: "未使用 schedule(...) 或未在训练循环里调用 prof.step()。",
      suggestion: "改用 torch.profiler.schedule(wait=1, warmup=1, active=N) 并在每步调用 prof.step()，即可得到步级耗时与抖动分析。",
      reclaimableUs: 0,
      symbols: [],
      sites: [],
    })
  }

  // —— 精度/布局转换 ——
  const doubleOps = facts.ops.filter((o) => o.dtypeSamples.some((d) => /double|float64/i.test(d)))
  if (doubleOps.length) {
    findings.push({
      id: "float64-ops",
      severity: "medium",
      title: `${doubleOps.length} 类算子出现 float64 输入`,
      evidence: doubleOps.slice(0, 4).map((o) => `${o.name}：${o.count} 次，类型 ${o.dtypeSamples[0]}`),
      cause: "float64 在 GPU 上的吞吐通常远低于 float32（消费级卡尤甚），混入 double 常来自标量常量或 numpy 默认类型。",
      suggestion: "统一用 float32/bf16；标量常量用 Python 数值时注意匹配张量 dtype（tensor * 1.0 应写成 tensor * torch.tensor(1.0, dtype=tensor.dtype) 或直接标量）。",
      reclaimableUs: 0,
      symbols: doubleOps.slice(0, 4).map((o) => o.name),
      sites,
    })
  }
  const conversions = sumMatching(facts.ops, /^aten::(contiguous|clone|copy_|_copy_|type_as)$/)
  if (conversions.count > 0) {
    findings.push({
      id: "layout-conversions",
      severity: "low",
      title: `布局/拷贝类算子 ${conversions.count} 次（自身 ${us(conversions.selfUs)}）`,
      evidence: [
        `涉及算子：${conversions.names.slice(0, 5).join("、")}`,
        `合计自身耗时 ${us(conversions.selfUs)}，总耗时 ${us(conversions.totalUs)}`,
      ],
      cause: "非连续布局或 dtype 不一致会触发隐式拷贝，既耗时又额外占用显存。",
      suggestion: "统一张量布局（避免反复 transpose/contiguous）；在模型入口一次性转换 dtype；用 channels_last 匹配卷积算子的偏好。",
      reclaimableUs: conversions.selfUs,
      symbols: conversions.names.slice(0, 5),
      sites,
    })
  }

  // —— 用户代码热点（定位入口）——
  if (sites.length && span > 0 && userSelfUs / span > TORCH_THRESHOLDS.userCodeShare) {
    findings.push({
      id: "user-code-hotspot",
      severity: "medium",
      title: `用户代码自身耗时占窗口 ${pct(userSelfUs / span)}，热点在 ${sites[0]!.location}`,
      evidence: sites.slice(0, 5).map((s) => `${s.location} ${s.func}：自身 ${us(s.selfUs)}，总 ${us(s.totalUs)}，${s.count} 次`),
      cause: "trace 的 python_function 帧（with_stack=True）定位到用户代码的自身耗时——这是可直接修改的位置。",
      suggestion: "从该文件/函数入手：把其中的 Python 循环改为张量运算、减少逐算子调用、把同步取值移出循环。",
      reclaimableUs: userSelfUs,
      symbols: [],
      sites: sites.slice(0, 5),
    })
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.reclaimableUs - a.reclaimableUs)
  return { findings, skipped }
}
