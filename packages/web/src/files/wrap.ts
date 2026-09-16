/**
 * 编辑器自动换行（word wrap）的**用户级偏好**与快捷键判定。
 *
 * 为什么单独一个文件：偏好要跨刷新与两个入口（独立 `/files` 页、分屏 iframe）一致，Alt+Z 的判定要能
 * 直接单测——`Alt+Z` 在 Monaco 里有内置绑定（`editor.action.toggleWordWrap`），工作台要用自己的
 * 开关接管它（见 `files/main.ts` 的捕获阶段监听），判定写在这里才测得到。
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

/** 快捷键事件的最小形状（与 KeyboardEvent 结构兼容，便于用例直接构造字面量）。 */
export interface HotkeyEvent {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * 是否 **Alt+Z**（VSCode 的 toggle word wrap）。
 * 只认「Alt 单独 + Z」：Ctrl / Shift / Meta 任一在场都不算这个手势（`Ctrl+Alt+Z` 之类在别处另有语义），
 * 大小写不敏感（按住 Shift 才出大写 Z，而 Shift 已被排除，这里兼容键盘布局差异）。
 */
export function isWordWrapHotkey(e: HotkeyEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "z"
}

/** 轮盘按钮的提示文案：动作（快捷键），与标签栏其他入口同调。 */
export function wordWrapTitle(on: boolean): string {
  return `${on ? "关闭自动换行" : "开启自动换行"}（Alt+Z）`
}
