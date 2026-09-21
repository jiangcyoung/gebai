/**
 * 文件工作台 · LSP ↔ Monaco 类型转换（纯函数，便于单独阅读与推演）。
 *
 * 两侧的差异都在这里收口：
 * - 位置/区间：LSP 行列从 **0** 起，Monaco 从 **1** 起；LSP 的 `end` 是排他的，与 Monaco 一致；
 * - **零宽区间**：诊断要撑开一格（不撑开看不见波浪线），编辑类区间绝不能撑（会把光标后的字符吞掉）
 *   ——差异由 `RangeOptions.expandEmpty` 表达，见 `toRange`；
 * - 补全项：`CompletionItemKind` 两套枚举；`insertTextFormat`（snippet）→ `insertTextRules`；
 *   `documentation` 可能是字符串或 `MarkupContent`；
 * - 悬停：`contents` 有四种历史形态（字符串 / MarkupContent / MarkedString / 数组）；
 * - 诊断：severity 1..4 ↔ `MarkerSeverity`，另接 `tags`（未使用/已弃用）、`relatedInformation`、
 *   `codeDescription`（带文档链接的诊断码）；
 * - 文档符号：`SymbolKind` 两套枚举取值完全相同（1 File … 26 TypeParameter），kind 可直通；
 *   两种形态（层级 `DocumentSymbol[]` / 扁平 `SymbolInformation[]`）归一到同一个中间树 `LspSym`。
 *
 * 越界防护：服务器给出的区间可能属于改动前的内容（诊断与编辑竞争），一律做 clamp——
 * Monaco 收到越界区间会抛错，宁可把标记夹到合法范围。**但跨文件结果不夹**（见 `toLocations`）。
 */

type Monaco = typeof import("monaco-editor")
type Model = import("monaco-editor").editor.ITextModel
type MonacoRange = import("monaco-editor").IRange
type CompletionItem = import("monaco-editor").languages.CompletionItem
type MarkerData = import("monaco-editor").editor.IMarkerData
type MarkerSeverity = import("monaco-editor").MarkerSeverity
type MarkerTag = import("monaco-editor").MarkerTag
type MarkdownString = import("monaco-editor").IMarkdownString
type Location = import("monaco-editor").languages.Location
type FlatSym = import("./symbols-core").FlatSym
type SymKind = import("./symbols-core").SymKind

type LspPosition = { line?: number; character?: number }
type LspRange = { start?: LspPosition; end?: LspPosition }
type LspDocumentation = string | { kind?: string; value: string } | undefined

/** 纯位置的形状（服务器/前端两侧都按此传递）。 */
export interface PlainPosition {
  line: number
  character: number
}

/** LSP Position → Monaco（0 基 → 1 基）。 */
export function toPosition(pos: LspPosition | undefined): { lineNumber: number; column: number } {
  return { lineNumber: Math.max(1, (pos?.line ?? 0) + 1), column: Math.max(1, (pos?.character ?? 0) + 1) }
}

/** `toRange` 的选项。 */
export interface RangeOptions {
  /**
   * 零宽（start == end）时是否撑开一格，**缺省 true**。
   *
   * 诊断与悬停要撑开：不少服务器把「未使用」「多余导入」报成零宽区间，不撑开就只在上方标尺出现
   * 一个小点、行内看不见波浪线。而**编辑类区间（补全/重命名/格式化）绝不能撑开**——零宽意味着
   * 「插入，不替换任何字符」，撑开一格会让 Monaco 把光标后的字符一起吃掉。
   */
  expandEmpty?: boolean
}

