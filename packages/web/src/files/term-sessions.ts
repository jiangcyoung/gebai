/**
 * 终端会话的**跨刷新记忆**：记下本浏览器开过哪些终端会话（服务端发放的会话 id + 当前活动项）。
 *
 * 为什么需要：服务端会话与连接是解耦的——刷新页面/断线都不会销毁 shell（回放缓冲 + `term.attach`，
 * 见 ws-handlers/terminal.ts），但前端此前没有记住 id，刷新后从零开始 `term.open` 新建会话；
 * 而服务端**并发上限是 8**（`TERMINAL_MAX_SESSIONS`）：连刷几次就撞上限，之后新建一律失败。
 * 记住 id 后，刷新只是重新 attach，shell 里跑着的东西（含正在执行的命令）都还在。
 *
 * 存**服务端 id**（PTY 是 `p…`，管道式是服务端另发的 id），不存前端占位 id（`tmpN`，创建未应答期间的临时身份）。
 * 脏数据、换实现（PTY ⇄ 管道式）一律当空处理：两套实现的 id 空间不通用，误用只会 attach 失败。
 */
const KEY = "gebai.ui.termSessions"

/** 终端实现标识：记忆只在自己这一套实现里通用。 */
export type TermKind = "pty" | "legacy"

export interface TermSessionMemory {
  ids: string[]
  /** 活动会话 id；不在 `ids` 里时视为无效（恢复时回落到第一个）。 */
  active: string | null
}

const EMPTY: TermSessionMemory = { ids: [], active: null }

export function readTermSessions(kind: TermKind): TermSessionMemory {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return EMPTY
    const v = JSON.parse(raw) as { kind?: unknown; ids?: unknown; active?: unknown } | null
    if (!v || v.kind !== kind || !Array.isArray(v.ids)) return EMPTY
    const ids = v.ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    if (!ids.length) return EMPTY
    const active = typeof v.active === "string" && ids.includes(v.active) ? v.active : null
    return { ids, active }
  } catch {
    return EMPTY
  }
}

export function writeTermSessions(kind: TermKind, ids: string[], active: string | null): void {
  try {
    if (!ids.length) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify({ kind, ids, active: active && ids.includes(active) ? active : null }))
  } catch {
    /* 隐私模式/配额满：记忆失效不影响本次使用 */
  }
}

/** 记忆的 id 里过滤掉前端占位 id（`tmp1`、`tmp2`…）。 */
export function realSessionIds(ids: string[]): string[] {
  return ids.filter((id) => !/^tmp\d+$/.test(id))
}
