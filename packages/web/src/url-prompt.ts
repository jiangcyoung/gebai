/**
 * 外部链接携带提示词自动运行（URL 参数 `gb_prompt`）——业务系统跳转链接可直接带任务进来：
 * 打开页面即自动新建会话并发送该提示词，随后**立即把地址栏重定向**为会话地址
 * （`?session=<会话 id>`，其余参数保留、`gb_prompt`/`gb_new` 移除）。刷新因此只会打开该会话，
 * 不会重复创建会话、重复执行任务。开关见 boot-config（配置文件 `allowUrlPrompt`，默认开启）。
 *
 * 语义：
 * - `gb_prompt=<文本>`：提示词（URL 编码；纯空白视为未携带）；
 * - `gb_new=1`：即使 URL 带 `session` 也强制新建会话；
 * - 同时带 `session=<id>` 且该会话存在：在该会话里发送（不新建）——外部系统可续接已有会话；
 * - 该会话正在运行：不抢占，重定向后把提示词回落输入框并提示；
 * - 创建会话失败：提示词回落输入框、**不重定向**（刷新重试仍会执行，提示词不丢）。
 */

export interface UrlPromptRequest {
  text: string
  forceNew: boolean
  sessionId?: string
}

export type UrlPromptOutcome =
  /** 已在 URL 指定会话中进入发送队列（该会话运行中，提示词回落输入框） */
  | "queued"
  /** 未携带提示词参数 */
  | "none"
  /** 配置关闭了该入口 */
  | "disabled"
  /** 已自动建会话并发送 */
  | "sent"
  /** 自动执行失败（提示词已回落输入框） */
  | "failed"

/** 解析 URL 上的提示词参数；未携带（或为空）返回 null。 */
export function parseUrlPrompt(search: string): UrlPromptRequest | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  const raw = params.get("gb_prompt")
  if (raw === null) return null
  const text = raw.trim()
  if (!text) return null
  const sessionId = params.get("session")?.trim() || undefined
  return { text, forceNew: params.get("gb_new") === "1", sessionId }
}

/** 生成重定向后的地址：带会话 id，去掉提示词参数（其余参数原样保留）。 */
export function redirectToSession(search: string, sessionId: string, pathname = "/"): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  params.delete("gb_prompt")
  params.delete("gb_new")
  params.set("session", sessionId)
  return `${pathname}?${params.toString()}`
}

export interface UrlPromptDeps {
  /** 按 id 查会话（不存在返回 undefined）。 */
  findSession(id: string): { id: string } | undefined
  /** 该会话是否正在运行任务。 */
  isRunning(id: string): boolean
  createSession(): Promise<{ id: string }>
  /** 激活会话：切为当前会话并加载其消息（须在 send 之前完成，避免刚上屏的用户消息被历史渲染覆盖）。 */
  openSession(session: { id: string }): Promise<void>
  /** 发送提示词（渲染用户消息 + 走 sendPrompt 任务流；自行处理错误，不抛）。 */
  send(session: { id: string }, text: string): void
  /** 重定向地址栏（history.replaceState）。 */
  redirect(url: string): void
  /** 提示词无法立即执行时回落输入框 + 说明原因。 */
  fallback(text: string, reason: string): void
}

export interface UrlPromptOptions {
  search?: string
  pathname?: string
  /** 开关判定（缺省恒允许；调用方接 boot-config 的 urlPromptAllowed）。 */
  allowed?: () => boolean
}

/** 页面首屏就绪后调用：按 URL 提示词建会话/续会话并运行，随即重定向。 */
export async function runUrlPromptFromLocation(deps: UrlPromptDeps, opts: UrlPromptOptions = {}): Promise<UrlPromptOutcome> {
  const search = opts.search ?? location.search
  const req = parseUrlPrompt(search)
  if (!req) return "none"
  if (opts.allowed && !opts.allowed()) return "disabled"
  const pathname = opts.pathname ?? location.pathname
  // URL 指定会话且未强制新建：续接发送（运行中的会话不抢占——重定向后把提示词交给用户）
  const existing = req.forceNew || !req.sessionId ? undefined : deps.findSession(req.sessionId)
  if (existing && deps.isRunning(existing.id)) {
    deps.redirect(redirectToSession(search, existing.id, pathname))
    deps.fallback(req.text, "该会话已有任务在运行：提示词未自动发送，已放入输入框")
    return "queued"
  }
  let session = existing
  if (!session) {
    try {
      session = await deps.createSession()
    } catch (err) {
      deps.fallback(req.text, `自动创建会话失败（${(err as Error).message}）：提示词已放入输入框`)
      return "failed"
    }
  }
  // 会话确定即重定向：地址栏不再带提示词参数，刷新只会打开该会话
  deps.redirect(redirectToSession(search, session.id, pathname))
  try {
    await deps.openSession(session)
  } catch {
    /* 消息加载异常不阻断发送（会话已切换，sendPrompt 仍可用） */
  }
  deps.send(session, req.text)
  return "sent"
}
