/**
 * 文件工作台 · Monaco 侧符号能力桥：把 `symbols-core.ts` 的词法级提取接到编辑器的两个入口上——
 * 「转到符号」（`DocumentSymbolProvider` → Monaco 自带的 Ctrl+Shift+O 大纲）与
 * 「跳到定义」（`DefinitionProvider` → F12 / Ctrl+Click，**限当前文件内**）。
 *
 * 为什么注册在语言选择器上而不是每个编辑器实例：provider 是 Monaco 的全局注册表（按语言 id 匹配），
 * 装一次对同页所有编辑器生效（主编辑器、差异两侧、合并三栏都算），实例级别无需重复接线。
 *
 * 缓存按 **model 版本号**（`getVersionId`）失效：提取是一次全量扫描，键盘每敲一下都重算会卡；
 * 而 Monaco 的版本号恰好在内容变化时自增，命中缓存即「这份文本已经算过」。
 * 缓存只留最近几个 model（打开的标签数量有限，FIFO 淘汰），不为每个曾经打开的文件常驻内存。
 *
 * 与内置语言服务的关系：TypeScript / JavaScript / JSON / CSS 系 / HTML 由 Monaco 自带语言服务提供
 * 符号与跳转（本地 worker，非 LSP，卸载无外部依赖）——这些语言的语义解析交给它更准，
 * 语言表因此不含它们（重复注册会让符号列表出现两份）。本模块只管其余语言：
 * **有语法文件的走 tree-sitter，其余走词法规则**（见 `symbols-extract.ts`）。
 */
import { findDefinitions, flattenSymbols, SYMBOL_LANGUAGES, type FlatSym, type Sym, type SymKind } from "./symbols-core"
import { extractSymbolsAsync } from "./symbols-extract"
import { TS_LANGUAGES } from "./symbols-ts-rules"
import { lspLanguages } from "./lsp"

type Monaco = typeof import("monaco-editor")
type ITextModel = import("monaco-editor").editor.ITextModel
type Position = import("monaco-editor").Position
type MonacoRange = import("monaco-editor").IRange

/** 两条提取路径覆盖的语言并集（Monaco 按语言 id 匹配 provider）。 */
const BASE_LANGS = Object.keys(TS_LANGUAGES).concat(SYMBOL_LANGUAGES)

/**
 * 语言选择器：基础语言集 **剔除本机有语言服务器的语言**——有 LSP 时符号与跳转交给服务器
 * （语义解析比词法/语法树更准），同时避免同一个跳转出现两份候选（分工见 `lsp.ts`）。
 */
function selectorFor(): string[] {
  const lsp = lspLanguages()
  return lsp.size ? BASE_LANGS.filter((l) => !lsp.has(l)) : BASE_LANGS
}
/** 在 Monaco 的符号来源里显示为「gebai-symbols」——两条路径都是工作台自己的提取（非语言服务）。 */
const DISPLAY_NAME = "gebai-symbols"

/** core 的符号种类 → Monaco 的符号图标。Monaco 没有 type/trait/macro，就近映射到语义最近的一档。 */
const KIND: Record<SymKind, number> = {
  module: 1,
  namespace: 2,
  package: 3,
  class: 4,
  method: 5,
  property: 6,
  field: 7,
  constructor: 8,
  enum: 9,
  interface: 10,
  function: 11,
  variable: 12,
  constant: 13,
  event: 23,
  enumMember: 21,
  struct: 22,
  object: 18,
  type: 10,
  trait: 10,
  macro: 11,
  heading: 14,
  section: 2,
  key: 19,
  label: 19,
  table: 22,
  view: 18,
  procedure: 11,
  resource: 18,
}

interface Cached {
  version: number
  language: string
  tree: Sym[]
  flat: FlatSym[]
  /** 实际走的提取路径（tree-sitter 失败时是词法） */
  source: "tree-sitter" | "lexical"
}

const cache = new Map<string, Cached>()
const CACHE_MAX = 8

/** 进行中的提取（同一 model 并发请求共享一次解析：provider 与面板常同时问同一份文本）。 */
const pending = new Map<string, Promise<Cached>>()

/**
 * 提取（带 model 版本缓存）。
 *
 * 有语法文件的语言走真语法树（异步、一次性全量扫描），因此缓存按 **model 版本号** 失效——
 * Monaco 的版本号恰好在内容变化时自增，命中即「这份文本已算过」；否则键盘每敲一下就重解析。
 */
