/**
 * 文件工作台 · LSP **能力协商**判定（纯函数，便于单测）。
 *
 * 两个来源的「这个请求值不值得发」：
 * - **服务器声明的能力表**（initialize 应答里的 `capabilities`）：未声明即不提供，不发；
 * - **服务器回过 method not found**（JSON-RPC -32601）：已问过就不再问。
 *
 * 为什么值得单拉一层：能力表是**服务器自述**，而各家服务器都有出入——实测 gopls 0.21 的
 * `rangeFormatting` 与 `completionItem/resolve` 都不实现（直接回 -32601），clangd 的
 * `completionProvider.resolveProvider` 是 `false`。不做这层协商，这些请求换回来的只有
 * 一堆看不出所以然的错误，Monaco 那侧看到的则是「空结果」。
 *
 * 保守原则：**能力表为空（服务器没给）时一律放行**——不凭「没声明」推断「不支持」，
 * 否则会把那些能力表写得不全的服务器一刀切掉。
 */

/** LSP 请求方法 → 服务器能力字段（`ServerCapabilities` 的键）。 */
export const METHOD_CAPABILITY: Record<string, string> = {
  "textDocument/completion": "completionProvider",
  "completionItem/resolve": "completionProvider",
  "textDocument/hover": "hoverProvider",
  "textDocument/definition": "definitionProvider",
  "textDocument/references": "referencesProvider",
  "textDocument/rename": "renameProvider",
  "textDocument/formatting": "documentFormattingProvider",
  "textDocument/rangeFormatting": "documentRangeFormattingProvider",
  "textDocument/signatureHelp": "signatureHelpProvider",
  "textDocument/documentSymbol": "documentSymbolProvider",
}

/** `completionItem/resolve` 还要看 `completionProvider.resolveProvider`（对象形态的子开关）。 */
const RESOLVE_METHOD = "completionItem/resolve"

/** 该方法的服务器能力字段（无需协商的方法返回 undefined）。 */
export function capabilityOfMethod(method: string): string | undefined {
  return METHOD_CAPABILITY[method]
}

/**
 * 服务器是否声明支持该方法。
 *
 * - 能力表为空 / 不是对象 → true（服务器没给能力表，不凭空假设不支持）；
 * - 能力字段缺失、为 `false` 或 `null` → false（明确未声明）；
 * - `completionItem/resolve` 额外要求 `completionProvider.resolveProvider === true`
 *   （gopls / clangd 都把它设为 false 或不给）。
 */
export function supportsMethod(capabilities: Record<string, unknown> | undefined, method: string): boolean {
  if (!capabilities || typeof capabilities !== "object") return true
  const keys = Object.keys(capabilities)
  if (keys.length === 0) return true
  const field = capabilityOfMethod(method)
  if (!field) return true
  const value = capabilities[field]
  if (value === undefined || value === null || value === false) return false
  if (method === RESOLVE_METHOD) {
    const provider = value as { resolveProvider?: unknown }
    return provider?.resolveProvider === true
  }
  return true
}

/** 请求失败信息是否表示「服务器不认这个方法」（JSON-RPC -32601）——只认它，超时/临时故障不记。 */
export function isMethodNotFoundError(error: string | undefined): boolean {
  return typeof error === "string" && /-32601/.test(error)
}

/**
 * 「本页不再问这个方法」的登记表（服务器标识 → 方法集合）。
 * 一个页面会话内有效：服务器**重启后能力可能变化**（升级/换配置），不该跨会话固化。
 */
export class UnsupportedMethods {
  private byServer = new Map<string, Set<string>>()

  has(serverId: string, method: string): boolean {
    return this.byServer.get(serverId)?.has(method) === true
  }

  /** 记下（仅当错误确为 -32601）；返回是否新记入。 */
  note(serverId: string, method: string, error: string | undefined): boolean {
    if (!isMethodNotFoundError(error)) return false
    const set = this.byServer.get(serverId) ?? new Set<string>()
    if (set.has(method)) return false
    set.add(method)
    this.byServer.set(serverId, set)
    return true
  }

  /** 服务器重启（换进程/换能力）时清掉它的记录。 */
  clear(serverId: string): void {
    this.byServer.delete(serverId)
  }

  /** 综合判定：能力表 + 已记录的不支持。 */
  allows(serverId: string, capabilities: Record<string, unknown> | undefined, method: string): boolean {
    if (this.has(serverId, method)) return false
    return supportsMethod(capabilities, method)
  }
}
