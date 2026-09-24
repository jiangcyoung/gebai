import { createHmac } from "node:crypto"
import { checkWebhookUrl, fetchWithRedirectGuard } from "@gebai/agents"
import type { FeishuAtTarget, TaskKind, TaskNotifyChannel, TaskRunStatus } from "@gebai/sdk"
import { hmacHex } from "../base/paths"

/** 通知通道类型（契约定义在 @gebai/sdk，本模块转出供服务端内部引用）。 */
export type { FeishuAtTarget, TaskNotifyChannel, TaskNotifyInput, TaskNotifyType } from "@gebai/sdk"

/** 通知正文单字段（错误/输出摘要）保留长度。 */
export const NOTIFY_TEXT_MAX = 2000
/** 通知卡片整体保留长度（1.0 lark_md / 2.0 markdown 组件上限，与对话桥接 truncateForFeishu 同额）。 */
export const NOTIFY_CARD_MAX = 12000
/** 通知投递超时。 */
export const NOTIFY_TIMEOUT_MS = 10_000

/** 任务运行结果通知载荷（webhook 通道 JSON 原样投递，飞书通道格式化为 markdown 卡片）。 */
export interface TaskResultNotification {
  event: "task.result"
  task: { id: string; name: string; kind: TaskKind; runner: string; schedule?: string; user: string }
  ok: boolean
  status: TaskRunStatus
  at: number
  durationMs?: number
  output?: string
  error?: string
  /** 本次运行使用的会话（prompt 型执行轨迹）。 */
  sessionId?: string
  /** 运行后任务被自动停用（一次性任务完成 / 连续失败阈值）。 */
  disabled?: boolean
  /** 手动执行（task_run / REST run / 待办立即执行）。 */
  manual?: boolean
}

/** 模型主动推送的通知载荷（webhook 通道 JSON 原样投递，飞书通道渲染为 markdown 卡片）。 */
export interface TaskMessageNotification {
  event: "task.message"
  task: { id: string; name: string; kind: TaskKind; runner: string; user: string }
  /** 标题（缺省用任务名）。 */
  title?: string
  /** 正文（markdown，由调用方自撰）。 */
  text: string
  at: number
}

export interface NotifyDeps {
  /** 注入 HTTP 客户端（默认全局 fetch；测试用）。body 为响应体文本（默认实现读取，供飞书业务 code 校验）。 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; body?: string }>
  /** 飞书开放平台消息发送（feishu_chat 通道用；未配置时该通道报错）。at 含 "all" 时 msgType=text，否则卡片。 */
  feishuSend?: (chatId: string, msgType: "interactive" | "text", content: Record<string, unknown>) => Promise<void>
  /** 时钟（加签时间戳用，可注入）。 */
  now?: () => number
}

/** at 名单输入归一：条目为字符串（id）或 {id,name}；去重、非法 id 拒绝。 */
export function normalizeAtList(raw: unknown): FeishuAtTarget[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error("at 须为 @ 人名单数组（open_id 或 \"all\"）")
  const out: FeishuAtTarget[] = []
  for (const item of raw) {
    let entry: FeishuAtTarget
    if (typeof item === "string") entry = { id: item.trim() }
    else if (item && typeof item === "object") {
      const id = String((item as { id?: unknown }).id ?? "").trim()
      if (!id) throw new Error("at 条目缺少 id（open_id 或 \"all\"）")
      const name = (item as { name?: unknown }).name
      entry = { id, name: name != null && String(name).trim() ? String(name).trim() : undefined }
    } else throw new Error("at 条目须为 open_id 字符串或 {id,name} 对象")
    if (!/^(all|(ou|un|on)_[0-9a-zA-Z]+)$/.test(entry.id)) {
      throw new Error(`无效的 @ 对象 id: ${entry.id}（须为 open_id（ou_/un_/on_ 前缀）或 "all"）`)
    }
    if (!out.some((e) => e.id === entry.id)) out.push(entry)
  }
  return out.length ? out : undefined
}