/** LSP Range → Monaco（并按 model 的行列上限夹取）。 */
export function toRange(model: Model, range: LspRange | undefined, opts: RangeOptions = {}): MonacoRange {
  const start = toPosition(range?.start)
  const end = toPosition(range?.end)
  const lastLine = model.getLineCount()
  const clampLine = (n: number): number => Math.min(Math.max(1, n), lastLine)
  const line = clampLine(start.lineNumber)
  const endLine = clampLine(end.lineNumber)
  const maxCol = (l: number): number => model.getLineMaxColumn(l)
  const startColumn = Math.min(start.column, maxCol(line))
  let endColumn = Math.min(end.column, maxCol(endLine))
  // 夹取后可能退化成「末端早于起端」：反转成单点区间，避免 Monaco 报警
  if (endLine < line || (endLine === line && endColumn < startColumn)) {
    return { startLineNumber: line, startColumn, endLineNumber: line, endColumn: startColumn }
  }
  if (opts.expandEmpty !== false && endLine === line && endColumn === startColumn) endColumn = Math.min(startColumn + 1, maxCol(line))
  return { startLineNumber: line, startColumn, endLineNumber: endLine, endColumn }
}

/** 0 基区间 → Monaco 区间（**不**按 model 夹取：跨文件结果属于别的文件）。 */
export function toRangeRaw(range: LspRange | undefined): MonacoRange {
  const start = toPosition(range?.start)
  const end = toPosition(range?.end)
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
}

/**
 * uri 归一键（仅用于「这条结果是不是当前文件」的判定）：解码百分号转义 + 反斜杠归一。
 *
 * 逐字比较不够用：服务器会按自己的规范改写 uri（如 pyright 回 `file:///c%3A/…`）。**只做大小写之外的
 * 归一**——Windows 盘符大小写差异会让比较失败，但那侧的后果只是「不夹取」（按原样给 Monaco，反而安全）。
 */
export function uriKeyOf(uri: string): string {
  const raw = String(uri ?? "").trim()
  let path = raw
  try {
    path = decodeURIComponent(raw)
  } catch {
    /* 有非法转义：保留原样 */
  }
  return path.replace(/\\/g, "/")
}

/** LSP CompletionItemKind → Monaco CompletionItemKind（未知回 Text）。 */
function completionKind(m: Monaco, kind: number | undefined): CompletionItem["kind"] {
  const K = m.languages.CompletionItemKind
  const table: Record<number, number> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable,
    7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value,
    13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference,
    19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator,
    25: K.TypeParameter,
  }
  return (table[kind ?? 1] ?? K.Text) as CompletionItem["kind"]
}

/** documentation（字符串 / MarkupContent）→ Monaco 的 Markdown/纯文本。 */
function documentationOf(doc: LspDocumentation): string | { value: string } | undefined {
  if (doc === undefined) return undefined
  if (typeof doc === "string") return doc
  return { value: doc.value ?? "" }
}

/** MarkupContent / MarkedString / 字符串数组 → Monaco Markdown 字符串。 */
export function hoverContentsOf(contents: unknown): string {
  const one = (c: unknown): string => {
    if (typeof c === "string") return c
    if (c && typeof c === "object") {
      const o = c as { kind?: string; value?: unknown; language?: unknown }
      const value = typeof o.value === "string" ? o.value : ""
      if (o.kind === "markdown") return value
      if (typeof o.language === "string") return `\`\`\`${o.language}\n${value}\n\`\`\``
      return value
    }
    return ""
  }
  if (Array.isArray(contents)) return contents.map(one).filter(Boolean).join("\n\n")
  return one(contents)
}

/** LSP CompletionItem → Monaco CompletionItem。 */
export function toCompletionItem(m: Monaco, model: Model, item: Record<string, unknown>, fallbackRange: MonacoRange): CompletionItem {
  const textEdit = item.textEdit as { range?: LspRange; newText?: string; insert?: LspRange; replace?: LspRange } | undefined
  const editRange = textEdit?.insert ?? textEdit?.replace ?? textEdit?.range
  const insertText = String(textEdit?.newText ?? item.insertText ?? item.label ?? "")
  const format = item.insertTextFormat === 2 ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined
  const label = typeof item.label === "string" ? item.label : String((item.label as { label?: string } | undefined)?.label ?? "")
  const out: CompletionItem = {
    label: label || insertText,
    kind: completionKind(m, item.kind as number | undefined),
    insertText,
    // 编辑区间：零宽即「插入」，撑开一格会吃掉光标后的字符（缺省撑开是给诊断用的）
    range: editRange ? toRange(model, editRange, { expandEmpty: false }) : fallbackRange,
  }
  if (format !== undefined) out.insertTextRules = format
  if (typeof item.detail === "string") out.detail = item.detail
  const doc = documentationOf(item.documentation as LspDocumentation)
  if (doc !== undefined) out.documentation = doc
  if (typeof item.sortText === "string") out.sortText = item.sortText
  if (typeof item.filterText === "string") out.filterText = item.filterText
  if (Array.isArray(item.commitCharacters)) out.commitCharacters = item.commitCharacters.filter((c): c is string => typeof c === "string")
  if (typeof item.preselect === "boolean") out.preselect = item.preselect
  return out
}

