/**
 * blame 显示偏好（浏览器本地）。
 *
 * 只有**行尾（inline）**这一态被记忆：它是一条跟随光标的淡色注释，常开不妨碍阅读，
 * 而“打开文件就想看到当前行是谁改的”是稳定习惯；**侧边列（gutter）**占掉一行宽度、信息密度大，
 * 每次打开文件按关闭处理，需要时再点开（会话内不跨文件继承）。
 */
const INLINE_KEY = "gebai.ui.blameInline"

export function readInlineBlame(): boolean {
  try {
    return localStorage.getItem(INLINE_KEY) === "1"
  } catch {
    return false
  }
}

export function saveInlineBlame(on: boolean): void {
  try {
    if (on) localStorage.setItem(INLINE_KEY, "1")
    else localStorage.removeItem(INLINE_KEY)
  } catch {
    /* 隐私模式/配额满：偏好失效不影响本次使用 */
  }
}
