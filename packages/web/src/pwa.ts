/**
 * 「安装为应用」（PWA）：浏览器里把歌白装成**应用窗口**——独立窗口、无地址栏与标签栏。
 *
 * 为什么值得装：Chromium 只在普通浏览器窗口里保留那一小撮按键（`Ctrl+N/T/W`、`Ctrl+Tab`…，见
 * `keymap.ts` 的 `browserConflict()`）；应用窗口（`TYPE_APP`）与独立显示模式下 `IsReservedCommandOrKey()`
 * 直接返回 false，所有按键都归页面。键位本身不分形态（只有一套，取的都是各形态可达的键），
 * 但应用窗口里连浏览器自带的那些手势也不会再抢键，输入更干净。
 *
 * 入口只在浏览器**主动判定可安装**时出现（`beforeinstallprompt`）：不满足条件（非安全上下文、
 * manifest/图标取不到、已安装过）就不显示，不做假入口。iOS Safari 不派发该事件
 * （其安装路径是「分享 → 添加到主屏幕」），那里按钮不会出现。
 */
let deferred: { prompt: () => Promise<unknown>; userChoice?: Promise<unknown> } | null = null

/** 绑定安装入口（标题栏图标按钮；`beforeinstallprompt` 到达前保持隐藏）。 */
export function bindInstall(): void {
  const btn = document.getElementById("install-btn") as HTMLButtonElement | null
  if (!btn) return
  // 已在应用窗口里（standalone / 桌面启动器形态）：没有可安装的东西
  if (window.matchMedia?.("(display-mode: standalone)").matches) return
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault() // 拦下浏览器的默认横幅，改由标题栏按钮在用户想要的时机触发
    deferred = e as unknown as { prompt: () => Promise<unknown> }
    btn.hidden = false
  })
  window.addEventListener("appinstalled", () => {
    deferred = null
    btn.hidden = true
  })
  btn.onclick = () => {
    const d = deferred
    if (!d) return
    // 系统弹窗只能调一次，用掉即收起入口（再次安装需重新满足可安装条件）
    deferred = null
    btn.hidden = true
    void d.prompt()
  }
}
