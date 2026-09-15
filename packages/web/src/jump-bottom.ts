import { jumpBottom, msgEl } from "./state"
import { createStickyScroll } from "./sticky-scroll"
import { autoHideScrollbar } from "./ui"
import { bindWindowFollow } from "./msg-window"

/** 粘底滚动（逻辑见 sticky-scroll.ts）：真实 DOM 绑定入口，各模块经命名导出使用。 */
const sticky = createStickyScroll(msgEl, jumpBottom)
autoHideScrollbar(msgEl)

// 窗口化据此判定「DOM 变更后是否保持贴底」并交回对齐职责：贴底与否只由跟随意图决定
// （几何贴底在运行中会话会被流式增长反复打破），赋值后用 contentChanged 让跟随核心咬住底部
bindWindowFollow(sticky.isFollowing, sticky.scrollIfSticky)

export const isAtBottom = sticky.isAtBottom
export const isFollowing = sticky.isFollowing
export const scrollIfSticky = sticky.scrollIfSticky
export const lockToBottom = sticky.lockToBottom
export const restoreScroll = sticky.restoreScroll
export const stopFollowing = sticky.stopFollowing
export const noteIncoming = sticky.noteIncoming
export const clearUnread = sticky.clearUnread
export const refreshJumpBottom = sticky.refresh
