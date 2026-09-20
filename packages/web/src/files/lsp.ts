/**
 * 文件工作台 · 语言服务器（LSP）客户端：文档同步 + Monaco provider 注册 + 诊断落地。
 *
 * 与内置语言服务的分工（见 `symbols.ts` 的说明）：TypeScript / JavaScript / JSON / CSS / HTML 由 Monaco
 * 自带 worker 提供，仓库**不**给它们起外部服务器；其余语言若本机 PATH 上探到服务器（gopls /
 * rust-analyzer / clangd / pyright-langserver …），本模块接管补全、悬停、跳转、引用、重命名、格式化与诊断。
 *
 * 三条不变量：
 * 1. **没有 LSP 一切照旧**：清单为空即不注册任何 provider、不建连接，工作台行为与从前完全一致；
 * 2. **文档同步以服务端为准**：前端只认 `docId`（它不知道绝对路径），变更一律发全文（对 LSP 的
 *    Full/Incremental 两种模式都合法），debounce 收敛高频键入；
 * 3. **诊断是推送**：服务器随时可能推 `publishDiagnostics`，按 `docId` 找到 model 后整体替换 markers。
 *
 * 跳转到其它文件：服务器返回的是 `file://` uri，`registerEditorOpener` 把它折算回「本工作台的根 +
 * 相对路径」再交给工作台打开标签（未打开的文件也能跳，而不是 Monaco 默认的静默失败）。
 */

import { appPath } from "@gebai/sdk"
import { WorkbenchSocket, readAuthToken } from "./ws-client"
import {
  toCompletionItem,
  toLocations,
  toMarkers,
  toMarkdown,
  toPosition,
  toRange,
  toTextEdits,
} from "./lsp-convert"

type Monaco = typeof import("monaco-editor")
type Model = import("monaco-editor").editor.ITextModel
type Position = import("monaco-editor").Position

/** 服务器清单响应（`GET /api/v1/lsp/servers`）。 */
interface ServerListResp {
  enabled: boolean
  reason?: string
  servers?: Array<{ language: string; id: string; command: string; args: string[] }>
  missing?: Array<{ language: string; id: string; command: string }>
  errors?: string[]
}