/** LSP 文档内容（MarkupContent / MarkedString / 字符串）→ Monaco Markdown。 */
export function toMarkdown(value: unknown): MarkdownString {
  return { value: hoverContentsOf(value) }
}

/** LSP DiagnosticSeverity → Monaco MarkerSeverity。 */
export function toSeverity(m: Monaco, severity: number | undefined): MarkerSeverity {
  const S = m.MarkerSeverity
  switch (severity) {
    case 1:
      return S.Error
    case 2:
      return S.Warning
    case 3:
      return S.Info
    default:
      return S.Hint
  }
}

/** LSP Diagnostic[] → Monaco IMarkerData[]。 */
export function toMarkers(m: Monaco, model: Model, diagnostics: unknown): MarkerData[] {
  if (!Array.isArray(diagnostics)) return []
  const out: MarkerData[] = []
  for (const raw of diagnostics) {
    const d = raw as {
      range?: LspRange
      severity?: number
      message?: unknown
      source?: unknown
      code?: unknown
      codeDescription?: { href?: unknown }
      tags?: unknown
      relatedInformation?: unknown
    }
    if (!d || typeof d !== "object") continue
    const message = typeof d.message === "string" ? d.message : String(d.message ?? "")
    if (!message) continue
    const marker: MarkerData = {
      severity: toSeverity(m, d.severity),
      message,
      ...toRange(model, d.range),
    }
    if (typeof d.source === "string") marker.source = d.source
    const href = typeof d.codeDescription?.href === "string" ? d.codeDescription.href : ""
    if (href && (typeof d.code === "string" || typeof d.code === "number")) {
      // 带文档链接的诊断码：Monaco 会把它渲染成可见链接（如「点击查看规则说明」）
      try {
        marker.code = { value: String(d.code), target: m.Uri.parse(href) }
      } catch {
        marker.code = String(d.code)
      }
    } else if (typeof d.code === "string" || typeof d.code === "number") {
      marker.code = String(d.code)
    }
    // LSP DiagnosticTag：1=Unnecessary（未使用/多余）、2=Deprecated——Monaco 据此弱化显示
    if (Array.isArray(d.tags)) {
      const tags = d.tags
        .map((t) => (t === 1 ? m.MarkerTag.Unnecessary : t === 2 ? m.MarkerTag.Deprecated : 0))
        .filter((t): t is MarkerTag => t !== 0)
      if (tags.length) marker.tags = tags
    }
    // 相关信息（如「变量在此处声明」）：Monaco 在标记浮层里逐条列出并可点击
    if (Array.isArray(d.relatedInformation)) {
      const rel: NonNullable<MarkerData["relatedInformation"]> = []
      for (const item of d.relatedInformation as Array<{ location?: { uri?: unknown; range?: LspRange }; message?: unknown }>) {
        const uri = item?.location?.uri
        const text = typeof item?.message === "string" ? item.message : ""
        if (typeof uri !== "string" || !text) continue
        try {
          rel.push({ resource: m.Uri.parse(uri), message: text, ...toRangeRaw(item.location?.range) })
        } catch {
          /* uri 非法：跳过该条 */
        }
      }
      if (rel.length) marker.relatedInformation = rel
    }
    out.push(marker)
  }
  return out
}

/**
 * LSP Location / LocationLink（uri 由服务端保留为 file://）→ Monaco Location。
 *
 * `sameUri` 给当前文档的 uri：**命中才按本文夹取**。跨文件结果若也按当前文件夹取，被跳去的文件更短时
 * 行号会被压到本文末行——「跳过去却停在一处无关的代码」正是这个 bug 的表现。
 */
