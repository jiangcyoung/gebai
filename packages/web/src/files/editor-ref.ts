/**
 * 编辑器右键的**引用文本**：绝对路径 + 行号（工作台「复制路径」与「发送会话」共用）。
 *
 * 为什么单独成模块：这两处拼的是**给人和给模型看的字符串**，规则必须一致且可测——
 * - 「复制路径」：`/abs/path/src/main.ts:12`（单行）或 `/abs/path/src/main.ts:12-20`（选中块）；
 * - 「发送会话」：同一套引用 + 代码块（模型据此直接 `read` 该文件的那几行）。
 *
 * 三个容易错、又都不报错的点：
 * ① **选区末行**：Monaco 的 selection 在「从某行拖到下一行行首」时 `endLineNumber` 是下一行——
 *    那一行其实一个字符都没选中，直接取会多报一行（`normalizeLineRange` 处理）；
 * ② **行号后缀**：单行不该写成 `12-12`（读者的第一反应是「这文件坏了」），两条口径分开；
 * ③ **发送的体积**：选区可能是整文件，原样塞进输入框会把 textarea 与消息一起拖垮（`clipSnippetText` 截断）。
 *
 * 与 `grep` 工具输出同口径（`文件:行号`），模型与用户看到的是同一种引用。
 */

/** 编辑器选区（行/列均 1 起始，同 Monaco 的 Selection 语义）。 */
export interface LineSelection {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

/** 归一后的行区间（含两端，1 起始）。 */
export interface LineRange {
  startLine: number
  endLine: number
}

/** 夹到一个合法行号（NaN/0/负数 → 1；非整数向下取整）。 */
function lineNo(n: number): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v > 0 ? v : 1
}

/**
 * 选区 → 行区间。**末行只在行首时不算选中**（Monaco 的 selection 语义：拖到下一行行首 =
 * 选中到上一行行尾）；单行选区（startLine === endLine）原样返回。
 */
export function normalizeLineRange(sel: LineSelection): LineRange {
  const startLine = lineNo(sel.startLine)
  let endLine = lineNo(sel.endLine)
  if (endLine > startLine && lineNo(sel.endColumn) === 1) endLine -= 1
  return { startLine, endLine: Math.max(startLine, endLine) }
}

/** 行号后缀：单行 `:12`、多行 `:12-20`；行区间缺失/非法时为空串（调用方只拿路径）。 */
export function lineRefSuffix(range: LineRange | null | undefined): string {
  if (!range) return ""
  const start = lineNo(range.startLine)
  const end = lineNo(range.endLine)
  if (end <= start) return `:${start}`
  return `:${start}-${end}`
}

/** 绝对路径 + 行号（`/a/b/c.ts:12-20`）。`range` 为空则只有路径。 */
export function formatAbsRef(absPath: string, range?: LineRange | null): string {
  return `${String(absPath ?? "").replace(/\/+$/, "")}${lineRefSuffix(range)}`
}

/** 发送片段的行/字符上限（截断见 clipSnippetText）。 */
export const SNIPPET_MAX_LINES = 200
export const SNIPPET_MAX_CHARS = 20000

export interface ClipResult {
  /** 截断后的文本（按行裁切，再按字符兜底） */
  text: string
  /** 是否发生了截断 */
  truncated: boolean
  /** 原文行数（截断提示里如实报出） */
  totalLines: number
}

/**
 * 按行数与字符数裁切要发送的代码（**按行裁**，不切断半行；单行巨长如 minified 时再按字符兜底）。
 * 两条上限都要：行数防「整文件 5 万行」，字符防「一行 2MB」（前者管不住它）。
 */
export function clipSnippetText(text: string, maxLines = SNIPPET_MAX_LINES, maxChars = SNIPPET_MAX_CHARS): ClipResult {
  const src = String(text ?? "")
  // 末尾换行不算一"行"内容（选区常带尾换行，否则总行数会多报 1）
  const body = src.endsWith("\n") ? src.slice(0, -1) : src
  const lines = body.split("\n")
  const totalLines = lines.length
  let kept = lines
  let truncated = false
  if (maxLines > 0 && lines.length > maxLines) {
    kept = lines.slice(0, maxLines)
    truncated = true
  }
  let joined = kept.join("\n")
  if (maxChars > 0 && joined.length > maxChars) {
    joined = joined.slice(0, maxChars)
    truncated = true
  }
  return { text: joined, truncated, totalLines }
}

/**
 * 代码块的语言标注：hljs/Monaco 的 id 直接用；纯文本与未知空值不给标注
 * （给了 `plaintext` 反而让渲染端去查一个没注册的语言）。
 */
export function fenceLang(language: string | undefined | null): string {
  const l = String(language ?? "").trim()
  if (!l || l === "plaintext" || l === "text" || l === "plain") return ""
  return l
}

export interface SnippetInput {
  /** 文件绝对路径 */
  absPath: string
  /** 行区间（可空：没算出选区时只发路径与内容） */
  range?: LineRange | null
  /** 代码文本（已裁切或未裁切，函数内部还会裁一次） */
  text: string
  /** Monaco/hljs 语言 id */
  language?: string | null
  maxLines?: number
  maxChars?: number
}

/**
 * 组装「发送会话」的片段：**引用行 + 代码块**（Markdown）。
 *
 * 为什么引用单独占一行、而不是塞进代码块的围栏信息里（```` ```ts src/a.ts:12 ````）：
 * 围栏信息串会被 markdown-it 整串当作语言名交给 highlight.js（`getLanguage("ts src/a.ts:12")` 必然失败），
 * 结果是代码块**静默失去高亮**；而单独一行既保住了高亮，也让模型一眼看到「去哪读、读哪几行」。
 *
 * 截断提示放在代码块**之外**：放进去就成了代码的一部分（复制走会带上这不属于原文的一行）。
 */
export function buildChatSnippet(o: SnippetInput): string {
  const ref = formatAbsRef(o.absPath, o.range)
  const clipped = clipSnippetText(o.text, o.maxLines, o.maxChars)
  const lang = fenceLang(o.language)
  const fence = "```"
  const body = `${ref}\n\n${fence}${lang}\n${clipped.text}\n${fence}`
  if (!clipped.truncated) return body
  return `${body}\n\n（已截断：选区共 ${clipped.totalLines} 行，仅发送前 ${clipped.text.split("\n").length} 行）`
}
