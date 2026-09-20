/** WS 交互决策域消息：审批/选择/环境填值/画图回传/页面捕获（引擎五种阻塞等待的 decide 入口）。
 *  决策送达才应答成功：服务端已无该等待（超时/已被处理/任务已结束）时返回 `expired` 错误码，
 *  前端据此提示并撤掉失效卡片，而不是让用户对着死卡片操作。 */
import type { WsHandler } from "./context"

/** 决策结果的统一应答：expired → 错误码 + 说明（queued 与 ok 同等视为已受理）。 */
export function replyDecide(reply: (ok: boolean, payload?: Record<string, unknown>, error?: string) => void, verdict: "ok" | "queued" | "expired", what: string) {
  if (verdict === "expired") return reply(false, { code: "expired" }, `${what}已失效（等待超时、已在其他地方处理，或任务已结束）`)
  return reply(true)
}

export const interactionHandlers: Record<string, WsHandler> = {
  "approval.decide": async ({ d, p, user, reply }) => {
    const sessionId = String(p.id)
    const s = await d.store.load(sessionId, user.id)
    if (!s) return reply(false, undefined, "session not found")
    return replyDecide(reply, await d.engine.decideApproval(sessionId, String(p.toolCallId), Boolean(p.approve)), "审批请求")
  },
  "choice.decide": async ({ d, p, user, reply }) => {
    // 提交用户选择（ask 选项询问分支阻塞等待）；option 单选 / options 数组多选 / refuse=true（或均缺失）拒绝回答
    const sessionId = String(p.id)
    const s = await d.store.load(sessionId, user.id)
    if (!s) return reply(false, undefined, "session not found")
    const multi = Array.isArray(p.options)
    const refuse = p.refuse === true || (!multi && p.option == null)
    return replyDecide(reply, await d.engine.decideChoice(sessionId, String(p.choiceId), refuse ? null : multi ? (p.options as unknown[]).map(String) : String(p.option)), "该询问")
  },
  "env.decide": async ({ d, p, user, reply }) => {
    // 提交用户填写的环境变量值（ask 填值分支阻塞等待）；value 缺失视为拒绝
    const sessionId = String(p.id)
    const s = await d.store.load(sessionId, user.id)
    if (!s) return reply(false, undefined, "session not found")
    const value = p.value == null ? null : String(p.value)
    return replyDecide(reply, await d.engine.decideEnvResult(sessionId, String(p.envId ?? ""), value), "填值请求")
  },
  "draw.result": async ({ d, p, user, reply }) => {
    // 提交前端渲染结果（show 图表分支阻塞等待）
    const sessionId = String(p.id)
    const s = await d.store.load(sessionId, user.id)
    if (!s) return reply(false, undefined, "session not found")
    return replyDecide(reply, await d.engine.decideDrawResult(sessionId, String(p.renderId), { ok: Boolean(p.ok), error: p.error != null ? String(p.error) : undefined }), "画图请求")
  },
  "capture.result": async ({ d, p, user, reply }) => {
    // 提交前端页面捕获结果（page_capture 工具阻塞等待）
    const sessionId = String(p.id)
    const s = await d.store.load(sessionId, user.id)
    if (!s) return reply(false, undefined, "session not found")
    return replyDecide(reply, await d.engine.decideCaptureResult(sessionId, String(p.captureId), {
      html: String(p.html ?? ""),
      imageBase64: p.imageBase64 != null ? String(p.imageBase64) : undefined,
      error: p.error != null ? String(p.error) : undefined,
    }), "页面捕获请求")
  },
}
