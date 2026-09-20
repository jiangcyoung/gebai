/**
 * 文件工作台 · LSP ↔ Monaco 类型转换（纯函数，便于单独阅读与推演）。
 *
 * 两侧的差异都在这里收口：
 * - 位置/区间：LSP 行列从 **0** 起，Monaco 从 **1** 起；LSP 的 `end` 是排他的，与 Monaco 一致；
 * - 补全项：`CompletionItemKind` 是两套枚举，需查表；`insertTextFormat`（snippet）映射到 Monaco 的
 *   `insertTextRules`；`documentation` 可能是字符串或 `MarkupContent`；
 * - 悬停：`contents` 有四种历史形态（字符串 / MarkupContent / MarkedString / 数组）；
 * - 诊断：severity 1..4 与 Monaco 的 MarkerSeverity 一一对应（Error/Warning/Info/Hint）。
 *
 * 越界防护：服务器给出的区间可能属于改动前的内容（诊断与编辑竞争），一律做 clamp——
 * Monaco 收到越界区间会抛错，宁可把标记夹到合法范围。
 */

type Monaco = typeof import("monaco-editor")
type Model = import("monaco-editor").editor.ITextModel
type MonacoRange = import("monaco-editor").IRange
type CompletionItem = import("monaco-editor").languages.CompletionItem
type MarkerData = import("monaco-editor").editor.IMarkerData
type MarkerSeverity = import("monaco-editor").MarkerSeverity
type MarkdownString = import("monaco-editor").IMarkdownString
type Location = import("monaco-editor").languages.Location

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

/** LSP Range → Monaco（并按 model 的行列上限夹取）。 */
export function toRange(model: Model, range: LspRange | undefined): MonacoRange {
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
  if (endLine === line && endColumn === startColumn) endColumn = Math.min(startColumn + 1, maxCol(line))
  return { startLineNumber: line, startColumn, endLineNumber: endLine, endColumn }
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
    range: editRange ? toRange(model, editRange) : fallbackRange,
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
    const d = raw as { range?: LspRange; severity?: number; message?: unknown; source?: unknown; code?: unknown }
    if (!d || typeof d !== "object") continue
    const message = typeof d.message === "string" ? d.message : String(d.message ?? "")
    if (!message) continue
    const marker: MarkerData = {
      severity: toSeverity(m, d.severity),
      message,
      ...toRange(model, d.range),
    }
    if (typeof d.source === "string") marker.source = d.source
    if (typeof d.code === "string" || typeof d.code === "number") marker.code = String(d.code)
    out.push(marker)
  }
  return out
}

/** LSP Location / LocationLink（uri 由服务端保留为 file://）→ Monaco Location。 */
export function toLocations(m: Monaco, model: Model, result: unknown): Location[] {
  const list = Array.isArray(result) ? result : result ? [result] : []
  const out: Location[] = []
  for (const raw of list) {
    const loc = raw as { uri?: string; targetUri?: string; range?: LspRange; targetSelectionRange?: LspRange; targetRange?: LspRange }
    if (!loc || typeof loc !== "object") continue
    const uri = loc.uri ?? loc.targetUri
    if (typeof uri !== "string") continue
    const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange
    out.push({ uri: m.Uri.parse(uri), range: toRange(model, range) })
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
