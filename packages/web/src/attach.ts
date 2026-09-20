/** 运行中会话附加恢复（自 main.ts 拆分）：attach 快照应用与待决交互卡重渲染。 */
import { renderPendingInteraction, renderPendingToolCalls } from "./pending-interactions"
import { setRunningAttach } from "./sessions"
import { attaching, client, runs } from "./state"
import { consumeTaskStream } from "./stream"

/** 附加运行中会话（DESIGN「运行中会话恢复」，loadMessages 尾部钩子调用）：
 *  页面刷新/切换进入运行中会话时——快照（在途流 + 待决交互）→ 待决卡片重建（审批/选择/填值/
 *  画图/捕获的事件已推送过、本页收不到，不重建则任务干等到超时）→ consumeTaskStream 接管
 *  attachStream（在途文本种子 + 实时续流，与发起页同构渲染：流式消息/工具卡/信号灯/停止按钮/
 *  单轮计时）。未运行或本页已接管（发起/附加过）时 no-op。 */
async function attachRunningSession(sessionId: string): Promise<void> {
  if (runs.has(sessionId) || attaching.has(sessionId)) return
  attaching.add(sessionId)
  let attached = false
  try {
    const snap = await client.attachSession(sessionId)
    if (!snap?.running) return // 未运行：无需接管，不算失败
    for (const it of snap.pending ?? []) renderPendingInteraction(sessionId, it)
    // 在途工具调用（已发出未出结果）：重建「等待中的工具卡」，结果到达时按 toolCallId 配对填充
    renderPendingToolCalls(sessionId, snap.tools)
    attached = true
    await consumeTaskStream(sessionId, (run) => client.attachStream(sessionId, { signal: run.abort.signal }), { startedAt: snap.startedAt })
  } catch {
    /* 附加失败：见 finally 的退避重试 */
  } finally {
    attaching.delete(sessionId)
    // 静默失败会让界面谎报空闲（无信号灯/停止按钮/单轮计时），用户此后的发送还会被 already_running
    // 拒绝——退避重试，仍失败则交给「下次进入会话 / 重连快照 running 清单」的常规路径
    if (!attached) scheduleAttachRetry(sessionId)
  }
}

/** 附加失败的退避重试（1s/3s/9s 共三次）：已接管（本页 runs 建立）即停。 */
function scheduleAttachRetry(sessionId: string, attempt = 1): void {
  if (attempt > 3) return
  setTimeout(() => {
    if (runs.has(sessionId) || attaching.has(sessionId)) return
    void attachRunningSession(sessionId).then(() => {
      if (!runs.has(sessionId)) scheduleAttachRetry(sessionId, attempt + 1)
    })
  }, attempt * attempt * 1000)
}
setRunningAttach(attachRunningSession)