/** 飞书群 chat_id 形态（oc_ 前缀或纯 id）：feishu 通道以此为 target 时走应用消息推送（需应用凭证）。 */
export function isFeishuChatId(target: string): boolean {
  return /^(oc_[a-f0-9]+|[0-9a-f-]{16,})$/i.test(target.trim())
}

/** 校验通知通道配置（创建/修改时即拒绝非法配置；webhookId 的存在性/归属由 TaskManager 注入的解析器校验）。 */
export function validateNotifyChannel(ch: TaskNotifyChannel): void {
  if (ch.type !== "webhook" && ch.type !== "feishu" && ch.type !== "feishu_chat") {
    throw new Error(`无效的通知通道类型: ${String(ch.type)}`)
  }
  const target = String(ch.target ?? "").trim()
  const webhookId = String(ch.webhookId ?? "").trim()
  if (!target && !webhookId) throw new Error("通知通道缺少 target（webhook 可用 webhookId 引用已注册事件 Webhook；feishu 可填群机器人 webhook 或群 chat_id）")
  if (webhookId && ch.type !== "webhook") throw new Error("webhookId 仅支持 webhook 通道")
  if (webhookId && !/^[a-f0-9]{32}$/.test(webhookId)) throw new Error(`无效的 webhookId: ${webhookId}（32 位 hex，REST /api/v1/webhooks 注册返回）`)
  if (ch.at !== undefined) normalizeAtList(ch.at)
  if (ch.type === "feishu_chat") {
    if (!target) throw new Error("feishu_chat 通道需要 target（群 chat_id）")
    if (!isFeishuChatId(target)) throw new Error(`无效的飞书 chat_id: ${target}`)
    return
  }
  if (webhookId && !target) return // 引用形态：URL 在投递时解析（解析器注册期已过 SSRF 校验）
  if (ch.type === "feishu" && isFeishuChatId(target)) return // feishu 群 chat_id 形态：应用消息推送（投递需应用凭证）
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error(`无效的通知 URL: ${target}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`通知 URL 仅支持 http(s): ${target}`)
  if (ch.type === "feishu") {
    if (url.hostname !== "open.feishu.cn" || !/^\/open-apis\/bot\/v2\/hook\//.test(url.pathname)) {
      throw new Error(`飞书通知地址须为 open.feishu.cn 的 /open-apis/bot/v2/hook/… webhook，或直接填群 chat_id（oc_ 前缀）: ${target}`)
    }
    return
  }
  // 通用 webhook：与事件 Webhook 同规则（回环/链路本地/元数据地址默认拒绝，SSRF 防护）
  checkWebhookUrl(target)
}

/** 飞书自定义机器人加签：sign = base64(HMAC-SHA256(key=`${timestamp}\n${secret}`, message=""))。 */
export function feishuBotSign(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64")
}

/** markdown 内容净化：输出/错误中的尖括号全角化，防任务输出注入 `<at>`/`<a>`/`<img>` 等标签（@ 人/链接仅由配置产生）。 */
function sanitizeMd(text: string): string {
  return text.replace(/</g, "＜")
}

/** 任务类别展示名。 */
function kindLabel(kind: TaskKind): string {
  return kind === "scheduled" ? "定时任务" : kind === "idle" ? "闲时任务" : "普通任务"
}

/** @ 人 text 正文标签（text 消息语法 `<at user_id=…>`；"all" 缺省展示「所有人」，open_id 无 name 时空内文由客户端解析真实姓名）。 */
function atTags(at: FeishuAtTarget[] | undefined): string {
  if (!at?.length) return ""
  return at
    .map((a) => (a.id === "all" ? `<at user_id="all">${a.name ?? "所有人"}</at>` : `<at user_id="${a.id}">${a.name ?? ""}</at>`))
    .join(" ")
}

/** @ 人 2.0 markdown 组件标签（语法 `<at id=…>`，与 1.0 lark_md 的 user_id 属性不同；被 @ 用户收到提及通知）。 */
function atTagsMd(at: FeishuAtTarget[] | undefined): string {
  if (!at?.length) return ""
  return at
    .map((a) => (a.id === "all" ? `<at id=all>${a.name ?? "所有人"}</at>` : `<at id=${a.id}>${a.name ?? ""}</at>`))
    .join(" ")
}

/** 通知卡片头部模板色（success=绿 / error=红 / timeout=橙 / skipped=灰）。 */
function cardTemplate(n: TaskResultNotification): string {
  if (n.ok) return "green"
  if (n.status === "timeout") return "orange"
  if (n.status === "skipped") return "grey"
  return "red"
}

/** 任务标题（飞书卡片与 text 正文共用）。 */
function taskTitle(n: TaskResultNotification): string {
  return `${kindLabel(n.task.kind)}${n.task.name ? `「${sanitizeMd(n.task.name)}」` : `（${n.task.id.slice(0, 8)}）`}`
}

/** 通知卡片正文 markdown（1.0 lark_md 与 2.0 markdown 组件共用正文：@ 人标签首行 + 状态/类别/周期/时间/耗时/错误/输出/会话/停用）。 */
function cardMarkdown(n: TaskResultNotification, at?: FeishuAtTarget[]): string {
  const status = n.ok ? "✅ 成功" : n.status === "skipped" ? "⏭️ 跳过" : n.status === "timeout" ? "⏱️ 超时" : "❌ 失败"
  const lines: string[] = []
  const tags = atTagsMd(at)
  if (tags) lines.push(tags)
  lines.push(`**状态：**${status}　**类别：**${kindLabel(n.task.kind)}`)
  if (n.task.schedule) lines.push(`**周期：**${sanitizeMd(n.task.schedule)}`)
  lines.push(`**时间：**${new Date(n.at).toLocaleString("zh-CN")}${n.durationMs !== undefined ? `　**耗时：**${Math.round(n.durationMs / 100) / 10}s` : ""}${n.manual ? "　**（手动执行）**" : ""}`)
  if (n.error) lines.push(`**错误：**${sanitizeMd(n.error.slice(0, NOTIFY_TEXT_MAX))}`)
  if (n.output) lines.push(`**输出：**\n${sanitizeMd(n.output.slice(0, NOTIFY_TEXT_MAX))}`)
  if (n.sessionId) lines.push(`**执行会话：**${n.sessionId}`)
  if (n.disabled) lines.push(`⚠️ **任务已自动停用**${n.manual ? "" : "（如需继续请重新启用）"}`)
  return lines.join("\n").slice(0, NOTIFY_CARD_MAX)
}

/** 飞书通知卡片 2.0 结构体（msg_type=interactive——**应用消息接口专用**，与对话桥接同款新版本接口）：头部按状态着色，
 *  正文 markdown 组件（2.0 富文本支持完整 Markdown：标题/表格/代码块等，@ 人用 `<at id=…>` 标签）+ note 脚注。
 *  自定义机器人 webhook **不支持** 2.0 卡片（schema V2 + note 组件实测被拒 code=11246），webhook 投递用 buildFeishuCardV1。 */
export function buildFeishuCard(n: TaskResultNotification, at?: FeishuAtTarget[]): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      template: cardTemplate(n),
      title: { tag: "plain_text", content: `⏰ 歌白·${taskTitle(n)}` },
    },
    body: {
      elements: [
        { tag: "markdown", content: cardMarkdown(n, at) },
        { tag: "note", elements: [{ tag: "plain_text", content: "GEBAI 任务 · task.result" }] },
      ],
    },
  }
}

/** 飞书通知卡片 1.0 结构体（msg_type=interactive——**自定义机器人 webhook 专用**）：webhook 不支持 2.0 卡片
 *  （schema V2 实测被拒 code=11246「cards of schema V2 no longer support this capability; unsupported tag note」，
 *  2.0 卡片仅应用消息接口 im/v1/messages 支持），故 webhook 投递发 1.0 卡片保留卡片形态：
 *  config.wide_screen_mode + 着色 header + div/lark_md 正文（@ 人语法同 2.0 的 `<at id=…>`）+ note 脚注。 */
export function buildFeishuCardV1(n: TaskResultNotification, at?: FeishuAtTarget[]): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: cardTemplate(n),
      title: { tag: "plain_text", content: `⏰ 歌白·${taskTitle(n)}` },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: cardMarkdown(n, at) } },
      { tag: "note", elements: [{ tag: "plain_text", content: "GEBAI 任务 · task.result" }] },
    ],
  }
}

/** 飞书 text 消息正文（at 含 "all" 时的降级形态——text 正文 `<at user_id="all">` 是 @所有人 提及通知
 *  长期验证的可靠路径；卡片内 @所有人 在 1.0 lark_md 被静默忽略（实测），2.0 markdown 组件虽支持
 *  `<at id=all>` 但提及权限因应用配置而异，通知场景求稳不冒险）。 */
export function formatNotificationText(n: TaskResultNotification, at?: FeishuAtTarget[]): string {
  const status = n.ok ? "成功" : n.status === "skipped" ? "跳过" : n.status === "timeout" ? "超时" : "失败"
  const lines: string[] = []
  const tags = atTags(at)
  if (tags) lines.push(tags)
  lines.push(`⏰ 歌白·${taskTitle(n)}`)
  lines.push(`状态: ${status}  类别: ${kindLabel(n.task.kind)}${n.task.schedule ? `  周期: ${sanitizeMd(n.task.schedule)}` : ""}`)
  lines.push(`时间: ${new Date(n.at).toLocaleString("zh-CN")}${n.durationMs !== undefined ? `  耗时: ${Math.round(n.durationMs / 100) / 10}s` : ""}${n.manual ? "（手动执行）" : ""}`)
  if (n.error) lines.push(`错误: ${sanitizeMd(n.error.slice(0, NOTIFY_TEXT_MAX))}`)
  if (n.output) lines.push(`输出:\n${sanitizeMd(n.output.slice(0, NOTIFY_TEXT_MAX))}`)
  if (n.sessionId) lines.push(`执行会话: ${n.sessionId}`)
  if (n.disabled) lines.push(`⚠️ 任务已自动停用${n.manual ? "" : "（如需继续请重新启用）"}`)
  return lines.join("\n").slice(0, NOTIFY_CARD_MAX)
}

/** 单通道投递载荷（按通道形态取用）：webhook=通用 JSON；feishuWebhook=自定义机器人 webhook；app=飞书应用消息。 */
interface ChannelPayloads {
  webhook: Record<string, unknown>
  feishuWebhook: Record<string, unknown>
  app: { msgType: "interactive" | "text"; content: Record<string, unknown> }
}

/** 投递到单条通道（尽力而为：失败抛错由调用方记录）：按通道形态选择载荷与发送路径，
 *  自定义机器人 webhook 附 timestamp + 加签、webhook 直配 URL 附 X-Gebai-Signature（同款 sha256 HMAC）、
 *  飞书 webhook 另校验响应业务码（HTTP 200 也可能是业务失败）。 */
async function deliverToChannel(ch: TaskNotifyChannel, payloads: ChannelPayloads, deps: NotifyDeps): Promise<void> {
  // 飞书应用消息形态：feishu_chat，或 feishu 通道 target 为群 chat_id（指定群以应用身份推送）
  const target = String(ch.target ?? "").trim()
  const viaApp = ch.type === "feishu_chat" || (ch.type === "feishu" && isFeishuChatId(target))
  if (viaApp) {
    if (!deps.feishuSend) throw new Error("飞书应用通知未配置（需 GEBAI_FEISHU_APP_ID/GEBAI_FEISHU_APP_SECRET）")
    if (!target) throw new Error("feishu 应用消息通道缺少 target（群 chat_id）")
    await deps.feishuSend(target, payloads.app.msgType, payloads.app.content)
    return
  }
  const url = target
  if (!url) throw new Error("webhook 引用未解析（webhookId 须由调度器在投递前解析为具体 URL）")
  const fetchImpl =
    deps.fetchImpl ??
    (async (u: string, init: RequestInit) => {
      const res = await fetchWithRedirectGuard(u, init, checkWebhookUrl)
      return { ok: res.ok, status: res.status, body: await res.text() }
    })
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" }
  const body: Record<string, unknown> = ch.type === "feishu" ? { ...payloads.feishuWebhook } : { ...payloads.webhook }
  if (ch.type === "feishu") {
    if (ch.secret) {
      const ts = Math.floor((deps.now ?? Date.now)() / 1000).toString()
      body.timestamp = ts
      body.sign = feishuBotSign(ts, ch.secret)
    }
  } else if (ch.secret) {
    // 通用 webhook：载荷随通道 at 名单携带（接收方据此渲染 @ 人）；配 secret（直配或 webhookId 引用解析）
    // 时附 X-Gebai-Signature（与事件 Webhook 投递同款 sha256 HMAC，接收方一套校验通吃）
    headers["X-Gebai-Signature"] = `sha256=${hmacHex(ch.secret, JSON.stringify(body))}`
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`通知投递失败: HTTP ${res.status}`)
  // 飞书群机器人 webhook：业务失败时 HTTP 仍返回 200（如 2.0 卡片被拒 code=11246），须解析响应 JSON 的
  // 业务 code——code !== 0 即失败（否则任务显示 success 但群内无通知的静默失败，由调用方记 lastNotifyError）；
  // 响应体缺失/非 JSON（注入形态或无业务码可判）按 HTTP 成功处理；通用 webhook 通道不校验（无统一业务码约定）
  if (ch.type === "feishu" && res.body) {
    let biz: { code?: unknown; msg?: unknown } | null = null
    try {
      biz = JSON.parse(res.body) as { code?: unknown; msg?: unknown }
    } catch {
      biz = null
    }
    if (biz && typeof biz === "object" && biz.code !== 0) {
      throw new Error(`通知投递失败: 飞书业务错误 code=${String(biz.code)}${biz.msg ? ` (${String(biz.msg)})` : ""}`)
    }
  }
}

/** 投递任务结果通知（尽力而为：失败抛错由调用方记录，不影响任务执行结果）。 */
export async function sendTaskNotification(ch: TaskNotifyChannel, n: TaskResultNotification, deps: NotifyDeps = {}): Promise<void> {
  // at 含 "all"（@所有人）时降级为 text 消息：@所有人 的提及通知以 text 正文标签为可靠路径（卡片内
  // @所有人 1.0 时代被静默忽略，2.0 markdown 组件 `<at id=all>` 权限因应用而异）；仅 @ 具体 open_id 时
  // 走 2.0 markdown 卡片（markdown 组件 `<at id=…>` 支持 @ 指定人并触发提及通知）
  const atAll = ch.at?.some((a) => a.id === "all") === true
  await deliverToChannel(
    ch,
    {
      webhook: { ...n, at: ch.at } as unknown as Record<string, unknown>,
      // webhook 通道发 1.0 卡片（自定义机器人 webhook 不支持 2.0 卡片，schema V2 实测被拒 code=11246；
      // 2.0 卡片仅应用消息接口支持）；at 含 "all" 时维持 text 降级（@所有人 提及通知以 text 正文标签为可靠路径）
      feishuWebhook: atAll
        ? { msg_type: "text", content: { text: formatNotificationText(n, ch.at) } }
        : { msg_type: "interactive", card: buildFeishuCardV1(n, ch.at) },
      app: atAll
        ? { msgType: "text", content: { text: formatNotificationText(n, ch.at) } }
        : { msgType: "interactive", content: buildFeishuCard(n, ch.at) },
    },
    deps,
  )
}

/** 主动通知标题（卡片标题用；缺省任务名，再缺省任务类别 + 短 id）。 */
function messageTitle(n: TaskMessageNotification): string {
  const title = n.title?.trim() ? sanitizeMd(n.title.trim()) : n.task.name ? sanitizeMd(n.task.name) : `${kindLabel(n.task.kind)}（${n.task.id.slice(0, 8)}）`
  return title.slice(0, 200)
}

/** 主动通知卡片正文 markdown（@ 人标签首行 + 正文 + 时间脚注）。 */
function messageMarkdown(n: TaskMessageNotification, at?: FeishuAtTarget[]): string {
  const lines: string[] = []
  const tags = atTagsMd(at)
  if (tags) lines.push(tags)
  lines.push(sanitizeMd(n.text.slice(0, NOTIFY_TEXT_MAX)))
  lines.push(`—— ${new Date(n.at).toLocaleString("zh-CN")}`)
  return lines.join("\n").slice(0, NOTIFY_CARD_MAX)
}

/** 飞书应用消息 2.0 卡片（markdown 组件正文 + note 脚注；主动通知用中性蓝模板色）。 */
function buildMessageCard(n: TaskMessageNotification, at?: FeishuAtTarget[]): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { template: "blue", title: { tag: "plain_text", content: `💬 歌白·${messageTitle(n)}` } },
    body: {
      elements: [
        { tag: "markdown", content: messageMarkdown(n, at) },
        { tag: "note", elements: [{ tag: "plain_text", content: "GEBAI 任务 · task.message" }] },
      ],
    },
  }
}

/** 飞书自定义机器人 webhook 1.0 卡片（webhook 不支持 2.0 卡片，见 buildFeishuCardV1 注释）。 */
function buildMessageCardV1(n: TaskMessageNotification, at?: FeishuAtTarget[]): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: `💬 歌白·${messageTitle(n)}` } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: messageMarkdown(n, at) } },
      { tag: "note", elements: [{ tag: "plain_text", content: "GEBAI 任务 · task.message" }] },
    ],
  }
}

/** 主动通知的飞书 text 消息正文（at 含 "all" 时的降级形态，规则同结果通知）。 */
export function formatMessageText(n: TaskMessageNotification, at?: FeishuAtTarget[]): string {
  const lines: string[] = []
  const tags = atTags(at)
  if (tags) lines.push(tags)
  lines.push(`💬 歌白·${messageTitle(n)}`)
  lines.push(sanitizeMd(n.text.slice(0, NOTIFY_TEXT_MAX)))
  lines.push(`—— ${new Date(n.at).toLocaleString("zh-CN")}`)
  return lines.join("\n")
}

/** 投递一条主动通知（task_notify：正文自撰，通道由调用方解析后传入）。 */
export async function sendTaskMessage(ch: TaskNotifyChannel, n: TaskMessageNotification, deps: NotifyDeps = {}): Promise<void> {
  const atAll = ch.at?.some((a) => a.id === "all") === true
  await deliverToChannel(
    ch,
    {
      webhook: { ...n, at: ch.at } as unknown as Record<string, unknown>,
      feishuWebhook: atAll
        ? { msg_type: "text", content: { text: formatMessageText(n, ch.at) } }
        : { msg_type: "interactive", card: buildMessageCardV1(n, ch.at) },
      app: atAll
        ? { msgType: "text", content: { text: formatMessageText(n, ch.at) } }
        : { msgType: "interactive", content: buildMessageCard(n, ch.at) },
    },
    deps,
  )
}
