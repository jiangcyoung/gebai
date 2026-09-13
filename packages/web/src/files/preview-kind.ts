/**
 * 「可渲染文件」的判定：哪些文件能在工作台里**以渲染形态**打开（而不是只看源码）。
 *
 * 两类：
 * - 图表源码（mermaid / plantuml / d2 / echarts）→ 交给本地引擎画成图；
 * - markdown（md / markdown / mdx）→ 渲染成文档。
 *
 * 与「查看器 kind」不同：markdown 在服务端是 `text`（仍需要 Monaco 源码视图），所以不能靠 `stat.kind`
 * 分派——**按扩展名判定**，前端据此决定是否给「渲染预览 ⇄ 源码」按钮。
 * 纯函数（无 DOM、无依赖）：扩展名清单散在多处最容易漂移，这里单点定义并单测。
 */

/** 图表源码类型（画成图）。 */
export type DiagramKind = "mermaid" | "plantuml" | "d2" | "echarts"
/** 可渲染形态（图表 / markdown 文档）。 */
export type PreviewKind = "diagram" | "markdown"

const DIAGRAM_EXT: Record<string, DiagramKind> = {
  mmd: "mermaid",
  mermaid: "mermaid",
  puml: "plantuml",
  plantuml: "plantuml",
  pu: "plantuml",
  iuml: "plantuml",
  d2: "d2",
  echarts: "echarts",
}

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"])

const norm = (ext: string): string => ext.trim().toLowerCase().replace(/^\./, "")

/** 扩展名 → 图表类型（不是图表源码返回 null）。 */
export function diagramKindOf(ext: string): DiagramKind | null {
  return DIAGRAM_EXT[norm(ext)] ?? null
}

/** 扩展名 → 可渲染形态；不可渲染（只能看源码）返回 null。 */
export function previewKindOf(ext: string): PreviewKind | null {
  const e = norm(ext)
  if (!e) return null
  if (MARKDOWN_EXT.has(e)) return "markdown"
  return DIAGRAM_EXT[e] ? "diagram" : null
}