/** 打开的 LSP 文档（model ↔ docId ↔ 服务器）。 */
interface AttachedDoc {
  docId: string
  model: Model
  serverId: string
  /** 服务器报告的同步模式：0=不推变更 / 1=全量 / 2=增量（前端一律发全文）。 */
  sync: number
  /** 会话根（root id 与其绝对路径：把响应里的 file:// uri 折算回工作台路径用）。 */
  rootId: string
  rootAbs: string
  path: string
  language: string
  markerOwner: string
  /** 变更上报的 debounce 定时器。 */
  timer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

interface LspState {
  enabled: boolean
  reason: string
  /** 有可用服务器的语言（Monaco 语言 id）。 */
  languages: Set<string>
  /** 语言 → 服务器标识（状态栏显示用）。 */
  byLanguage: Map<string, string>
  /** 启动了服务器进程的文档数（状态/诊断用）。 */
  attached: number
}

const state: LspState = { enabled: false, reason: "", languages: new Set(), byLanguage: new Map(), attached: 0 }

let initPromise: Promise<void> | null = null
/** 清单是否已**成功**（含服务端明确回 `enabled:false`）——失败（网络/超时）时保持 false 以便重试。 */
let settled = false
let socket: WorkbenchSocket | null = null
let monacoRef: Monaco | null = null
let installed = false
let sessionProvider: () => string | undefined = () => undefined
let opener: ((target: { rootId: string; path: string; line: number; column?: number }) => void) | null = null

const docs = new Map<string, AttachedDoc>()
const byModel = new Map<Model, AttachedDoc>()
const logTail: string[] = []

/** 变更上报节流（毫秒）：低于此间隔的连续键入合并为一次 didChange。 */
const CHANGE_DEBOUNCE_MS = 220

/** 语言服务器是否可用（清单非空且服务端开启）。 */
export function lspEnabled(): boolean {
  return state.enabled && state.languages.size > 0
}

/** 有可用服务器的语言集合（`symbols.ts` 据此让位，避免同一跳转出现两份候选）。 */
export function lspLanguages(): Set<string> {
  return state.languages
}

/** 某语言的服务器标识（状态栏显示；无则空串）。 */
export function lspServerOf(language: string): string {
  return state.byLanguage.get(String(language ?? "").toLowerCase()) ?? ""
}

/** 未探测到服务器时的原因（设置面板/诊断用）。 */
export function lspReason(): string {
  return state.reason
}

/** 最近服务器日志（stderr / window/logMessage；诊断用，最多 50 条）。 */
export function lspLogTail(): string[] {
  return [...logTail]
}

/** 会话 id 提供者（`sess:` 根解析与审计用）。 */
export function setLspSessionProvider(fn: () => string | undefined): void {
  sessionProvider = fn
}

/** 跨文件跳转的落地回调（由工作台注册：打开目标文件的标签并定位）。 */
export function setLspOpener(fn: (target: { rootId: string; path: string; line: number; column?: number }) => void): void {
  opener = fn
}

/**
 * 拉取本机可用服务器清单（一次；**网络类失败允许下次重试**）。
 * 工作台在预热 Monaco 之前调用它：符号 provider 的分工（有 LSP 的语言让位）依赖这份清单。
 * 返回的 Promise 不抛错（失败视为无 LSP，绝不阻塞打开文件）。
 */
export function initLsp(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const token = readAuthToken()
      const url = new URL(appPath("/api/v1/lsp/servers"), location.origin)
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 5000)
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctl.signal })
      clearTimeout(timer)
      if (!res.ok) {
        // 确定性拒绝（404 页面关闭 / 403 沙箱）：本页不再重试
        state.reason = res.status === 403 ? "沙箱模式下不开放语言服务器" : `清单请求失败（HTTP ${res.status}）`
        return
      }
      const body = (await res.json()) as ServerListResp
      state.enabled = body.enabled !== false
      state.reason = body.reason ?? ""
      for (const s of body.servers ?? []) {
        const language = String(s.language ?? "").toLowerCase()
        if (!language) continue
        state.languages.add(language)
        state.byLanguage.set(language, s.id)
      }
      if (!state.enabled) state.reason = body.reason ?? "语言服务器未启用"
      settled = true
    } catch {
      /* 网络波动 / 超时：本次当无 LSP，但**不固化**——下次打开文件会重新拉一次 */
      state.reason = "无法获取语言服务器清单"
    } finally {
      // Monaco 可能先就绪（用户在清单到达前就打开了文件）：补装一次 provider
      if (monacoRef && state.languages.size) installLspProviders(monacoRef)
      if (!settled) initPromise = null
    }
  })()
  return initPromise
}

/** 该语言是否有可用服务器。 */
export function hasLsp(language: string): boolean {
  return lspEnabled() && state.languages.has(String(language ?? "").toLowerCase())
}

function sock(): WorkbenchSocket {
  if (!socket) {
    socket = new WorkbenchSocket({ label: "语言服务器", context: () => sessionProvider(), timeoutMs: 20000 })
    socket.on("lsp.notify", onServerNotify)
    socket.on("lsp.exit", onServerExit)
    socket.on("lsp.log", onServerLog)
  }
  return socket
}

/**
 * 打开文档并建立同步（打开文件成功后调用；失败/无服务器时静默返回 null）。
 * 返回服务器标识（供状态栏显示），无 LSP 时返回 null。
 */
export async function attachDocument(input: { model: Model; rootId: string; path: string; language: string }): Promise<string | null> {
  // 清单可能尚未到达（deep link / 记忆恢复会在启动早期就打开文件）：这里等一次，
  // 否则首次打开的文件永远挂不上（清单是一次性拉取，不会再触发挂载）
  await initLsp()
  if (!hasLsp(input.language)) return null
  const model = input.model
  const previous = byModel.get(model)
  if (previous && !previous.disposed) detachDocument(model)
  const res = await sock().request("lsp.open", {
    root: input.rootId,
    path: input.path,
    language: input.language,
    text: model.getValue(),
    version: model.getVersionId(),
  })
  if (!res.ok) return null
  const payload = res.payload ?? {}
  if (payload.available === false) return null
  const docId = String(payload.docId ?? "")
  if (!docId) return null
  const serverObj = (payload.server ?? {}) as { id?: string; command?: string }
  const rootObj = (payload.root ?? {}) as { id?: string; abs?: string }
  const serverId = String(serverObj.id ?? state.byLanguage.get(input.language) ?? "lsp")
  const doc: AttachedDoc = {
    docId,
    model,
    serverId,
    sync: Number(payload.sync ?? 1),
    rootId: String(rootObj.id ?? input.rootId),
    rootAbs: String(rootObj.abs ?? ""),
    path: input.path,
    language: input.language,
    markerOwner: `lsp:${serverId}`,
    timer: null,
    disposed: false,
  }
  docs.set(docId, doc)
  byModel.set(model, doc)
  state.attached = docs.size
  // 键入 → 节流上报全文（服务端按同步模式决定是否下发 didChange）
  const changeSub = model.onDidChangeContent(() => {
    if (doc.sync === 0 || doc.disposed) return
    if (doc.timer) clearTimeout(doc.timer)
    doc.timer = setTimeout(() => {
      doc.timer = null
      if (doc.disposed) return
      sock().send("lsp.change", { docId: doc.docId, version: doc.model.getVersionId(), text: doc.model.getValue() })
    }, CHANGE_DEBOUNCE_MS)
  })
  model.onWillDispose(() => {
    changeSub.dispose()
    if (!doc.disposed) detachDocument(model)
  })
  return serverId
}

