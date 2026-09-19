/**
 * PyTorch Profiler trace 的输入层（torch 子Agent 专用）：类型识别与文件指纹。
 *
 * 只认 PyTorch Profiler（Kineto）导出的 Chrome Trace：`*.pt.trace.json`（PyTorch 默认导出名）、
 * `*.trace.json`、`*.json`，以及它们的 gzip 形态（`*.pt.trace.json.gz` —— TensorBoard 的
 * trace handler 默认压缩；`extname` 对 `.json.gz` 只取到 `.gz`，故按全名匹配）。
 * Nsight 报告属 `nsight` 子Agent，两个面互不依赖。
 */
import { existsSync, statSync } from "node:fs"
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

/**
 * 扫描后复核输入一致性（TOCTOU）：文件在分析期间被删除时返回可操作提示，未被改变时返回 undefined。
 * 与真正读取之间的窗口内被替换（大小/mtime 变化）同样视为不一致——避免把两份内容拼成一份结论。
 */
export function traceChangedReason(ref: TraceRef): string | undefined {
  if (!existsSync(ref.path)) {
    return `trace 在分析过程中被删除：${ref.path}\n请确认文件位置后重试（相对路径以当前工作目录或 project 根为基准）。`
  }
  const st = statSync(ref.path)
  if (st.size !== ref.size || Math.round(st.mtimeMs) !== Math.round(ref.mtimeMs)) {
    return `trace 在分析过程中被修改（大小 ${ref.size} → ${st.size} 字节，mtime ${new Date(ref.mtimeMs).toISOString()} → ${new Date(st.mtimeMs).toISOString()}）：${ref.path}\n本次结果已丢弃，请重试（正在写入的 trace 请等采集结束后再分析）。`
  }
  return undefined
}

/**
 * 文件访问类错误的可操作重写：文件被删除/路径失效时给出提示，而不是抛原始 ENOENT。
 * 非文件访问类错误返回 null（由调用方原样抛出）。
 */
export function traceAccessError(ref: TraceRef, err: unknown): Error | null {
  const message = err instanceof Error ? err.message : String(err)
  if (!/ENOENT|no such file|系统找不到|not found/i.test(message)) return null
  return new Error(
    `trace 在分析过程中不可读（可能被删除/移动/重命名）：${ref.path}\n` +
      `请确认路径与文件是否仍在（正在写入的 trace 请等采集结束后再分析），然后重试。`,
  )
}
