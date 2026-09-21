/**
 * LSP ↔ Monaco 转换层测试（`lsp-convert.ts`）：纯函数，全部用桩件（不加载 Monaco）。
 *
 * 这层错了不报错、只错行为——补全吃字符、跳转停错位置、诊断看不见。所以逐条钉住：
 * 行列 0/1 基、**零宽区间在诊断与编辑两处的不同处置**、跨文件区间不按本文夹取、补全的 snippet 与
 * 附加编辑、文档符号的两种服务器形态、诊断的 tags/relatedInformation/code 链接。
 */
import { describe, expect, test } from "bun:test"

import {
  hoverContentsOf,
  isLspSymbolKind,
  lspKindToSymKind,
  toCompletionItem,
  toDocumentSymbols,
  toLocations,
  toLspSymTree,
  toMarkers,
  toPanelSymbols,
  toPosition,
  toRange,
  toRangeRaw,
  toTextEdits,
  uriKeyOf,
} from "./lsp-convert"

/* ------------------------------ 桩件 ------------------------------ */

const MONACO = {
  languages: {
    CompletionItemKind: {
      Text: 1, Method: 2, Function: 3, Constructor: 4, Field: 5, Variable: 6, Class: 7,
      Interface: 8, Module: 9, Property: 10, Unit: 11, Value: 12, Enum: 13, Keyword: 14,
      Snippet: 15, Color: 16, File: 17, Reference: 18, Folder: 19, EnumMember: 20,
      Constant: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
    },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
  MarkerTag: { Unnecessary: 1, Deprecated: 2 },
  Uri: {
    parse: (s: string) => {
      const m = /^([a-z][\w+.-]*):\/\/(.*)$/i.exec(s)
      return m ? { scheme: m[1], path: `/${m[2]}`.replace(/^\/+/, "/"), toString: () => s } : { scheme: "", path: s, toString: () => s }
    },
  },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m = MONACO as any

/** 四行模型（第 1 行 11 列、第 2 行 30 列、第 3 行 3 列、第 4 行 1 列）：用于验「夹取」与「跨文件不夹取」。 */
const MODEL = {
  getLineCount: () => 4,
  getLineMaxColumn: (line: number) => [11, 30, 3, 1][line - 1] ?? 1,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any

const FILE_URI = "file:///repo/src/a.ts"

/* ------------------------------ 位置与区间 ------------------------------ */

describe("位置与区间", () => {
  test("0 基 → 1 基，负值/缺省都夹到 1", () => {
    expect(toPosition({ line: 0, character: 0 })).toEqual({ lineNumber: 1, column: 1 })
    expect(toPosition({ line: 4, character: 7 })).toEqual({ lineNumber: 5, column: 8 })
    expect(toPosition(undefined)).toEqual({ lineNumber: 1, column: 1 })
    expect(toPosition({ line: -3, character: -9 })).toEqual({ lineNumber: 1, column: 1 })
  })

  test("越界区间按 model 夹取（服务器给的是改动前的位置）", () => {
    // 第 9 行不存在 → 夹到最后一行；列超出行长 → 夹到行尾
    expect(toRange(MODEL, { start: { line: 8, character: 99 }, end: { line: 20, character: 99 } })).toEqual({
      startLineNumber: 4,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    })
  })

  test("诊断的零宽区间撑开一格（不撑开看不见波浪线）", () => {
    const r = toRange(MODEL, { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } })
    expect(r.endColumn).toBe(r.startColumn + 1)
  })

  test("编辑的零宽区间**不**撑开（撑开会把光标后的字符一起吃掉）", () => {
    const r = toRange(MODEL, { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, { expandEmpty: false })
    expect(r).toEqual({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 })
  })

  test("夹取后末端早于起端 → 退化成单点，不抛错", () => {
    const r = toRange(MODEL, { start: { line: 2, character: 9 }, end: { line: 0, character: 0 } })
    expect(r.startLineNumber).toBe(r.endLineNumber)
    expect(r.startColumn).toBe(r.endColumn)
  })

  test("toRangeRaw 不夹取（跨文件结果属于别的文件，行列原样给 Monaco）", () => {
    expect(toRangeRaw({ start: { line: 800, character: 3 }, end: { line: 801, character: 0 } })).toEqual({
      startLineNumber: 801,
      startColumn: 4,
      endLineNumber: 802,
      endColumn: 1,
    })
  })

  test("uriKeyOf：百分号与反斜杠归一，不做大小写改写", () => {
    expect(uriKeyOf("file:///c%3A/a/b.ts")).toBe("file:///c:/a/b.ts")
    expect(uriKeyOf("file:///C:\\a\\b.ts")).toBe("file:///C:/a/b.ts")
    expect(uriKeyOf("就%ZZ坏转义")).toBe("就%ZZ坏转义")
  })
})

/* ------------------------------ 补全 ------------------------------ */

describe("补全项", () => {
  const fallback = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }

  test("零宽 textEdit 保持零宽（插入，不替换）", () => {
    const item = toCompletionItem(
      m,
      MODEL,
      { label: "append", kind: 2, textEdit: { range: { start: { line: 1, character: 3 }, end: { line: 1, character: 3 } }, newText: "append" } },
      fallback,
    )
    expect(item.range).toEqual({ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 })
  })

  test("insert/replace 形态优先取 insert；snippet → insertTextRules", () => {
    const item = toCompletionItem(
      m,
      MODEL,
      {
        label: "func(${1:x})",
        kind: 3,
        insertTextFormat: 2,
        textEdit: { insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "func($1)" },
      },
      fallback,
    )
    expect(item.range).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 })
    expect(item.insertTextRules).toBe(m.languages.CompletionItemInsertTextRule.InsertAsSnippet)
  })

  test("documentation 两种形态、sortText/filterText/commitCharacters/preselect 透传", () => {
    const item = toCompletionItem(
      m,
      MODEL,
      {
        label: "x",
        kind: 6,
        documentation: { kind: "markdown", value: "**文档**" },
        detail: "int",
        sortText: "0001",
        filterText: "x",
        commitCharacters: [".", "("],
        preselect: true,
      },
      fallback,
    )
    expect(item.documentation).toEqual({ value: "**文档**" })
    expect(item.detail).toBe("int")
    expect(item.sortText).toBe("0001")
    expect(item.filterText).toBe("x")
    expect(item.commitCharacters).toEqual([".", "("])
    expect(item.preselect).toBe(true)
  })

  test("未知 kind 回 Text；label 为复合对象时取 label", () => {
    const item = toCompletionItem(m, MODEL, { label: { label: "值", detail: "d" }, kind: 99 }, fallback)
    expect(item.label).toBe("值")
    expect(item.kind).toBe(m.languages.CompletionItemKind.Text)
  })
})