/** 关闭文档（标签关闭 / 切换语言服务）：通知服务器并清掉该文件的诊断标记。 */
export function detachDocument(model: Model): void {
  const doc = byModel.get(model)
  if (!doc) return
  doc.disposed = true
  if (doc.timer) clearTimeout(doc.timer)
  byModel.delete(model)
  docs.delete(doc.docId)
  state.attached = docs.size
  try {
    monacoRef?.editor.setModelMarkers(model, doc.markerOwner, [])
  } catch {
    /* model 已销毁 */
  }
  sock().send("lsp.close", { docId: doc.docId })
}

/** 保存后通知服务器（触发重新诊断）；文件内容已由工作台写入磁盘。 */
export function notifySaved(model: Model): void {
  const doc = byModel.get(model)
  if (!doc || doc.disposed) return
  sock().send("lsp.save", { docId: doc.docId, text: model.getValue() })
}

/** 当前文档挂到了哪个服务器（状态栏用；未挂返回空串）。 */
export function attachedServerOf(model: Model | null | undefined): string {
  if (!model) return ""
  return byModel.get(model)?.serverId ?? ""
}

/* ------------------------------ Monaco provider 注册 ------------------------------ */

/**
 * 注册 LSP provider（幂等）：只在**存在可用服务器**时注册，且按语言 selector 限定——
 * 没有服务器（清单为空、探测失败、`GEBAI_LSP=false`）时本函数直接返回，工作台一切照旧。
 *
 * 清单是异步拉取的，两条路径都会收敛到这里：Monaco 就绪时若清单已到就装；清单后到则由
 * `initLsp` 在末尾补装（`monacoRef` 已记下内核引用）。
 */
export function installLspProviders(m: Monaco): void {
  monacoRef = m
  if (installed) return
  const langs = [...state.languages]
  if (!langs.length) return
  installed = true
  m.languages.registerCompletionItemProvider(langs, { provideCompletionItems })
  m.languages.registerHoverProvider(langs, { provideHover })
  m.languages.registerDefinitionProvider(langs, { provideDefinition })
  m.languages.registerReferenceProvider(langs, { provideReferences })
  m.languages.registerRenameProvider(langs, { provideRenameEdits })
  m.languages.registerDocumentFormattingEditProvider(langs, { provideDocumentFormattingEdits })
  m.languages.registerSignatureHelpProvider(langs, { provideSignatureHelp })
  // 跨文件跳转：把服务器给的 file:// uri 折算回「工作台的根 + 相对路径」再交给工作台开标签
  m.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selectionOrPosition) => openResource(resource, selectionOrPosition),
  })
}

/** Monaco 位置（1 基）→ LSP 位置（0 基）。 */
function lspPos(p: Position): { line: number; character: number } {
  return { line: Math.max(0, p.lineNumber - 1), character: Math.max(0, p.column - 1) }
}

/** 0 基区间 → Monaco 区间（**不**按 model 夹取：跨文件结果属于别的文件）。 */
function toRangeRaw(range: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } | undefined): import("monaco-editor").IRange {
  const start = toPosition(range?.start)
  const end = toPosition(range?.end)
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }
}

/** 发一条 LSP 请求（文档未挂载 / 服务器未运行时返回 null，调用方静默降级）。 */
async function lspRequest<T>(model: Model, method: string, params: Record<string, unknown>): Promise<T | null> {
  const doc = byModel.get(model)
  if (!doc || doc.disposed) return null
  const res = await sock().request("lsp.request", {
    docId: doc.docId,
    method,
    params: { textDocument: { uri: doc.docId }, ...params },
  })
  if (!res.ok) return null
  return ((res.payload?.result ?? null) as T | null)
}

