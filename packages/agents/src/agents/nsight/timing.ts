/**
 * 计时助手（nsight 专用）：分析耗时与聚合来源如实回报——
 * 超大报告「首次扫描慢、后续秒回」、以及「原生聚合 / JS 回退」的差异必须可见，
 * 否则会被误判为能力不稳定。
 */
import type { ResolvedFacts } from "./nsys-analysis"

/** 启动计时，返回取耗时的函数（毫秒）。 */
export function withTiming(): () => number {
  const start = performance.now()
  return () => performance.now() - start
}

/** 耗时的人类可读文本（秒，两位小数）。 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** 聚合来源与耗时的单行说明（原生边车 / JS 回退；回退时附原因，不静默降级）。 */
export function aggregateNote(resolved: Pick<ResolvedFacts, "source" | "elapsedMs" | "nativeError">): string {
  if (resolved.source === "native") return `原生聚合 ${formatDurationMs(resolved.elapsedMs)}`
  const base = `JS 流式聚合 ${formatDurationMs(resolved.elapsedMs)}`
  return resolved.nativeError ? `${base}（原生后端不可用：${resolved.nativeError}）` : base
}