/* ------------------------------ 悬停与诊断 ------------------------------ */

describe("悬停与诊断", () => {
  test("hover contents 四种历史形态", () => {
    expect(hoverContentsOf("纯文本")).toBe("纯文本")
    expect(hoverContentsOf({ kind: "markdown", value: "**md**" })).toBe("**md**")
    expect(hoverContentsOf({ language: "go", value: "func f()" })).toBe("```go\nfunc f()\n```")
    expect(hoverContentsOf(["a", { kind: "plaintext", value: "b" }])).toBe("a\n\nb")
    expect(hoverContentsOf(undefined)).toBe("")
  })

  test("severity 1..4 → Error/Warning/Info/Hint", () => {
    const sev = (s: number) => toMarkers(m, MODEL, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: s, message: "m" }])[0]?.severity
    expect([sev(1), sev(2), sev(3), sev(4)]).toEqual([8, 4, 2, 1])
  })

  test("空消息丢弃；source/code 透传；code + codeDescription 变成可点链接", () => {
    const out = toMarkers(m, MODEL, [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "" },
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        severity: 2,
        message: "未使用",
        source: "gopls",
        code: "unusedparams",
        codeDescription: { href: "https://example.com/unusedparams" },
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.source).toBe("gopls")
    expect(out[0]?.code).toEqual({ value: "unusedparams", target: expect.anything() })
  })

  test("tags：1=Unnecessary、2=Deprecated，其余忽略", () => {
    const mk = (tags: unknown) => toMarkers(m, MODEL, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 3, message: "m", tags }])[0]
    expect(mk([1])?.tags).toEqual([1])
    expect(mk([2, 1, 9])?.tags).toEqual([2, 1])
    expect(mk([])?.tags).toBeUndefined()
    expect(mk("nope")?.tags).toBeUndefined()
  })

  test("relatedInformation：带资源与区间；缺 message/uri 的条目跳过", () => {
    const out = toMarkers(m, MODEL, [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: "在别处声明",
        relatedInformation: [
          { location: { uri: FILE_URI, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } } }, message: "在此处声明" },
          { location: { uri: FILE_URI, range: {} }, message: "" },
          { message: "没有位置" },
        ],
      },
    ])
    expect(out[0]?.relatedInformation).toHaveLength(1)
    expect(out[0]?.relatedInformation?.[0]).toEqual({
      resource: expect.anything(),
      message: "在此处声明",
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 10,
    })
  })
})

/* ------------------------------ 跳转与编辑 ------------------------------ */