async function provideCompletionItems(model: Model, position: Position): Promise<import("monaco-editor").languages.CompletionList> {
  const m = monacoRef
  if (!m) return { suggestions: [] }
  const result = await lspRequest<unknown>(model, "textDocument/completion", { position: lspPos(position) })
  const items = Array.isArray(result) ? result : ((result as { items?: unknown[] } | null)?.items ?? [])
  const word = model.getWordUntilPosition(position)
  const fallbackRange: import("monaco-editor").IRange = {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  }
  return {
    suggestions: (items as Record<string, unknown>[]).map((item) => toCompletionItem(m, model, item, fallbackRange)),
  }
}

async function provideHover(model: Model, position: Position): Promise<import("monaco-editor").languages.Hover | null> {
  const result = await lspRequest<{ contents?: unknown; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }>(
    model,
    "textDocument/hover",
    { position: lspPos(position) },
  )
  if (!result) return null
  const md = toMarkdown(result.contents)
  if (!md.value) return null
  return result.range ? { contents: [md], range: toRange(model, result.range) } : { contents: [md] }
}

async function provideDefinition(model: Model, position: Position): Promise<import("monaco-editor").languages.Location[] | null> {
  const m = monacoRef
  if (!m) return null
  const result = await lspRequest<unknown>(model, "textDocument/definition", { position: lspPos(position) })
  const locs = toLocations(m, model, result)
  return locs.length ? locs : null
}

async function provideReferences(
  model: Model,
  position: Position,
  context: import("monaco-editor").languages.ReferenceContext,
): Promise<import("monaco-editor").languages.Location[] | null> {
  const m = monacoRef
  if (!m) return null
  const result = await lspRequest<unknown>(model, "textDocument/references", {
    position: lspPos(position),
    context: { includeDeclaration: context.includeDeclaration },
  })
  const locs = toLocations(m, model, result)
  return locs.length ? locs : null
}

async function provideRenameEdits(
  model: Model,
  position: Position,
  newName: string,
): Promise<import("monaco-editor").languages.WorkspaceEdit | null> {
  const m = monacoRef
  if (!m) return null
  const result = await lspRequest<{ changes?: Record<string, unknown> }>(model, "textDocument/rename", {
    position: lspPos(position),
    newName,
  })
  if (!result?.changes) return null
  const edits: Array<{ resource: import("monaco-editor").Uri; textEdit: { range: import("monaco-editor").IRange; text: string }; versionId: number | undefined }> = []
  for (const [uri, list] of Object.entries(result.changes)) {
    const sameFile = uri === byModel.get(model)?.docId || uri.endsWith(encodeURI(byModel.get(model)?.path ?? "\u0000"))
    for (const edit of toTextEdits(list)) {
      edits.push({
        resource: m.Uri.parse(uri.startsWith("file:") ? uri : m.Uri.parse(uri).toString()),
        textEdit: { range: sameFile ? toRange(model, edit.range) : toRangeRaw(edit.range), text: edit.text },
        versionId: undefined,
      })
    }
  }
  return edits.length ? { edits } : null
}

async function provideDocumentFormattingEdits(
  model: Model,
  options: import("monaco-editor").languages.FormattingOptions,
): Promise<import("monaco-editor").languages.TextEdit[]> {
  const result = await lspRequest<unknown>(model, "textDocument/formatting", {
    options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
  })
  return toTextEdits(result).map((edit) => ({ range: toRange(model, edit.range), text: edit.text }))
}

async function provideSignatureHelp(
  model: Model,
  position: Position,
  _token: import("monaco-editor").CancellationToken,
  context: import("monaco-editor").languages.SignatureHelpContext,
): Promise<import("monaco-editor").languages.SignatureHelpResult | null> {
  const result = await lspRequest<{ signatures?: unknown[]; activeSignature?: number; activeParameter?: number }>(
    model,
    "textDocument/signatureHelp",
    {
      position: lspPos(position),
      context: {
        triggerKind: context.triggerKind,
        triggerCharacter: context.triggerCharacter,
        isRetrigger: context.isRetrigger,
      },
    },
  )
  if (!result?.signatures?.length) return null
  const signatures = (result.signatures as Record<string, unknown>[]).map((sig) => ({
    label: typeof sig.label === "string" ? sig.label : "",
    documentation: sig.documentation === undefined ? undefined : toMarkdown(sig.documentation),
    parameters: Array.isArray(sig.parameters)
      ? (sig.parameters as Record<string, unknown>[]).map((p) => ({
          label: typeof p.label === "string" || Array.isArray(p.label) ? (p.label as string | [number, number]) : "",
          documentation: p.documentation === undefined ? undefined : toMarkdown(p.documentation),
        }))
      : [],
  }))
  return {
    value: {
      signatures,
      activeSignature: result.activeSignature ?? 0,
      activeParameter: result.activeParameter ?? 0,
    },
    dispose: () => {
      /* 无资源可释放 */
    },
  }
}

