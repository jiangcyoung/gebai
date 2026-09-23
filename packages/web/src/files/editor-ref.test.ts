/**
 * 编辑器右键的引用文本（`files/editor-ref.ts`）：复制路径 / 发送会话两处共用。
 *
 * 这一层全是**字符串规则**——错了不报错、只错内容（多一行、少一行号、代码块丢高亮），所以逐条钉住。
 */
import { describe, expect, test } from "bun:test"

import { buildChatSnippet, clipSnippetText, fenceLang, formatAbsRef, lineRefSuffix, normalizeLineRange } from "./editor-ref"

describe("选区 → 行区间", () => {
  test("单行选区：起止同一行", () => {
    expect(normalizeLineRange({ startLine: 12, startColumn: 3, endLine: 12, endColumn: 9 })).toEqual({ startLine: 12, endLine: 12 })
  })

  test("多行选区：末行取到实际选中那一行", () => {
    expect(normalizeLineRange({ startLine: 12, startColumn: 3, endLine: 20, endColumn: 7 })).toEqual({ startLine: 12, endLine: 20 })
  })

  test("拖到下一行行首：末行不算选中（Monaco 的 selection 语义）", () => {
    expect(normalizeLineRange({ startLine: 12, startColumn: 3, endLine: 20, endColumn: 1 })).toEqual({ startLine: 12, endLine: 19 })
  })

  test("单行选区且列在行首：不倒退成 0 行（夹到起点）", () => {
    expect(normalizeLineRange({ startLine: 12, startColumn: 1, endLine: 12, endColumn: 1 })).toEqual({ startLine: 12, endLine: 12 })
  })

  test("脏值（0/负数/NaN/小数）夹成合法行号", () => {
    expect(normalizeLineRange({ startLine: 0, startColumn: 1, endLine: -5, endColumn: 1 })).toEqual({ startLine: 1, endLine: 1 })
    expect(normalizeLineRange({ startLine: 3.7, startColumn: 1, endLine: Number.NaN, endColumn: 1 })).toEqual({ startLine: 3, endLine: 3 })
  })
})

describe("行号后缀与绝对路径引用", () => {
  test("单行写 :12，不写 12-12", () => {
    expect(lineRefSuffix({ startLine: 12, endLine: 12 })).toBe(":12")
  })

  test("多行写起止", () => {
    expect(lineRefSuffix({ startLine: 12, endLine: 20 })).toBe(":12-20")
  })

  test("末行小于起点时按单行处理（不出现 20-12 这种反的区间）", () => {
    expect(lineRefSuffix({ startLine: 20, endLine: 12 })).toBe(":20")
  })

  test("无行区间 = 只有路径", () => {
    expect(lineRefSuffix(null)).toBe("")
    expect(lineRefSuffix(undefined)).toBe("")
    expect(formatAbsRef("/a/b.ts")).toBe("/a/b.ts")
  })

  test("绝对路径 + 行号；路径尾斜杠去掉", () => {
    expect(formatAbsRef("/a/b/c.ts", { startLine: 12, endLine: 20 })).toBe("/a/b/c.ts:12-20")
    expect(formatAbsRef("/a/b/", { startLine: 3, endLine: 3 })).toBe("/a/b:3")
  })

  test("Windows 盘符路径原样保留（不重写分隔符，只拼行号）", () => {
    expect(formatAbsRef("C:\\x\\y.ts", { startLine: 5, endLine: 5 })).toBe("C:\\x\\y.ts:5")
  })
})

describe("发送片段", () => {
  test("引用行 + 代码块（语言标注在围栏上）", () => {
    expect(buildChatSnippet({ absPath: "/a/b.ts", range: { startLine: 2, endLine: 3 }, text: "const x = 1\nconst y = 2\n", language: "typescript" })).toBe(
      ["/a/b.ts:2-3", "", "```typescript", "const x = 1", "const y = 2", "```"].join("\n"),
    )
  })

  test("纯文本/未知语言不给围栏标注（否则渲染端会去查一个没注册的语言）", () => {
    expect(fenceLang("plaintext")).toBe("")
    expect(fenceLang("")).toBe("")
    expect(fenceLang(undefined)).toBe("")
    expect(fenceLang("ts")).toBe("ts")
    expect(buildChatSnippet({ absPath: "/a/notes.txt", range: { startLine: 1, endLine: 1 }, text: "hello", language: "plaintext" })).toBe(
      ["/a/notes.txt:1", "", "```", "hello", "```"].join("\n"),
    )
  })

  test("没有行区间时只给路径（复制路径用同一套组装）", () => {
    expect(buildChatSnippet({ absPath: "/a/b.ts", text: "x", language: "ts" })).toContain("/a/b.ts\n\n```ts")
  })

  test("选区里的三反引号不破坏片段（原样进出，不转义）", () => {
    const out = buildChatSnippet({ absPath: "/a/m.ts", range: { startLine: 1, endLine: 1 }, text: "```\ncode", language: "markdown" })
    expect(out).toContain("```\ncode")
  })
})

describe("截断", () => {
  test("超行数按行裁，不切断半行", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
    const r = clipSnippetText(text, 3, 10000)
    expect(r.text).toBe("line 1\nline 2\nline 3")
    expect(r.truncated).toBe(true)
    expect(r.totalLines).toBe(10)
  })

  test("未超限不动内容（含末尾换行的行数口径）", () => {
    expect(clipSnippetText("a\nb\n", 5, 100)).toEqual({ text: "a\nb", truncated: false, totalLines: 2 })
    expect(clipSnippetText("a\nb", 5, 100)).toEqual({ text: "a\nb", truncated: false, totalLines: 2 })
  })

  test("单行巨长：字符上限兜底（行数上限管不住它）", () => {
    const r = clipSnippetText("x".repeat(50), 200, 10)
    expect(r.text).toBe("x".repeat(10))
    expect(r.truncated).toBe(true)
    expect(r.totalLines).toBe(1)
  })

  test("片段在截断时给出如实提示（行数与实际发送行数）", () => {
    const text = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join("\n")
    const out = buildChatSnippet({ absPath: "/a/b.ts", range: { startLine: 1, endLine: 8 }, text, language: "ts", maxLines: 2 })
    expect(out).toContain("（已截断：选区共 8 行，仅发送前 2 行）")
    expect(out).not.toContain("L3")
  })

  test("空文本不崩（光标在空行上右键发送）", () => {
    expect(clipSnippetText("", 200, 20000)).toEqual({ text: "", truncated: false, totalLines: 1 })
    expect(buildChatSnippet({ absPath: "/a/b.ts", range: { startLine: 3, endLine: 3 }, text: "", language: "ts" })).toBe(
      ["/a/b.ts:3", "", "```ts", "", "```"].join("\n"),
    )
  })
})
