/**
 * 编辑器自动换行（word wrap）的**用户级偏好**：跨刷新与两个入口（独立 `/files` 页、分屏 iframe）一致。
 *
 * Alt+Z 的键位判定在键位表里（`keymap.ts` 的 `Alt+Z` 绑定由 `files/main.ts` 声明，捕获阶段接管 Monaco
 * 自带的 `editor.action.toggleWordWrap`）；本模块只管偏好读写与按钮文案。
 */
const WRAP_KEY = "gebai.ui.wordWrap"

/** 自动换行是否开启（缺省关闭：代码的横向滚动是默认阅读方式，长行折行会打乱缩进与对齐的观感）。 */
export function readWordWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === "1"
  } catch {
    return false
  }
}

/** 记住开关（关闭时清键而不是写 "0"，不留残留；隐私模式/配额满时静默失效）。 */
export function saveWordWrap(on: boolean): void {
  try {
    if (on) localStorage.setItem(WRAP_KEY, "1")
    else localStorage.removeItem(WRAP_KEY)
  } catch {
    /* 偏好失效不影响本次使用 */
  }
}

/** 轮盘按钮的提示文案：动作（快捷键），与标签栏其他入口同调。 */
export function wordWrapTitle(on: boolean): string {
  return `${on ? "关闭自动换行" : "开启自动换行"}（Alt+Z）`
}
