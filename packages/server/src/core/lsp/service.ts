/**
 * LSP · 服务层：会话池（按 用户 × 根 × 服务器 复用进程）+ 文档归属 + 事件订阅 + 空闲回收。
 *
 * 语义与终端 PTY 服务同构（`core/exec/pty-session.ts`）：会话表 + 订阅推送 + idle 回收 +
 * `detach(key)` 随 WS 断开退订。差别在于：
 * - LSP 的「输出」不是字节流而是**语义事件**（诊断 / 服务器退出 / stderr 日志），按用户过滤后推给订阅者；
 * - 会话按 (用户, root, 服务器) 复用——同一 Go 工程的多个文件共用一个 gopls（这正是 LSP 的价值）；
 * - 有打开文档的会话用更长空闲阈值，避免「文件开着不动一会儿补全就失效」。
 *
 * 前端只认 `docId`（它不知道绝对路径）：`didOpen` 的 file uri 由会话层生成，请求参数里的
 * `uri === docId` 在转发前替换为真实 uri，服务器回来的诊断 uri 反向换回 docId。
 */

import { randomUUID } from "node:crypto"
import { LspSession, type LspSessionEvent, type LspSpawner } from "./session"
import { resolveRegistry, serverForLanguage, type LspMissing, type LspRegistry, type LspServerPick } from "./registry"

/** 空闲回收阈值（无打开文档；有文档时按此值的 6 倍）。 */
export const LSP_IDLE_MS = 10 * 60 * 1000
/** 并发语言服务器进程上限（每个服务器都是一份常驻索引，超标即拒绝）。 */
export const LSP_MAX_SESSIONS = 4

export interface LspServiceOptions {
  /** GEBAI_LSP_SERVERS 原文（JSON 字符串；覆盖内置表）。 */
  overrides?: string
  spawner?: LspSpawner
  which?: (cmd: string) => string | null
  now?: () => number
  idleMs?: number
  maxSessions?: number
  requestTimeoutMs?: number
  initTimeoutMs?: number
}

export interface LspOpenInput {
  user: string
  rootId: string
  rootAbs: string
  /** root 内相对路径（展示与审计用）。 */
  path: string
  /** 绝对路径（会话层据此生成 file uri）。 */
  absPath: string
  language: string
  text: string
  version: number
}

export interface LspOpenOk {
  available: true
  docId: string
  session: string
  server: { id: string; command: string }
  /** 文档同步模式：0=不同步 / 1=全量 / 2=增量（前端按此决定是否发变更）。 */
  sync: 0 | 1 | 2
  capabilities: Record<string, unknown>
  /** 根信息：前端把服务器返回的 file:// uri 折算回「本根内相对路径」用。 */
  root: { id: string; abs: string }
  /** 本次是否新拉起了服务器进程（审计与状态栏提示用）。 */
  created: boolean
}

export interface LspOpenUnavailable {
  available: false
  reason: string
}

export type LspOpenResult = LspOpenOk | LspOpenUnavailable

/** 服务端 → 前端推送（ws 层包成 `lsp.notify` / `lsp.exit` / `lsp.log`）。 */
export type LspPush =
  | { type: "notify"; docId: string; method: string; params: Record<string, unknown> }
  | { type: "exit"; session: string; server: string; code: number | null }
  | { type: "log"; session: string; text: string }

interface PooledSession {
  id: string
  key: string
  user: string
  rootId: string
  rootAbs: string
  server: LspServerPick
  session: LspSession
}

interface DocRef {
  user: string
  key: string
}

/** 转发前把参数里的 `uri === docId` 换成真实 file uri（递归；只认 docId 本身，不认任意字符串）。 */
export function rewriteDocUris(value: unknown, docId: string, uri: string): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteDocUris(v, docId, uri))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = k === "uri" && v === docId ? uri : rewriteDocUris(v, docId, uri)
    }
    return out
  }
  return value
}

