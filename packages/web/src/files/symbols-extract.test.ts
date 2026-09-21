/**
 * 符号提取调度测试（`symbols-extract.ts`）：**tree-sitter 优先、失败回退词法**这条唯一的分派规则。
 *
 * 为什么值得单测：两条路径的输出同形（`Sym[]`）但质量差很多，分派错了不报错——只是符号表悄悄变差
 * （少符号、把函数体内的局部变量当文件符号）。这里钉住四种情形：有语法树、语法树不可用（回退）、
 * 语言根本没语法树（直接走词法）、两条路径都没有（空结果 + 调用方能据此提示）。
 *
 * 用桩 `GrammarLoader` 控制「语法文件拿不到」，不需要真实 wasm（真实解析由 `symbols-ts.test.ts` 覆盖）。
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Parser, Language } from "web-tree-sitter"
import { canExtract, extractSymbolsAsync } from "./symbols-extract"
import { flattenSymbols } from "./symbols-core"
import { setGrammarLoader, type TsRuntime } from "./symbols-ts"

const WASM_DIR = join(import.meta.dirname, "..", "..", "node_modules", "tree-sitter-wasms", "out")
await Parser.init({ locateFile: () => join(import.meta.dirname, "..", "..", "node_modules", "web-tree-sitter", "tree-sitter.wasm") })
const runtime = { Parser, Language } as unknown as TsRuntime
// 让 symbols-ts 的惰性加载拿到真实语法（浏览器里这步是 HTTP 取 wasm）
setGrammarLoader(async (file) => {
  const f = Bun.file(join(WASM_DIR, file))
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null
})
// 惰性运行时在浏览器里由 `import(vendor/tree-sitter.js)` 提供；测试环境注入同一份
const { setTsRuntimeForTest } = await import("./symbols-ts")
setTsRuntimeForTest(runtime)

const PY = `MAX_RETRY = 3

class Client:
    def __init__(self, host):
        self.host = host

    def fetch(self, url):
        return url


def helper(a):
    return a
`

describe("符号提取调度", () => {
  test("有语法树的语言：走 tree-sitter（函数体内的局部赋值不当文件符号）", async () => {
    const res = await extractSymbolsAsync(PY, "python")
    expect(res.source).toBe("tree-sitter")
    // `symbols` 是符号树（子级挂在父级下）：展平后才能逐条比对
    const names = flattenSymbols(res.symbols).map((s) => `${s.qualified}:${s.kind}`)
    expect(names).toContain("MAX_RETRY:constant")
    expect(names).toContain("Client:class")
    expect(names).toContain("helper:function")
    // 类内函数是方法、`__init__` 是构造器（归属关系由 tree-sitter 路径给出）
    expect(names).toContain("Client.__init__:constructor")
    expect(names).toContain("Client.fetch:method")
    // 函数体内的局部赋值（`self.host = host`）不是文件符号
    expect(names.some((n) => n.includes("host"))).toBe(false)
  })

  test("语法文件拿不到：回退词法（结果仍可用，来源如实标 lexical）", async () => {
    setGrammarLoader(async () => null)
    try {
      const res = await extractSymbolsAsync(PY, "python")
      expect(res.source).toBe("lexical")
      // 词法路径同样能列出这些符号（质量差异在于作用域判断，不在名字）
      expect(res.symbols.map((s) => s.name)).toContain("Client")
      expect(res.symbols.map((s) => s.name)).toContain("helper")
    } finally {
      setGrammarLoader(async (file) => {
        const f = Bun.file(join(WASM_DIR, file))
        return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null
      })
    }
  })

  test("没有语法树但有词法规则的语言：直接走词法（不白试一次 wasm）", async () => {
    const res = await extractSymbolsAsync("[section]\nkey = 1\nname = demo\n", "ini")
    expect(res.source).toBe("lexical")
    expect(res.symbols.length).toBeGreaterThan(0)
  })

  test("两条路径都没有的语言：空结果而不是抛错（调用方据此提示「暂无符号提取」）", async () => {
    const res = await extractSymbolsAsync("<svg><g id=\"a\"/></svg>", "xml")
    expect(res).toEqual({ symbols: [], source: "lexical" })
    expect(canExtract("xml")).toBe(false)
    expect(canExtract("python")).toBe(true)
    expect(canExtract("ini")).toBe(true)
  })

  test("可提取性判定的口径：语法树或词法任一即可", () => {
    // 15 种语法树语言
    for (const lang of ["go", "rust", "cpp", "python", "ruby", "php", "lua", "shell", "elixir", "dart", "swift", "scala", "kotlin", "java", "c"]) {
      expect({ lang, ok: canExtract(lang) }).toEqual({ lang, ok: true })
    }
    // 词法兜底语言
    for (const lang of ["ini", "yaml", "markdown", "sql", "dockerfile", "makefile", "powershell", "bat"]) {
      expect({ lang, ok: canExtract(lang) }).toEqual({ lang, ok: true })
    }
    // Monaco 内置语言服务的语言：本链路不负责（由内置 worker 提供，故 canExtract 为 false）
    for (const lang of ["typescript", "javascript", "json", "css", "html", "xml", "plaintext"]) {
      expect({ lang, ok: canExtract(lang) }).toEqual({ lang, ok: false })
    }
  })
})
