/**
 * 特效主题的面板玻璃形态（性能 / 观感的用户取舍，默认「毛玻璃」= 现状）：
 *
 * 特效主题把 `main` 背景透明化以透出全屏特效画布，标题栏/侧栏等大面积常驻面板隔着画布做
 * `backdrop-filter`——采样源每帧变化，模糊结果无法缓存，每帧全量重光栅化（面板约占视口 1/4）。
 * 慢机上表现为整体掉帧（与「特效档次」无关，是面板模糊自身的成本）。
 *
 * 「实底」形态：面板去掉模糊、底色加实（`--bg-elev` 88% 不透明），换回满帧；观感与毛玻璃接近
 * （面板仍与画布有分离度），代价是失去毛玻璃透光感。由根元素 `data-fx-panels="matte"` 表达，
 * CSS 规则见 css/base.css。
 *
 * 纯本机偏好：localStorage `gebai.ui.fxPanels` = "matte"（实底）；不存/其它值 = 毛玻璃。
 */

const KEY = "gebai.ui.fxPanels"

export type FxPanelsSetting = "glass" | "matte"

/** 当前设置（默认 glass = 毛玻璃，即不改观感的现状）。 */
export function getFxPanelsSetting(): FxPanelsSetting {
  try {
    return localStorage.getItem(KEY) === "matte" ? "matte" : "glass"
  } catch {
    return "glass"
  }
}

/** 应用设置：根元素 data-fx-panels 标记（CSS 据此切换面板形态）。 */
export function applyFxPanels(): void {
  const el = document.documentElement
  const prev = el.dataset.fxPanels
  const next = getFxPanelsSetting() === "matte" ? "matte" : undefined
  if (next) el.dataset.fxPanels = next
  else delete el.dataset.fxPanels
  if (prev !== next) document.dispatchEvent(new CustomEvent("gebai:fx-panels-change", { detail: { matte: next === "matte" } }))
}

/** 手动设置（设置面板「外观」）：持久化 + 立即生效。 */
export function setFxPanelsSetting(v: FxPanelsSetting): void {
  try {
    if (v === "matte") localStorage.setItem(KEY, "matte")
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式忽略 */
  }
  applyFxPanels()
}

/** 初始化（main）：应用持久化设置 + 跨标签同步。 */
export function initFxPanels(): void {
  applyFxPanels()
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) applyFxPanels()
  })
}
