/**
 * torch 分析的原生后端接线（原生优先、自动回退 JS）。
 *
 * 为什么需要原生：宿主 JS 路径在**真实 torch 输出格式**（平均 350 字节/事件，带缩进的
 * args.Input Dims/Input Strides 等嵌套字段）下实测约 32 MB/s——瓶颈有二：① 流式扫描把
 * 逐块内容拼进同一个缓冲（累积到 1MB 才压缩），导致每次逐字符访问都在处理拼接串
 * （实测：同一段循环跑在扁平整串上 389 ms，跑在流式缓冲上 1327 ms）；② 字段提取用
 * `text[j]` 单字符字符串索引扫完整个 args。
 *
 * 原生实现（`keqing/rust/torch`，客卿 Rust 边车）整文件读入内存（GB 级内存可接受——这是
 * 明确取舍）、字节级扫描，不经过 JS 层。与 nsight 的原生后端同款设计：
 * - 边车未构建/未装载（服务端部署下客卿整体禁用）或调用出错 → **自动回退 JS 实现**，回退原因如实回报；
 * - 原生返回值经 `coerceNativeFacts` **严格校验**，字段缺失/类型不符即抛错回退——绝不让脏数据进入分析；
 * - `TORCH_NATIVE=off` 可显式固定走 JS 路径。
 */
import type { ToolContext } from "@gebai/sdk"
import { aggregateTorchTrace, type TorchFacts } from "./torch-trace"
import { withTiming } from "../../core/perf/timing"

/** 原生聚合后端工具名（客卿边车，同 torch 子Agent 命名空间下）。 */
export const NATIVE_AGGREGATE_TOOL = "torch_aggregate"

export interface ResolvedTorchFacts {
  facts: TorchFacts
  /** 事实来源（供工具如实呈现「原生聚合」/「JS 聚合」）。 */
  source: "native" | "js"
  elapsedMs: number
  /** 原生路径失败时的原因（source=js 且曾尝试原生时给出）。 */
  nativeError?: string
}

/**
 * 取 trace 事实：原生优先、失败自动回退 JS。
 *
 * budgetMs 只作用于 JS 回退路径——原生整文件读入不设时间预算（实测吞吐高且无流式中止点），
 * 因此原生可用时不会出现「未完成」；原生不可用时行为与改造前完全一致（预算 + 后台衔接照旧）。
 */
export async function resolveTorchFacts(
  ctx: ToolContext,
  path: string,
  opts: { budgetMs?: number; onProgress?: (stats: unknown) => void } = {},
): Promise<ResolvedTorchFacts> {
  let nativeError: string | undefined
  if (ctx.env?.TORCH_NATIVE !== "off") {
    try {
      const native = await callNativeAggregate(ctx, path)
      return { facts: native.facts, source: "native", elapsedMs: native.elapsedMs }
    } catch (e) {
      nativeError = e instanceof Error ? e.message : String(e)
    }
  }
  const t0 = withTiming()
  const facts = await aggregateTorchTrace(path, {
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress as never } : {}),
  })
  return { facts, source: "js", elapsedMs: t0(), ...(nativeError ? { nativeError } : {}) }
}

/** 调用原生聚合边车（未装载/未构建/报错即抛错，由上层回退）。 */
async function callNativeAggregate(ctx: ToolContext, path: string): Promise<{ facts: TorchFacts; elapsedMs: number }> {
  const resolved = ctx.registry?.resolve(NATIVE_AGGREGATE_TOOL)
  if (!resolved) throw new Error(`原生边车未注册（${NATIVE_AGGREGATE_TOOL}）——未构建或当前形态下不可用`)
  const result = await resolved.tool.execute({ path }, ctx)
  const data = result.data as Record<string, unknown> | undefined
  if (!data) throw new Error("原生边车未返回结构化聚合结果")
  return { facts: coerceNativeFacts(data), elapsedMs: Number(data.elapsedMs ?? data.scanMs ?? 0) }
}

/**
 * 校验并收窄原生返回的聚合结果（字段缺失/类型不符即抛错 → 上层回退 JS）。
 *
 * 覆盖工具层实际消费的全部字段：宁可回退也不能让半份事实进入诊断（诊断会据此给出
 * 「没问题」的结论，比慢更危险）。
 */
