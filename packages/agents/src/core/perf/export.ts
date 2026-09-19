/**
 * 分析报告的 Markdown 导出（性能分析类子Agent 共用）。
 *
 * 为什么需要：诊断结果此前只在对话里呈现——长报告无法归档、无法贴给同事、无法进 PR 说明。
 * 导出为 Markdown 后可直接落到工程里（或粘进 issue），且**保留证据与源码位置**，
 * 与对话输出同一套事实（不重新聚合，只做排版）。
 *
 * 设计取舍：
 * - 落盘路径按 project 根解析（与报告路径同一基准），避免「文件写到莫名其妙的地方」；
 * - 只写文本（Markdown），不做 HTML/PDF——那是另一层需求，需要时再谈；
 * - 文件名带时间戳版本，重跑不覆盖上一版（历史可回看）。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export interface ExportSection {
  /** 二级标题（如「问题清单」）。 */
  title: string
  /** 正文行（已排版好的 Markdown；空字符串为段落间隔）。 */
  lines: string[]
}

export interface ExportDoc {
  /** 一级标题。 */
  title: string
  /** 标题下的元信息行（报告路径、分析耗时、数据来源等）。 */
  meta: string[]
  sections: ExportSection[]
}

/** 渲染为 Markdown 文本。 */
export function renderMarkdown(doc: ExportDoc): string {
  const out: string[] = [`# ${doc.title}`, ""]
  for (const m of doc.meta) out.push(`> ${m}`)
  out.push("")
  for (const s of doc.sections) {
    out.push(`## ${s.title}`, "")
    out.push(...s.lines)
    out.push("")
  }
  out.push("---", "", "*由歌白性能分析生成（数据来自流式聚合事实，与报告规模无关的有界结构）*", "")
  return out.join("\n")
}

/** 文件名里的时间戳（本地时间，便于人读）。 */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface SaveResult {
  path: string
  bytes: number
}

/**
 * 落盘（路径按 project 根解析；相对路径落在 project 根下，未给 project 则落在会话工作区）。
 *
 * 文件名规则：`{基名}-{时间戳}.md`——同名重跑不覆盖上一版。
 */
export function saveMarkdown(opts: {
  /** 目标目录（相对 project 根或绝对路径）。 */
  dir?: string
  /** 文件名基名（不含扩展名与时间戳）。 */
  base: string
  /** project 根（ctx.projectRoot 或工具参数解析所得）；缺省用会话工作区。 */
  projectRoot?: string
  workdir?: string
  text: string
}): SaveResult {
  const root = opts.projectRoot || opts.workdir || process.cwd()
  const dir = opts.dir ? (isAbsolute(opts.dir) ? opts.dir : resolve(root, opts.dir)) : root
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${opts.base}-${stamp()}.md`)
  writeFileSync(path, opts.text, "utf8")
  return { path, bytes: Buffer.byteLength(opts.text, "utf8") }
}

/** 供工具层复用的「导出参数」schema 片段。 */
export const EXPORT_PARAMS = {
  save: { type: "boolean", description: "是否把本次分析导出为 Markdown 文件（默认 false，仅输出到对话）" },
  save_dir: { type: "string", description: "导出目录（相对 project 根；缺省落在 project 根）" },
} as const

/** 解析导出参数（save 未开则返回 null）。 */
export function parseExportArgs(args: Record<string, unknown>): { dir?: string } | null {
  if (args.save !== true) return null
  const dir = typeof args.save_dir === "string" && args.save_dir.trim() ? args.save_dir.trim() : undefined
  return { dir }
}

/** 导出失败不应让分析结果丢失——返回提示文本由工具层附在输出末尾。 */
export function exportNote(saved: SaveResult | null, error?: unknown): string {
  if (saved) return `已导出 Markdown：${saved.path}（${saved.bytes} 字节）`
  if (error) return `导出失败：${error instanceof Error ? error.message : String(error)}（分析结果仍见上方）`
  return ""
}

void dirname