export class LspService {
  private opts: LspServiceOptions
  private reg: LspRegistry
  private sessions = new Map<string, PooledSession>()
  private docs = new Map<string, DocRef>()
  private subscribers = new Map<object, { user: string; sink: (evt: LspPush) => void }>()
  private now: () => number
  private idleMs: number
  private maxSessions: number
  private seq = 0

  constructor(opts: LspServiceOptions = {}) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.idleMs = opts.idleMs ?? LSP_IDLE_MS
    this.maxSessions = opts.maxSessions ?? LSP_MAX_SESSIONS
    this.reg = resolveRegistry({ overrides: opts.overrides, which: opts.which })
  }

  /** 可用服务器清单（REST/前端启动时拉取）。 */
  servers(): { enabled: boolean; servers: LspServerPick[]; missing: LspMissing[]; errors: string[] } {
    return { enabled: true, servers: this.reg.picks, missing: this.reg.missing, errors: this.reg.errors }
  }

  /** 语言 → 可用服务器（无则 undefined：调用方静默降级）。 */
  serverFor(language: string): LspServerPick | undefined {
    return serverForLanguage(this.reg, language)
  }

  /**
   * 打开文档：无可用服务器返回 `{ available:false }`（正常路径，不是错误——没有 LSP 照旧用）；
   * 起进程失败同样以 available:false 回，reason 带原因供前端与审计。
   */
  async open(input: LspOpenInput): Promise<LspOpenResult> {
    const server = this.serverFor(input.language)
    if (!server) {
      return { available: false, reason: `未检测到 ${input.language} 的语言服务器` }
    }
    const key = `${input.user}|${input.rootId}|${server.id}`
    let pooled = this.sessions.get(key)
    if (pooled && !pooled.session.alive) {
      this.drop(key)
      pooled = undefined
    }
    let created = false
    if (!pooled) {
      const newSession = await this.create(input, server, key, input.rootAbs)
      if ("available" in newSession) return newSession
      pooled = newSession
      created = true
    }
    const docId = `d${(this.seq += 1).toString(36)}${randomUUID().replace(/-/g, "").slice(0, 6)}`
    pooled.session.openDocument({ docId, absPath: input.absPath, language: input.language, text: input.text, version: input.version })
    this.docs.set(docId, { user: input.user, key })
    return {
      available: true,
      docId,
      session: pooled.id,
      server: { id: pooled.server.id, command: pooled.server.command },
      sync: pooled.session.sync,
      capabilities: pooled.session.serverCapabilities,
      root: { id: input.rootId, abs: input.rootAbs },
      created,
    }
  }

  /** 请求转发（补全 / 悬停 / 定义 / 引用 / 重命名 / 格式化 …）。 */
  async request(user: string, docId: string, method: string, params: unknown): Promise<unknown> {
    const { session, doc } = this.locate(user, docId)
    const out = await session.session.request(method, rewriteDocUris(params ?? {}, docId, doc.uri))
    return out
  }

  /** 内容变更（前端发全文；服务端按会话同步模式决定是否下发 didChange）。 */
  change(user: string, docId: string, version: number, text: string): void {
    const { session } = this.locate(user, docId)
    session.session.changeDocument(docId, version, text)
  }

  save(user: string, docId: string, text?: string): void {
    const { session } = this.locate(user, docId)
    session.session.saveDocument(docId, text)
  }

  close(user: string, docId: string): void {
    const ref = this.docs.get(docId)
    if (!ref || ref.user !== user) return
    this.docs.delete(docId)
    this.sessions.get(ref.key)?.session.closeDocument(docId)
  }

  /** 订阅事件（连接级 key：同一 WS 上的多次 open 只订阅一次）。 */
  subscribe(key: object, user: string, sink: (evt: LspPush) => void): () => void {
    this.subscribers.set(key, { user, sink })
    return () => {
      if (this.subscribers.get(key)?.sink === sink) this.subscribers.delete(key)
    }
  }

  /** 连接断开：按连接级 key 退订（会话本身保留，等空闲回收）。 */
  detach(key: object): void {
    this.subscribers.delete(key)
  }

  /** 会话清单（诊断/列表用）。 */
  list(): Array<{ id: string; server: string; root: string; docs: number; alive: boolean }> {
    return [...this.sessions.values()].map((p) => ({
      id: p.id,
      server: p.server.id,
      root: p.rootId,
      docs: p.session.documents.length,
      alive: p.session.alive,
    }))
  }

  /** 空闲回收：无文档会话按 idleMs，有文档会话按 6 倍阈值（文件开着不动不该丢能力）。 */
  sweep(): void {
    const t = this.now()
    for (const [key, p] of [...this.sessions]) {
      const docs = p.session.documents.length
      const limit = docs > 0 ? this.idleMs * 6 : this.idleMs
      if (t - p.session.lastActive > limit) this.drop(key)
    }
  }

  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.drop(key)
    this.subscribers.clear()
  }

  /* --------------------------- 内部 --------------------------- */

  private locate(user: string, docId: string): { session: PooledSession; doc: { uri: string; path: string } } {
    const ref = this.docs.get(docId)
    if (!ref || ref.user !== user) throw new Error("LSP 文档未打开或已关闭")
    const pooled = this.sessions.get(ref.key)
    const doc = pooled?.session.document(docId)
    if (!pooled || !doc) throw new Error("语言服务器已关闭：请重新打开该文件")
    pooled.session.touch()
    return { session: pooled, doc }
  }

  private async create(input: LspOpenInput, server: LspServerPick, key: string, rootAbs: string): Promise<PooledSession | LspOpenUnavailable> {
    this.sweep()
    if (this.sessions.size >= this.maxSessions) {
      // 先回收「无文档」的空闲会话，仍满则拒绝（避免无上限拉起常驻索引进程）
      for (const [k, p] of [...this.sessions]) if (p.session.documents.length === 0) this.drop(k)
    }
    if (this.sessions.size >= this.maxSessions) {
      return { available: false, reason: `语言服务器进程数已达上限（${this.maxSessions}）：请关闭部分文件或稍后再试` }
    }
    const id = `s${(this.seq += 1).toString(36)}${randomUUID().replace(/-/g, "").slice(0, 6)}`
    const session = new LspSession({
      rootAbs,
      server,
      spawner: this.opts.spawner,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      initTimeoutMs: this.opts.initTimeoutMs,
      now: this.now,
      onEvent: (evt) => this.publish(id, server.id, input.user, evt),
    })
    try {
      await session.start()
    } catch (err) {
      session.dispose()
      return { available: false, reason: `启动 ${server.id} 失败：${(err as Error).message}` }
    }
    const pooled: PooledSession = { id, key, user: input.user, rootId: input.rootId, rootAbs, server, session }
    this.sessions.set(key, pooled)
    return pooled
  }

  private drop(key: string): void {
    const p = this.sessions.get(key)
    if (!p) return
    this.sessions.delete(key)
    for (const doc of p.session.documents) this.docs.delete(doc.docId)
    p.session.dispose()
  }

  /** 会话事件 → 该用户的订阅者（按会长级订阅过滤用户，避免串号）。 */
  private publish(sessionId: string, server: string, user: string, evt: LspSessionEvent): void {
    let push: LspPush
    if (evt.type === "notify") {
      const docId = typeof evt.params?.uri === "string" ? evt.params.uri : ""
      push = { type: "notify", docId, method: evt.method, params: evt.params }
    } else if (evt.type === "exit") {
      push = { type: "exit", session: sessionId, server, code: evt.code }
    } else {
      push = { type: "log", session: sessionId, text: evt.text }
    }
    for (const [, sub] of this.subscribers) {
      if (sub.user !== user) continue
      try {
        sub.sink(push)
      } catch {
        /* 单个订阅者异常不影响其它 */
      }
    }
  }
}