export function toLocations(m: Monaco, model: Model, result: unknown, sameUri?: string): Location[] {
  const list = Array.isArray(result) ? result : result ? [result] : []
  const mine = sameUri ? uriKeyOf(sameUri) : ""
  const out: Location[] = []
  for (const raw of list) {
    const loc = raw as { uri?: string; targetUri?: string; range?: LspRange; targetSelectionRange?: LspRange; targetRange?: LspRange }
    if (!loc || typeof loc !== "object") continue
    const uri = loc.uri ?? loc.targetUri
    if (typeof uri !== "string") continue
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
    const sameFile = mine !== "" && uriKeyOf(uri) === mine
    out.push({ uri: m.Uri.parse(uri), range: sameFile ? toRange(model, range) : toRangeRaw(range) })
  }
  return out
}

/** LSP TextEdit[]（格式化 / 重命名结果）→ 区间的 0 基形态（调用方决定怎么落）。 */
export function toTextEdits(textEdits: unknown): Array<{ range: LspRange; text: string }> {
  if (!Array.isArray(textEdits)) return []
  return textEdits
    .map((raw) => raw as { range?: LspRange; newText?: unknown })
    .filter((e) => e && typeof e === "object" && typeof e.newText === "string")
    .map((e) => ({ range: e.range ?? {}, text: String(e.newText) }))
}

/* ------------------------------ 文档符号（大纲） ------------------------------ */

/** LSP `SymbolKind`（与 Monaco 的 `SymbolKind` 取值完全相同：1 File … 26 TypeParameter）。 */
export function isLspSymbolKind(kind: unknown): kind is number {
  return typeof kind === "number" && kind >= 1 && kind <= 26
}

/** LSP `SymbolKind` → 工作台的 `SymKind`（面板胶囊标签与图标用；无对应项回 function）。 */
export function lspKindToSymKind(kind: number): SymKind {
  switch (kind) {
    case 1:
      return "module" // File：就近映射
    case 2:
      return "module"
    case 3:
      return "namespace"
    case 4:
      return "package"
    case 5:
      return "class"
    case 6:
      return "method"
    case 7:
      return "property"
    case 8:
      return "field"
    case 9:
      return "constructor"
    case 10:
      return "enum"
    case 11:
      return "interface"
    case 12:
      return "function"
    case 13:
      return "variable"
    case 14:
      return "constant"
    case 15:
    case 16:
    case 17:
    case 21:
      return "constant" // String / Number / Boolean / Null：字面量类
    case 18:
    case 19:
      return "object"
    case 20:
      return "key"
    case 22:
      return "enumMember"
    case 23:
      return "struct"
    case 24:
      return "event"
    case 25:
      return "function" // Operator：无对应图标，就近
    case 26:
      return "type"
    default:
      return "function"
  }
}

/** 中间形态的符号树（LSP `DocumentSymbol` / 扁平 `SymbolInformation` 归一后的结果）。 */
export interface LspSym {
  name: string
  detail: string
  /** LSP SymbolKind（原样保留，Monaco 图标直接用它） */
  kind: number
  /** 0 基名字行 */
  line: number
  /** 0 基名字列 */
  column: number
  /** 0 基名字末行（多行符号名少见，仍按服务器给的范围） */
  endLine: number
  endColumn: number
  /** 整个符号的范围（0 基，末列为排他）——Monaco 的 `range` 用它的 1 基形态 */
  rangeLine: number
  rangeEndLine: number
  children: LspSym[]
}

