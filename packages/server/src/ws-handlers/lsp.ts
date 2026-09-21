/**
 * WS 语言服务器域消息（文件工作台的补全 / 悬停 / 跳转 / 诊断通道）。
 *
 * 为什么走 WS 而不是 REST：补全随键入触发、悬停随鼠标移动触发，都是**高频小往返**；且语言服务器会
 * 主动推送诊断（`publishDiagnostics`），需要一条服务端 → 前端的即时通道。WS 沿用 `/ws` 既有鉴权、
 * 跨源防护与背压 sink，不新增端口与握手逻辑（与 `ws-handlers/terminal.ts` 同款）。
 *
 * 门禁：文件工作台开关、`GEBAI_LSP` 开关、沙箱（语言服务器是常驻子进程，非豁免用户拒绝）。
 * 与终端不同的一点：**只读环境（GEBAI_FS_WRITE=false）不拦**——LSP 给的是只读语义信息与诊断。
 * 审计：拉起新服务器进程时记一条 `lsp.start`（根、语言、命令）。
 *
 * 消息类型（前端按此实现，字段不随意增删）：
 *   lsp.open    { root, path, language, text, version, attachTo? }
 *                                                    → { available, docId?, session?, server?, sync?, capabilities?, uri?, root?, projectRoot?, projectMarker?, created? }
 *   lsp.change  { docId, version, text }                → { ok }
 *   lsp.save    { docId, text? }                        → { ok }
 *   lsp.close   { docId }                               → { ok }
 *   lsp.request { docId, method, params }               → { result }
 * 推送（服务端 → 前端，无 id）：
 *   lsp.notify  { docId, method, params }    服务器通知（publishDiagnostics …）
 *   lsp.exit    { session, server, code }    服务器进程退出（前端清诊断并降级）
 *   lsp.log     { session, text }            服务器 stderr / 日志消息
 *
 * `root` 是**工作台根**（前端把 file:// uri 折算回根内相对路径用），`projectRoot` 是语言服务器
 * 实际的**工程根**（服务端按工程标记向上探测，见 `core/lsp/project-root.ts`），两者不一致很正常。
 */

import type { AuthUser } from "../auth"
import type { AppDeps } from "../app"
import { resolveInRoot, resolveRoot } from "../core/fs/roots"
import type { LspPush } from "../core/lsp/service"
import { buildRootContext, fsEnabled } from "../routes/fs-shared"
import type { WsHandler } from "./context"

/** LSP 未启用（GEBAI_LSP=false 或服务未注入）。 */
const LSP_OFF = "语言服务器未启用（GEBAI_LSP=false）"
/** 沙箱非豁免用户：不开放 LSP。 */
const SANDBOX_DENIED = "沙箱模式下不开放语言服务器（等同拉起常驻子进程）：请使用本地模式或沙箱豁免用户"

/** 门禁：返回中文原因表示拒绝，null 表示放行。 */
function gate(d: AppDeps, user: AuthUser): string | null {
  if (!fsEnabled(d)) return "文件工作台未启用（GEBAI_FS_ENABLED=false）"
  if (d.config.lspEnabled === false) return LSP_OFF
  if (!d.lsp) return LSP_OFF
  if (d.sandbox.enforcedFor(user.id)) return SANDBOX_DENIED
  return null
}

/** 记一条 LSP 审计（拉起服务器进程 = 执行外部程序，须留痕）。 */
function auditStart(d: AppDeps, entry: { user: string; root: string; path: string; language: string; server: string; command: string; ok: boolean; error?: string; projectRoot?: string; projectMarker?: string }): void {
  d.fsAudit?.record({
    ts: Date.now(),
    user: entry.user,
    source: "web",
    action: "lsp.start",
    root: entry.root,
    path: entry.path,
    // 工程根一并入审计：同一个服务器进程服务的“目录”与工作台根不同，排障时得看得出用的是哪个
    detail: { language: entry.language, server: entry.server, command: entry.command, projectRoot: entry.projectRoot, projectMarker: entry.projectMarker },
    ok: entry.ok,
    error: entry.error,
  })
}