async function symbolsOf(model: ITextModel): Promise<Cached> {
  const key = model.uri.toString()
  const version = model.getVersionId()
  const language = model.getLanguageId()
  const hit = cache.get(key)
  if (hit && hit.version === version && hit.language === language) return hit
  const inflight = pending.get(key)
  if (inflight) {
    const done = await inflight
    if (done.version === version && done.language === language) return done
  }
  const job = (async (): Promise<Cached> => {
    const { symbols, source } = await extractSymbolsAsync(model.getValue(), language)
    return { version, language, tree: symbols, flat: flattenSymbols(symbols), source }
  })()
  pending.set(key, job)
  try {
    const entry = await job
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    cache.set(key, entry)
    return entry
  } finally {
    if (pending.get(key) === job) pending.delete(key)
  }
}

/** 文件内符号列表（工作台的「转到符号」面板用，与 Monaco 大纲同源）。 */
export async function flatSymbolsOf(model: ITextModel): Promise<FlatSym[]> {
  return (await symbolsOf(model)).flat
}

/** 该 model 的符号来源（面板提示「结果来自语法树还是词法」）。 */
export async function symbolSourceOf(model: ITextModel): Promise<"tree-sitter" | "lexical"> {
  return (await symbolsOf(model)).source
}

/** 整个符号占据的行区间（起止都取行首——列信息交给 `selectionRange` 表达）。 */
function bodyRange(model: ITextModel, sym: Sym): MonacoRange {
  const end = Math.min(sym.endLine, model.getLineCount() - 1)
  return { startLineNumber: sym.line + 1, startColumn: 1, endLineNumber: end + 1, endColumn: 1 }
}

/** 名字本身的位置（Monaco 用它高亮与对齐候选）。 */
function nameRange(sym: Sym): MonacoRange {
  const line = sym.line + 1
  return { startLineNumber: line, startColumn: sym.column + 1, endLineNumber: line, endColumn: sym.column + 1 + sym.name.length }
}

function toDocumentSymbols(syms: readonly Sym[], model: ITextModel): import("monaco-editor").languages.DocumentSymbol[] {
  return syms.map((s) => ({
    name: s.name,
    detail: "",
    kind: KIND[s.kind] as import("monaco-editor").languages.SymbolKind,
    tags: [],
    range: bodyRange(model, s),
    selectionRange: nameRange(s),
    children: toDocumentSymbols(s.children, model),
  }))
}

let installed = false

/**
 * 注册符号 provider（幂等：Monaco 是页面单例，重复安装只会叠加重复候选）。
 *
 * 只覆盖有映射的语言（`TS_LANGUAGES` + `SYMBOL_LANGUAGES`）——TypeScript / JavaScript / JSON /
 * CSS 系 / HTML 不在此列，那几种语言由 Monaco 自带的语言服务（本地 worker，非 LSP）提供符号与跳转。
 */
export function installSymbolProviders(monaco: Monaco): void {
  if (installed) return
  installed = true
  const selector = selectorFor()
  monaco.languages.registerDocumentSymbolProvider(selector, {
    displayName: DISPLAY_NAME,
    // Monaco 的 ProviderResult 接受 Promise：异步提取不会卡住编辑器
    provideDocumentSymbols: async (model) => toDocumentSymbols((await symbolsOf(model)).tree, model),
  })
  monaco.languages.registerDefinitionProvider(selector, {
    provideDefinition: async (model: ITextModel, position: Position) => {
      const entry = await symbolsOf(model)
      const word = model.getWordAtPosition(position)
      if (!word) return undefined
      const defs = findDefinitions(entry.tree, word.word)
      if (!defs.length) return undefined
      /*
       * 光标正落在某个定义的名字上时（用户想找「另一个同名定义」），把它排到最后：
       * 只有一个候选时原地不动等于什么都没发生，多个候选时也应当先呈现别的定义。
       */
      const here = defs.findIndex((d) => d.line + 1 === position.lineNumber && position.column >= d.column + 1 && position.column <= d.column + 1 + d.name.length)
      const ordered = here >= 0 && defs.length > 1 ? [...defs.filter((_, i) => i !== here), defs[here]!] : defs
      /*
       * 返回 `Location`（uri + range）而不是 LocationLink：Monaco 的 d.ts 把 LocationLink 声明成
       * `{ uri, range }`，实现里用的却是 `targetUri/targetRange` 那套（vscode 形态），照实现写就得打断言。
       * range 取名字本身的位置，跳转即落在定义的名字上，与 targetSelectionRange 同效。
       */
      return ordered.map((d) => ({ uri: model.uri, range: nameRange(d) }))
    },
  })
}