export function coerceNativeFacts(data: Record<string, unknown>): TorchFacts {
  const obj = (key: string): Record<string, unknown> => {
    const v = data[key]
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`原生聚合结果缺对象字段：${key}`)
    return v as Record<string, unknown>
  }
  const arr = (key: string): unknown[] => {
    const v = data[key]
    if (!Array.isArray(v)) throw new Error(`原生聚合结果缺数组字段：${key}`)
    return v
  }
  const num = (key: string): number => {
    const v = data[key]
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`原生聚合结果缺数值字段：${key}`)
    return v
  }
  const bool = (key: string): boolean => {
    const v = data[key]
    if (typeof v !== "boolean") throw new Error(`原生聚合结果缺布尔字段：${key}`)
    return v
  }

  const scale = obj("scale")
  num("scanMs")
  if (typeof scale.events !== "number") throw new Error("原生聚合结果缺字段：scale.events")
  if (typeof scale.scannedChars !== "number") throw new Error("原生聚合结果缺字段：scale.scannedChars")
  if (!scale.byCategory || typeof scale.byCategory !== "object") throw new Error("原生聚合结果缺字段：scale.byCategory")
  if (!Array.isArray(scale.processes)) throw new Error("原生聚合结果缺字段：scale.processes")
  if (typeof scale.threads !== "number") throw new Error("原生聚合结果缺字段：scale.threads")
  if (!scale.flags || typeof scale.flags !== "object") throw new Error("原生聚合结果缺字段：scale.flags")

  bool("hasGpuEvents")
  bool("hasMemoryEvents")
  arr("steps")
  arr("categories")
  arr("ops")
  arr("kernels")
  arr("cudaApis")
  arr("annotations")
  num("opGroups")
  num("kernelGroups")
  arr("transfers")
  num("transferCount")
  num("transferBytes")
  arr("pythonSites")
  arr("kernelAttribution")
  arr("notes")
  obj("memory")
  obj("timeline")
  obj("fwdBwd")
  obj("flows")

  const stepStats = obj("stepStats")
  for (const k of ["count", "avgUs", "medianUs", "p90Us", "minUs", "maxUs"]) {
    if (typeof stepStats[k] !== "number") throw new Error(`原生聚合结果缺字段：stepStats.${k}`)
  }

  // 诊断规则依赖这些数值（缺失会让诊断静默漏判）
  const memory = data.memory as Record<string, unknown>
  for (const k of ["available", "events", "allocCount", "freeCount", "peakAllocatedBytes", "peakReservedBytes"]) {
    if (k === "available" ? typeof memory[k] !== "boolean" : typeof memory[k] !== "number") {
      throw new Error(`原生聚合结果缺字段：memory.${k}`)
    }
  }
  const timeline = data.timeline as Record<string, unknown>
  for (const k of ["spanUs", "cpuBusyUs", "cpuUtilization", "gpuBusyUs", "gpuUtilization", "gpuGapCount", "gpuGapTotalUs", "overlapUs"]) {
    if (typeof timeline[k] !== "number") throw new Error(`原生聚合结果缺字段：timeline.${k}`)
  }
  for (const k of ["gpuGaps", "cpuSeries", "gpuSeries"]) {
    if (!Array.isArray(timeline[k])) throw new Error(`原生聚合结果缺字段：timeline.${k}`)
  }
  const fwdBwd = data.fwdBwd as Record<string, unknown>
  if (typeof fwdBwd.available !== "boolean") throw new Error("原生聚合结果缺字段：fwdBwd.available")
  for (const k of ["marks", "linked", "forwardUs", "backwardUs", "backwardShare"]) {
    if (typeof fwdBwd[k] !== "number") throw new Error(`原生聚合结果缺字段：fwdBwd.${k}`)
  }
  if (!Array.isArray(fwdBwd.perStep) || !Array.isArray(fwdBwd.samples)) throw new Error("原生聚合结果缺字段：fwdBwd.perStep/samples")
  const flows = data.flows as Record<string, unknown>
  if (typeof flows.available !== "boolean") throw new Error("原生聚合结果缺字段：flows.available")
  for (const k of ["pairs", "kernelLinks"]) {
    if (typeof flows[k] !== "number") throw new Error(`原生聚合结果缺字段：flows.${k}`)
  }

  return data as unknown as TorchFacts
}
