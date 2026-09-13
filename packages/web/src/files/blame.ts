/**
 * 行内 blame 的数据与展示规则（纯逻辑，无 DOM / Monaco 依赖，可单测）。
 *
 * 两种显示形态共用同一份数据（服务端 `/git/blame` 的逐行结果）：
 * - **侧边列**：编辑器左侧一整列，逐行显示「作者 · 时间」（全局一目了然）；
 * - **光标行行尾**：光标所在行行尾追加同样的注释，样式更弱（视线内的当前行提示）。
 *
 * 文本口径：时间用**相对值**（`timeAgo`）。blame 关心的是「多久前有人动过这里」，
 * 而 `2026-09-13 13:25` 要占 16 个字符——每行都摆完整时间戳，注释会比代码还长。
 * 完整时间与提交摘要在悬浮提示里（`blameHover`）。
 */
import { timeAgo } from "./ui"

export interface BlameLine {
  /** 1 起始行号 */
  line: number
  hash: string
  author: string
  time: number
  summary: string
  /** 未提交的行（git 给的是占位哈希）：出处无法归因 */
  uncommitted: boolean
}

/** 作者名最长保留字符数：超长会在行首/行尾注释里多占列宽（列宽固定，超出即省略）。 */
const AUTHOR_MAX = 14

/** 注释文本（侧边列与行尾共用）：`作者 · 时间`；未提交的行只标「未提交」。 */
export function blameLabel(l: Pick<BlameLine, "author" | "time" | "uncommitted">): string {
  // 未提交的行不写作者：此时 git 给的是占位名（Not Committed），写出来只是「Not Committed · 未提交」的重复
  if (l.uncommitted) return "未提交"
  const who = (l.author || "未知").slice(0, AUTHOR_MAX)
  return `${who} · ${timeAgo(l.time)}`
}

/** 悬浮提示（单行）：哈希 + 作者 + 时间 + 提交摘要。 */
export function blameHover(l: BlameLine): string {
  const when = l.uncommitted ? "未提交" : new Date(l.time).toLocaleString()
  return `${l.hash.slice(0, 8)} · ${l.author || "未知"} · ${when}${l.summary ? ` · ${l.summary}` : ""}`
}

/** 行号 → 条目（渲染按行查表，避免每帧线性扫）。 */
export function toBlameIndex(lines: BlameLine[]): Map<number, BlameLine> {
  const map = new Map<number, BlameLine>()
  for (const l of lines) if (l.line >= 1) map.set(l.line, l)
  return map
}
