/**
 * 「可渲染文件」判定（`files/preview-kind.ts`）。
 *
 * 钉住两条：markdown 三种扩展名算可渲染（它的服务端 kind 是 text，靠这里判）；图表扩展名与
 * 具体图表类型一一对应（该清单是图表渲染与按钮显示的单一真相）。
 */
import { describe, expect, test } from "bun:test"
import { diagramKindOf, previewKindOf, type DiagramKind } from "./preview-kind"

describe("可渲染形态判定", () => {
  test("markdown：md / markdown / mdx → markdown（大小写与点号前缀容错）", () => {
    for (const ext of ["md", "markdown", "mdx", "MD", "Markdown", ".md"]) {
      expect(previewKindOf(ext)).toBe("markdown")
    }
  })

  test("图表源码 → diagram，且类型与 diagramKindOf 一致", () => {
    const cases: Array<[string, DiagramKind]> = [
      ["mmd", "mermaid"],
      ["mermaid", "mermaid"],
      ["puml", "plantuml"],
      ["plantuml", "plantuml"],
      ["pu", "plantuml"],
      ["iuml", "plantuml"],
      ["d2", "d2"],
      ["echarts", "echarts"],
    ]
    for (const [ext, kind] of cases) {
      expect(previewKindOf(ext)).toBe("diagram")
      expect(diagramKindOf(ext)).toBe(kind)
    }
  })

  test("不可渲染：文本/代码/图片等只给源码或专用查看器，没有「渲染预览」按钮", () => {
    for (const ext of ["ts", "json", "css", "txt", "html", "png", "pdf", "svg", ""]) {
      expect(previewKindOf(ext)).toBeNull()
    }
  })

  test("图表类型查询对非图表扩展名返回 null（不是 undefined）", () => {
    expect(diagramKindOf("md")).toBeNull()
    expect(diagramKindOf("ts")).toBeNull()
  })
})