/** 订阅服务器事件并推给该连接（消息类型 `lsp.notify` / `lsp.exit` / `lsp.log`）。 */
function subscribe(svc: NonNullable<AppDeps["lsp"]>, key: object, user: string, send: (data: string) => void): void {
  svc.subscribe(key, user, (evt: LspPush) => {
    try {
      send(JSON.stringify({ type: `lsp.${evt.type}`, payload: evt }))
    } catch {
      /* 连接已断开：会话侧会在 WS close 时退订 */
    }
  })
}

export const lspHandlers: Record<string, WsHandler> = {
  /** 打开文档：无可用服务器返回 `available:false`（正常路径——没有 LSP 照旧用）。 */
  "lsp.open": async ({ d, user, p, ws, reply }) => {
    const denied = gate(d, user)
    if (denied) return reply(false, undefined, denied)
    const svc = d.lsp!
    const language = String(p.language ?? "").trim().toLowerCase()
    if (!language || language === "plaintext") {
      return reply(true, { available: false, reason: "该文件类型没有对应的语言服务器" })
    }
    const ctx = await buildRootContext(d, user, {
      sessionId: typeof p.session === "string" && p.session ? p.session : undefined,
      envInput: p.env,
      withSessions: true,
    })
    const root = resolveRoot(String(p.root ?? ""), ctx)
    const rel = String(p.path ?? "")
    const absPath = resolveInRoot(root.abs, rel, { allowAbsolute: root.kind === "abs" })
    // 先订阅（连接级去重）：诊断 / 退出 / 日志都经它上行
    subscribe(svc, ws, user.id, (data) => ws.send(data))
    const res = await svc.open({
      user: user.id,
      rootId: root.id,
      rootAbs: root.abs,
      path: rel,
      absPath,
      language,
      text: String(p.text ?? ""),
      version: Number(p.version) || 1,
      // 跳到工作区外的库文件时前端带上「跳转来源文档」：优先复用它那个会话（见 service.open）
      attachTo: typeof p.attachTo === "string" && p.attachTo ? p.attachTo : undefined,
    })
    if (!res.available) {
      if (!/未检测到/.test(res.reason)) auditStart(d, { user: user.id, root: root.id, path: rel, language, server: "", command: "", ok: false, error: res.reason })
      return reply(true, { available: false, reason: res.reason })
    }
    if (res.created) {
      auditStart(d, {
        user: user.id,
        root: root.id,
        path: rel,
        language,
        server: res.server.id,
        command: res.server.command,
        ok: true,
        projectRoot: res.projectRoot,
        projectMarker: res.projectMarker,
      })
    }
    return reply(true, { ...res } as unknown as Record<string, unknown>)
  },

  /** 内容变更（前端发全文；服务端按服务器的同步模式决定是否下发 didChange）。 */
  "lsp.change": ({ d, user, p, reply }) => {
    const denied = gate(d, user)
    if (denied) return reply(false, undefined, denied)
    d.lsp!.change(user.id, String(p.docId ?? ""), Number(p.version) || 0, String(p.text ?? ""))
    return reply(true)
  },

  /** 保存（触发服务器重新诊断；文件内容已由 fs 写入，这里只通知服务器）。 */
  "lsp.save": ({ d, user, p, reply }) => {
    const denied = gate(d, user)
    if (denied) return reply(false, undefined, denied)
    const text = typeof p.text === "string" ? p.text : undefined
    d.lsp!.save(user.id, String(p.docId ?? ""), text)
    return reply(true)
  },

  /** 关闭文档（标签关闭 / 切换为其它语言服务时）。 */
  "lsp.close": ({ d, user, p, reply }) => {
    if (!fsEnabled(d)) return reply(false, undefined, "文件工作台未启用（GEBAI_FS_ENABLED=false）")
    d.lsp?.close(user.id, String(p.docId ?? ""))
    return reply(true)
  },

  /** 请求转发（补全 / 悬停 / 定义 / 引用 / 重命名 / 格式化 …）。 */
  "lsp.request": async ({ d, user, p, reply }) => {
    const denied = gate(d, user)
    if (denied) return reply(false, undefined, denied)
    const method = String(p.method ?? "")
    if (!method) return reply(false, undefined, "缺少 method")
    try {
      const result = await d.lsp!.request(user.id, String(p.docId ?? ""), method, p.params ?? {})
      return reply(true, { result: result === undefined ? null : result })
    } catch (err) {
      return reply(false, undefined, String((err as Error).message || err))
    }
  },
}