function symFromLsp(raw: Record<string, unknown>): LspSym | null {
  const name = typeof raw.name === "string" ? raw.name : ""
  if (!name) return null
  const sel = (raw.selectionRange ?? raw.range ?? {}) as LspRange
  const range = (raw.range ?? raw.selectionRange ?? {}) as LspRange
  const start = sel.start ?? {}
  const end = sel.end ?? {}
  const kind = isLspSymbolKind(raw.kind) ? raw.kind : 12
  const children: LspSym[] = []
  if (Array.isArray(raw.children)) {
    for (const c of raw.children as Record<string, unknown>[]) {
      const child = symFromLsp(c ?? {})
      if (child) children.push(child)
    }
  }
  return {
    name,
    detail: typeof raw.detail === "string" ? raw.detail : "",
    kind,
    line: Math.max(0, start.line ?? 0),
    column: Math.max(0, start.character ?? 0),
    endLine: Math.max(0, end.line ?? start.line ?? 0),
    endColumn: Math.max(0, end.character ?? start.character ?? 0),
    rangeLine: Math.max(0, range.start?.line ?? start.line ?? 0),
    rangeEndLine: Math.max(0, range.end?.line ?? start.line ?? 0),
    children,
  }
}

/**
 * LSP 文档符号 → 中间树。两种历史形态都收：
 * - `DocumentSymbol[]`（层级，声明了 `hierarchicalDocumentSymbolSupport` 的服务器都用它）；
 * - `SymbolInformation[]`（扁平，带 `location` 与 `containerName`）——没有层级，按 `containerName` 归一层。
 * 都没有/为空返回 null（调用方回退本地提取）。
 */
export function toLspSymTree(result: unknown): LspSym[] | null {
  if (!Array.isArray(result)) return null
  const flat = result.some((r) => (r as { location?: unknown })?.location !== undefined)
  if (!flat) {
    const tree: LspSym[] = []
    for (const raw of result) {
      const sym = symFromLsp((raw ?? {}) as Record<string, unknown>)
      if (sym) tree.push(sym)
    }
    return tree.length ? tree : null
  }
  const roots: LspSym[] = []
  const byName = new Map<string, LspSym>()
  for (const raw of result) {
    const o = (raw ?? {}) as Record<string, unknown>
    const loc = (o.location ?? {}) as { range?: LspRange }
    const container = typeof o.containerName === "string" ? o.containerName : ""
    const node: LspSym | null = symFromLsp({ name: o.name, kind: o.kind, selectionRange: loc.range, range: loc.range })
    if (!node) continue
    const parent = container ? byName.get(container) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
      if (!byName.has(node.name)) byName.set(node.name, node)
    }
  }
  return roots.length ? roots : null
}

/** LSP 符号树 → Monaco 文档符号（kind 直通：两套枚举取值一一对应）。 */
export function toDocumentSymbols(
  model: Model,
  syms: readonly LspSym[],
): import("monaco-editor").languages.DocumentSymbol[] {
  const lastLine = model.getLineCount()
  const clampLine = (n: number): number => Math.min(Math.max(1, n), lastLine)
  return syms.map((s) => {
    const line = clampLine(s.line + 1)
    const rangeLine = clampLine(s.rangeLine + 1)
    const rangeEndLine = clampLine(s.rangeEndLine + 1)
    return {
      name: s.name,
      detail: s.detail,
      kind: s.kind as import("monaco-editor").languages.SymbolKind,
      tags: [],
      range: { startLineNumber: rangeLine, startColumn: 1, endLineNumber: Math.max(rangeLine, rangeEndLine), endColumn: 1 },
      selectionRange: {
        startLineNumber: line,
        startColumn: Math.max(1, s.column + 1),
        endLineNumber: Math.max(line, clampLine(s.endLine + 1)),
        endColumn: Math.max(s.column + 1, s.endColumn + 1),
      },
      children: toDocumentSymbols(model, s.children),
    }
  })
}

/** LSP 符号树 → 面板用的扁平列表（带全限定名与层级）。 */
export function toPanelSymbols(syms: readonly LspSym[]): FlatSym[] {
  const out: FlatSym[] = []
  const walk = (list: readonly LspSym[], depth: number, prefix: string): void => {
    for (const s of list) {
      out.push({
        name: s.name,
        qualified: prefix ? `${prefix}.${s.name}` : s.name,
        kind: lspKindToSymKind(s.kind),
        line: s.line,
        column: s.column,
        depth,
      })
      walk(s.children, depth + 1, prefix ? `${prefix}.${s.name}` : s.name)
    }
  }
  walk(syms, 0, "")
  return out
}
