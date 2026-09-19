/**
 * PyTorch Profiler trace 的输入层（torch 子Agent 专用）：类型识别与文件指纹。
 *
 * 只认 PyTorch Profiler（Kineto）导出的 Chrome Trace：`*.pt.trace.json`（PyTorch 默认导出名）、
 * `*.trace.json`、`*.json`，以及它们的 gzip 形态（`*.pt.trace.json.gz` —— TensorBoard 的
 * trace handler 默认压缩；`extname` 对 `.json.gz` 只取到 `.gz`，故按全名匹配）。
 * Nsight 报告属 `nsight` 子Agent，两个面互不依赖。
 */
import type { ToolContext } from "@gebai/sdk"
import { statFileRef, type FileRef } from "../../core/perf/input"

/** PyTorch Profiler trace 的文件引用（与共用 FileRef 同形，便于缓存键与展示统一）。 */
export type TraceRef = FileRef

const TRACE_RE = /\.(pt\.trace\.json|trace\.json|chrome\.trace\.json|json)(\.gz)?$/i

/** 是否为 PyTorch Profiler trace 的文件名形态。 */
export function isTorchTrace(path: string): boolean {
  return TRACE_RE.test(path)
}

/** 解析并校验 trace 路径（相对路径按工具上下文基准）。 */
export function statTrace(ctx: ToolContext, input: string): TraceRef {
  const ref = statFileRef(ctx, input, "trace")
  if (!isTorchTrace(ref.path)) {
    throw new Error(
      `这不是 PyTorch Profiler trace 的文件形态：${ref.path}\n` +
        `支持的导出形态：torch.profiler.profile(...).export_chrome_trace("*.pt.trace.json")，` +
        `或 TensorBoard 的 *.pt.trace.json.gz（可带 .gz）。` +
        `Nsight 报告（.nsys-rep/.ncu-rep）请用 nsight 子Agent。`,
    )
  }
  return ref
}
