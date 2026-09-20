/** 待决交互卡重建：服务端的审批/选择/填值/画图/捕获请求**只推送一次**（事件已进日志但可能超出重放窗口），
 *  页面刷新、缺口重同步（overrun）后本页收不到——凭服务端待决清单重建卡片，任务才不至于干等到等待超时。
 *  两个入口共用本模块：attach 快照（session.attach 的 pending）与缺口后重同步。 */
import type { PendingInteraction } from "@gebai/sdk"
import { addApproval } from "./approvals"
import { onCaptureRequest, onDrawRender, onToolCall } from "./events"
import { renderChoiceCard, renderEnvRequestCard } from "./messages"
import { client } from "./state"

/** 渲染一条待决交互（同 reqId 重复重建由各卡片自身的替换逻辑去重）。 */
export function renderPendingInteraction(sessionId: string, it: PendingInteraction): void {
  if (it.type === "approval") addApproval(sessionId, it.toolCallId, it.tool)
  else if (it.type === "choice") renderChoiceCard(it.prompt, it.options, it.choiceId, sessionId, it.multi, it.plan ? { title: it.plan.title, content: it.plan.content, path: it.plan.path } : undefined)
  else if (it.type === "env") renderEnvRequestCard(it.name, it.description, it.secret, it.envId, sessionId)
  else if (it.type === "draw") onDrawRender({ sessionId, renderId: it.renderId, code: it.code, format: it.format ?? "" })
  else if (it.type === "capture") onCaptureRequest({ sessionId, captureId: it.captureId, fullPage: it.fullPage, delay: it.delay })
}

/** 重建在途工具卡（attach 快照/缺口重同步共用）：走实时事件的同一渲染入口（`onToolCall`）——参数展示、
 *  toolCallId 配对与后续结果填充与在线路径完全同构（不重建则「等待中的工具卡」随页面丢失）。 */
export function renderPendingToolCalls(
  sessionId: string,
  tools: Array<{ toolCallId: string; name: string; arguments?: Record<string, unknown>; subSessionId?: string }> | undefined,
): void {
  for (const t of tools ?? []) onToolCall({ sessionId, toolCallId: t.toolCallId, name: t.name, arguments: t.arguments, subSessionId: t.subSessionId })
}

/** 重取待决交互与在途工具调用并重建卡片（日志缺口后的重同步路径；失败静默——下次进入会话/重连由 attach 兜底）。 */
export async function resyncPendingInteractions(sessionId: string): Promise<void> {
  try {
    const snap = await client.attachSession(sessionId)
    for (const it of snap?.pending ?? []) renderPendingInteraction(sessionId, it)
    renderPendingToolCalls(sessionId, snap?.tools)
  } catch {
    /* 连接仍不稳定：交给 attach 路径重试 */
  }
}