/* ------------------------------ 跨文件跳转与服务器事件 ------------------------------ */

/** file:// uri → 本工作台的根 + 相对路径（取最长匹配根；不匹配返回 null）。 */
function mapUri(uri: import("monaco-editor").Uri): { rootId: string; path: string } | null {
  if (uri.scheme !== "file") return null
  const abs = decodeURIComponent(uri.path).replace(/^\//, "")
  const norm = (p: string): string => p.replace(/\\/g, "/")
  const target = norm(abs).toLowerCase()
  let best: AttachedDoc | null = null
  for (const doc of docs.values()) {
    if (!doc.rootAbs) continue
    const root = norm(doc.rootAbs).toLowerCase().replace(/\/+$/, "")
    if (!target.startsWith(`${root}/`)) continue
    if (!best || root.length > norm(best.rootAbs).length) best = doc
  }
  if (!best) return null
  const rootLen = norm(best.rootAbs).replace(/\/+$/, "").length
  return { rootId: best.rootId, path: norm(abs).slice(rootLen + 1) }
}

/** 编辑器打开外部 uri 的落地：折算成工作台路径后交给 `opener`。 */
function openResource(resource: import("monaco-editor").Uri, selection: unknown): boolean {
  if (!opener) return false
  const target = mapUri(resource)
  if (!target) return false
  const pos = selection as { lineNumber?: number; column?: number; startLineNumber?: number; startColumn?: number } | undefined
  opener({
    rootId: target.rootId,
    path: target.path,
    line: pos?.startLineNumber ?? pos?.lineNumber ?? 1,
    column: pos?.startColumn ?? pos?.column ?? 1,
  })
  return true
}

/** 服务器推送：诊断整体替换该文档的 markers（owner 按服务器区分，互不干扰）。 */
function onServerNotify(payload: Record<string, unknown>): void {
  if (String(payload.method ?? "") !== "textDocument/publishDiagnostics") return
  const doc = docs.get(String(payload.docId ?? ""))
  const m = monacoRef
  if (!doc || doc.disposed || !m) return
  const params = (payload.params ?? {}) as { diagnostics?: unknown }
  try {
    m.editor.setModelMarkers(doc.model, doc.markerOwner, toMarkers(m, doc.model, params.diagnostics))
  } catch {
    /* model 已销毁（标签刚关）：忽略 */
  }
}

/** 服务器进程退出：清诊断 + 记日志 + 限频重连一次（避免启动即崩的服务器引发重连风暴）。 */
function onServerExit(payload: Record<string, unknown>): void {
  const m = monacoRef
  const server = String(payload.server ?? "")
  const code = payload.code === null || payload.code === undefined ? "" : ` code=${String(payload.code)}`
  log(`[${server || "lsp"}] 语言服务器已退出${code}`)
  if (!m) return
  for (const doc of [...docs.values()]) {
    if (server && doc.serverId !== server) continue
    try {
      m.editor.setModelMarkers(doc.model, doc.markerOwner, [])
    } catch {
      /* model 已销毁 */
    }
    if (!server || !restartable(server)) continue
    const { model, rootId, path, language } = doc
    detachDocument(model)
    void attachDocument({ model, rootId, path, language })
  }
}

const lastRestart = new Map<string, number>()
/** 同一服务器 30s 内只自动重连一次。 */
function restartable(server: string): boolean {
  const now = Date.now()
  const prev = lastRestart.get(server) ?? 0
  if (now - prev < 30000) return false
  lastRestart.set(server, now)
  return true
}

function onServerLog(payload: Record<string, unknown>): void {
  log(String(payload.text ?? ""))
}

function log(text: string): void {
  const line = text.trim()
  if (!line) return
  logTail.push(line)
  if (logTail.length > 50) logTail.shift()
}