describe("跳转与文本编辑", () => {
  test("跨文件结果**不**按当前文件夹取（否则会跳去停在本文末尾）", () => {
    const locs = toLocations(
      m,
      MODEL,
      [{ uri: "file:///repo/src/other.ts", range: { start: { line: 800, character: 3 }, end: { line: 800, character: 8 } } }],
      FILE_URI,
    )
    expect(locs[0]?.range).toEqual({ startLineNumber: 801, startColumn: 4, endLineNumber: 801, endColumn: 9 })
  })

  test("同文件结果照旧夹取（服务器位置可能滞后于本地编辑）", () => {
    const locs = toLocations(m, MODEL, [{ uri: FILE_URI, range: { start: { line: 900, character: 0 }, end: { line: 900, character: 0 } } }], FILE_URI)
    expect(locs[0]?.range.startLineNumber).toBe(4)
  })

  test("未给 sameUri 时一律原样（调用方不做同文件判定）", () => {
    const locs = toLocations(m, MODEL, [{ uri: FILE_URI, range: { start: { line: 900, character: 0 }, end: { line: 900, character: 0 } } }])
    expect(locs[0]?.range.startLineNumber).toBe(901)
  })

  test("uri 归一后判同文件（服务器会用百分号编码改写路径）", () => {
    const locs = toLocations(m, MODEL, [{ uri: "file:///repo/src/a.ts", range: { start: { line: 900, character: 0 }, end: { line: 900, character: 0 } } }], "file:///repo/src/a%2Ets")
    expect(locs[0]?.range.startLineNumber).toBe(4)
  })

  test("LocationLink 形态（targetUri/targetSelectionRange）同样支持", () => {
    const locs = toLocations(m, MODEL, [
      { targetUri: "file:///repo/src/t.ts", targetSelectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, targetRange: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } } },
    ])
    expect(locs).toHaveLength(1)
    expect(locs[0]?.range.startLineNumber).toBe(2)
  })

  test("toTextEdits：非字符串 newText 与非法项一律丢弃（宁可少改一处，不改错一处）", () => {
    expect(toTextEdits([{ range: {}, newText: "a" }, { range: {} }, { newText: 5 }, null])).toEqual([{ range: {}, text: "a" }])
    expect(toTextEdits(undefined)).toEqual([])
  })
})

/* ------------------------------ 文档符号 ------------------------------ */

describe("文档符号", () => {
  test("层级形态（DocumentSymbol[]）：子级与范围", () => {
    const tree = toLspSymTree([
      {
        name: "Server",
        detail: "struct",
        kind: 23,
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 1 } },
        selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 11 } },
        children: [
          {
            name: "Start",
            kind: 6,
            range: { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } },
            selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 14 } },
          },
        ],
      },
    ])
    expect(tree).toHaveLength(1)
    expect(tree?.[0]?.children).toHaveLength(1)
    const outline = toDocumentSymbols(MODEL, tree!)
    expect(outline[0]).toMatchObject({ name: "Server", detail: "struct", kind: 23 })
    expect(outline[0]?.selectionRange).toEqual({ startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 12 })
    expect(outline[0]?.children?.[0]).toMatchObject({ name: "Start", kind: 6 })
    const flat = toPanelSymbols(tree!)
    expect(flat.map((s) => `${s.qualified}:${s.kind}:${s.depth}`)).toEqual(["Server:struct:0", "Server.Start:method:1"])
  })

  test("扁平形态（SymbolInformation[]）：按 containerName 归一层", () => {
    const tree = toLspSymTree([
      { name: "A", kind: 5, location: { uri: FILE_URI, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } } } },
      { name: "m", kind: 6, containerName: "A", location: { uri: FILE_URI, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } } } },
      { name: "top", kind: 12, location: { uri: FILE_URI, range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } } } },
    ])
    expect(toPanelSymbols(tree!).map((s) => s.qualified)).toEqual(["A", "A.m", "top"])
  })

  test("空数组 / 非数组 / 无名项 → null（调用方回退本地提取）", () => {
    expect(toLspSymTree([])).toBeNull()
    expect(toLspSymTree(null)).toBeNull()
    expect(toLspSymTree([{ kind: 1 }])).toBeNull()
  })

  test("kind 取值域与映射（1 File … 26 TypeParameter 直通 Monaco）", () => {
    expect(isLspSymbolKind(1)).toBe(true)
    expect(isLspSymbolKind(26)).toBe(true)
    expect(isLspSymbolKind(0)).toBe(false)
    expect(isLspSymbolKind(27)).toBe(false)
    expect(isLspSymbolKind("5")).toBe(false)
    expect(lspKindToSymKind(5)).toBe("class")
    expect(lspKindToSymKind(6)).toBe("method")
    expect(lspKindToSymKind(9)).toBe("constructor")
    expect(lspKindToSymKind(23)).toBe("struct")
    expect(lspKindToSymKind(26)).toBe("type")
    expect(lspKindToSymKind(1)).toBe("module")
    expect(lspKindToSymKind(999)).toBe("function")
  })

  test("符号范围越界时夹到 model 内（服务器给的是旧版本位置）", () => {
    const tree = toLspSymTree([
      { name: "far", kind: 12, range: { start: { line: 40, character: 0 }, end: { line: 60, character: 0 } }, selectionRange: { start: { line: 40, character: 2 }, end: { line: 40, character: 5 } } },
    ])
    const outline = toDocumentSymbols(MODEL, tree!)
    expect(outline[0]?.selectionRange.startLineNumber).toBe(4)
    expect(outline[0]?.range.startLineNumber).toBe(4)
  })
})
