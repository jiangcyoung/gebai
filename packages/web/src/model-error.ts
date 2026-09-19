/**
 * 模型服务异常记录（`event.model.error`：引擎自动重试中的异常）——消息流内的**常驻**记录块。
 *
 * 报错信息是排查依据，不随「模型恢复输出」或「任务结束」一起消失：每次重试留一行，行尾状态随进展更新
 * （重试中 → 已恢复 / 重试未成功）。同一重试序号的行原地更新——断线重连的事件重放不堆叠出重复行。
 */
import { el } from "./state"

/** 行状态：重试中 / 已恢复 / 重试未成功。 */
export type ModelErrorPhase = "retrying" | "recovered" | "failed"

const PHASE_TEXT: Record<ModelErrorPhase, string> = {
  retrying: "，正在自动重试…",
  recovered: "（已恢复，模型继续输出）",
  failed: "（重试未成功）",
}

/** 异常行正文：`模型服务异常（第 N/M 次重试）：<原因>`（无重试序号时省略括号）。 */
export function modelErrorText(retry?: number, maxRetry?: number, error?: string): string {
  const label = retry ? `（第 ${retry}${maxRetry ? `/${maxRetry}` : ""} 次重试）` : ""
  return `模型服务异常${label}：${error ?? ""}`
}

export interface ModelErrorNotice {
  /** 记录块根元素（首次出现时挂到消息流尾部）。 */
  el: HTMLElement
  /** 记一条重试中的异常；`key` 相同视为同一条（重放）原地更新。 */
  record(key: string, text: string): void
  /** 模型恢复输出：末条重试中的行标注为已恢复。 */
  recovered(): void
  /** 任务结束仍在重试中：末条重试中的行标注为重试未成功。 */
  failed(): void
}

interface Line {
  key: string
  el: HTMLElement
  msg: HTMLElement
  status: HTMLElement
  phase: ModelErrorPhase
}

export function createModelErrorNotice(): ModelErrorNotice {
  const root = el("div", "model-error-notice")
  const lines: Line[] = []

  const setPhase = (line: Line, phase: ModelErrorPhase): void => {
    line.phase = phase
    line.el.className = `model-error-line is-${phase}`
    line.status.textContent = PHASE_TEXT[phase]
  }

  /** 末条仍在重试中的行（行按时间追加，重试中的行至多一条——即当前那次重试）。 */
  const pending = (): Line | undefined => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.phase === "retrying") return lines[i]
    return undefined
  }

  return {
    el: root,
    record(key, text) {
      const hit = lines.find((l) => l.key === key)
      if (hit) {
        hit.msg.textContent = text // 重放：同一条原地更新，不新增行
        return
      }
      const line = el("div", "model-error-line is-retrying")
      const msg = el("span", "model-error-msg", text)
      const status = el("span", "model-error-status", PHASE_TEXT.retrying)
      line.append(msg, status)
      root.appendChild(line)
      lines.push({ key, el: line, msg, status, phase: "retrying" })
    },
    recovered() {
      const line = pending()
      if (line) setPhase(line, "recovered")
    },
    failed() {
      const line = pending()
      if (line) setPhase(line, "failed")
    },
  }
}
