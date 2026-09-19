/**
 * 交互卡片（选择询问 / 计划审批 / 环境变量填值）的收缩与高度调整。
 *
 * 卡片渲染在审批容器 `#approvals`（消息区与输入区之间），内容多时会把会话区压到几乎不可见。
 * 这里给卡片装两个操作：卡头右上角的折叠按钮（收缩为预览条 / 展开），以及卡片顶部边缘的拖拽
 * 把手（向下拖到底即收缩、向上拉回即展开，中间为任意高度）。收缩态保留卡片顶部一段内容并底部
 * 渐隐——用户看得到问的是什么，而会话区重新露出。
 *
 * 高度模型是纯函数（可单测）：拖拽给定期望高度，换算成「折叠」或「钳制后的展开高度」。
 * 折叠态与自定义高度写在卡片元素上（`data-folded` / `data-card-h`），同 reqId 重建时由
 * `readCardFoldState` 读回继承，不留模块级状态。
 */
import { el } from "./state"

/* ---------- 高度模型（纯函数） ---------- */

/** 折叠态（预览条）内容区高度：卡片头 + 首行内容。 */
export const CARD_PREVIEW_H = 54
/** 展开态内容区最小高度：再低就没有可操作空间，直接吸附折叠。 */
export const CARD_MIN_EXPANDED_H = 120
/** 拖拽吸附线：内容区低于此值判为「拖到底」，进折叠态。 */
export const CARD_FOLD_SNAP_H = 92
/** 卡头（把手 + 折叠按钮 + 卡片留白）占高：从视口比例上限里扣掉。 */
export const CARD_CHROME_H = 56
/** 单卡高度上限占视口高度的比例：不允许一张卡吃满整屏。 */
export const CARD_MAX_RATIO = 0.6
/** 窄屏（手机）档比例：会话区本就只剩半屏，卡片不能再吃掉大半——否则对话内容直接看不见。 */
export const CARD_MAX_RATIO_NARROW = 0.42
/** 窄屏阈值：与 CSS 布局断点（860px）同一口径。 */
export const CARD_NARROW_W = 860
/** 内容高度不超过预览高度 + 该余量时，折叠没有意义（按钮不出现）。 */
export const CARD_FOLD_MARGIN = 24

/**
 * 单卡内容区高度上限（按视口换算，下限为展开态最小高度）。
 * `viewportW` 省略时不区分窄屏（保持宽屏比例）。
 */
export function cardMaxBodyHeight(viewportH: number, viewportW = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(viewportH) || viewportH <= 0) return CARD_MIN_EXPANDED_H
  const ratio = viewportW <= CARD_NARROW_W ? CARD_MAX_RATIO_NARROW : CARD_MAX_RATIO
  return Math.max(CARD_MIN_EXPANDED_H, Math.round(viewportH * ratio) - CARD_CHROME_H)
}

/** 内容是否高到值得提供折叠：本来就能完整显示时按钮不出现（避免噪声）。 */
export function shouldOfferFold(contentH: number): boolean {
  return Number.isFinite(contentH) && contentH > CARD_PREVIEW_H + CARD_FOLD_MARGIN
}

/**
 * 初始是否就该收起：内容超过该尺寸下能给的高度配额（即本来就会遮挡会话）时，
 * 卡片一出现就是收起的预览条——保留卡片头与首行内容，会话区不被占地。
 * 内容放得下时保持全展开（不动普通卡片的行为）。
 */
export function shouldStartCollapsed(contentH: number, viewportH: number, viewportW = Number.POSITIVE_INFINITY): boolean {
  if (!shouldOfferFold(contentH)) return false
  return contentH > cardMaxBodyHeight(viewportH, viewportW)
}

/**
 * 拖拽求解：期望内容区高度 → 折叠态或钳制后的展开高度。
 * 低于吸附线即折叠（拖到底收缩），否则钳制到 [展开最小高度, 视口比例上限]。
 */
export function resolveCardDrag(bodyH: number, viewportH: number, viewportW = Number.POSITIVE_INFINITY): { collapsed: boolean; height: number } {
  if (!Number.isFinite(bodyH)) return { collapsed: false, height: CARD_MIN_EXPANDED_H }
  if (bodyH < CARD_FOLD_SNAP_H) return { collapsed: true, height: CARD_PREVIEW_H }
  const max = cardMaxBodyHeight(viewportH, viewportW)
  const lo = Math.min(CARD_MIN_EXPANDED_H, max)
  return { collapsed: false, height: Math.round(Math.min(max, Math.max(lo, bodyH))) }
}

/** 键盘调整步长（方向键每次增减的高度）。 */
export const CARD_KEY_STEP = 40

/* ---------- 折叠状态读写 ---------- */

export interface CardFoldInit {
  collapsed?: boolean
  /** 自定义展开高度（内容区 px）；null/未传 = 由内容自然撑开 */
  height?: number | null
}

/** 读回卡片上的折叠态与自定义高度（同 reqId 重渲染时继承，见 renderChoiceCard）。 */
export function readCardFoldState(root: HTMLElement): CardFoldInit {
  const h = Number(root.dataset.cardH)
  return { collapsed: root.dataset.folded === "1", height: Number.isFinite(h) && h > 0 ? h : null }
}

export interface CardFoldHandle {
  setCollapsed(collapsed: boolean): void
  isCollapsed(): boolean
  /** 当前折叠态与自定义高度（写入元素 data 属性，跨重建继承） */
  state(): Required<CardFoldInit>
  destroy(): void
}

function viewportH(): number {
  return typeof window === "undefined" ? 0 : window.innerHeight
}

function viewportW(): number {
  return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth
}

/**
 * 让一张交互卡片可折叠、可拖拽调高。
 * `root` 为卡片根（`.interaction-card`），`body` 为内容区（`.msg-body`，高度受控容器）。
 */
export function makeCardFoldable(root: HTMLElement, body: HTMLElement, init: CardFoldInit = {}): CardFoldHandle {
  root.classList.add("foldable")
  // 折叠态：显式给定（同 reqId 重建继承）就用它；未给定则等首次量到真实内容高度后再定——
  // 内容超过本尺寸能给的高度配额时初始就收起（卡片一出现就不占会话区），能放下则全展开
  let collapsed = init.collapsed === true
  let decided = init.collapsed !== undefined
  let height: number | null = typeof init.height === "number" && init.height > 0 ? init.height : null
  let offered: boolean | null = null

  const grip = el("div", "ic-grip")
  grip.setAttribute("role", "separator")
  grip.setAttribute("aria-orientation", "horizontal")
  grip.tabIndex = 0
  grip.dataset.tip = "拖动调整卡片高度（向下拖到底收缩）"

  const btn = el("button", "ic-fold-btn")
  btn.type = "button"
  root.prepend(grip)
  root.appendChild(btn)

  const contentH = () => body.scrollHeight

  function apply(): void {
    root.classList.toggle("is-collapsed", collapsed)
    root.dataset.folded = collapsed ? "1" : "0"
    // 内容区上限统一走 --ic-max：折叠态为预览高度，展开态为「拖过就用拖出值，没拖过就用本尺寸配额」。
    // 关键：展开态也必须受配额约束——否则未拖过的卡片会按内容自然高度无限长（实测长卡片 1322px），
    // 把会话区挤到只剩一条缝，用户还得在卡片区容器里再滚一次才能看到选项
    const expandedMax = height ?? cardMaxBodyHeight(viewportH(), viewportW())
    root.style.setProperty("--ic-max", `${collapsed ? CARD_PREVIEW_H : expandedMax}px`)
    if (height == null) delete root.dataset.cardH
    else root.dataset.cardH = String(height)
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true")
    const label = collapsed ? "展开卡片" : "收缩卡片"
    btn.setAttribute("aria-label", label)
    btn.dataset.tip = label
  }

  /** 内容本来不高时不提供折叠/拖拽（按钮与把手一起收起）；并在首次量到内容高度时定下初始折叠态。 */
  function syncOffer(): void {
    const h = contentH()
    // 内容高度为 0 说明还没布局（卡片尚未插入文档 / 属于非当前会话被 hidden）：不下判定
    if (!decided && h > 0) {
      decided = true
      collapsed = shouldStartCollapsed(h, viewportH(), viewportW())
      apply()
    }
    const next = shouldOfferFold(h)
    if (next !== offered) {
      offered = next
      root.classList.toggle("fold-idle", !offered)
      btn.hidden = !offered
      grip.hidden = !offered
    }
  }

  /** 拖拽/键盘求解一段位移后的卡片态（基准为拖拽开始时的内容区高度）。 */
  function step(base: number, delta: number): void {
    decided = true // 拖拽同样视为用户显式表态
    const r = resolveCardDrag(base - delta, viewportH(), viewportW())
    collapsed = r.collapsed
    height = r.collapsed ? null : r.height
    apply()
    syncOffer()
  }

  function toggle(): void {
    decided = true // 用户显式表过态，后续不再自动改
    if (collapsed) {
      collapsed = false
      // 恢复展开：沿用上次拖出的高度，没有则回到内容自然高度
      height = height == null ? null : Math.min(height, cardMaxBodyHeight(viewportH(), viewportW()))
    } else {
      collapsed = true
    }
    apply()
    syncOffer()
  }

  let drag: { pid: number; y0: number; base: number } | null = null

  const onDown = (e: PointerEvent) => {
    if (!offered) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    e.preventDefault()
    const h = collapsed ? CARD_PREVIEW_H : body.getBoundingClientRect().height
    drag = { pid: e.pointerId, y0: e.clientY, base: h > 0 ? h : CARD_MIN_EXPANDED_H }
    grip.setPointerCapture?.(e.pointerId)
    root.classList.add("is-dragging")
  }
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pid) return
    e.preventDefault()
    step(drag.base, e.clientY - drag.y0)
  }
  const onUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pid) return
    drag = null
    root.classList.remove("is-dragging")
    grip.releasePointerCapture?.(e.pointerId)
    // 展开态而高度接近内容自然高度：不留自定义高度，随内容自适应
    if (!collapsed && height != null && Math.abs(height - contentH()) < 8) {
      height = null
      apply()
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    e.preventDefault()
    const base = collapsed ? CARD_PREVIEW_H : height ?? body.getBoundingClientRect().height
    step(base, e.key === "ArrowUp" ? CARD_KEY_STEP : -CARD_KEY_STEP)
  }

  btn.addEventListener("click", toggle)
  grip.addEventListener("pointerdown", onDown)
  grip.addEventListener("pointermove", onMove)
  grip.addEventListener("pointerup", onUp)
  grip.addEventListener("pointercancel", onUp)
  grip.addEventListener("keydown", onKey)

  // 视口变化后自定义高度可能越界（横竖屏切换）：重新钳制
  const onResize = () => {
    if (height != null && !collapsed) {
      height = Math.min(height, cardMaxBodyHeight(viewportH(), viewportW()))
      apply()
    }
    syncOffer()
  }
  window.addEventListener("resize", onResize)

  // 内容高度会变（异步撑高：图片/图表/字体；切会话时卡片由隐藏变可见）——用 ResizeObserver 跟内容高度，
  // 而不是只在首帧校一次：卡片属于非当前会话时是 display:none（高度 0），切回来时 RO 会再报一次真实尺寸
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => syncOffer()) : null
  ro?.observe(body)

  apply()
  syncOffer()
  // 无 ResizeObserver 的环境（旧浏览器）：首帧布局完成后再校一次
  if (!ro && typeof requestAnimationFrame === "function") requestAnimationFrame(() => syncOffer())

  return {
    setCollapsed(v: boolean) {
      decided = true
      collapsed = v
      apply()
      syncOffer()
    },
    isCollapsed: () => collapsed,
    state: () => ({ collapsed, height }),
    destroy() {
      ro?.disconnect()
      window.removeEventListener("resize", onResize)
      btn.removeEventListener("click", toggle)
      grip.removeEventListener("pointerdown", onDown)
      grip.removeEventListener("pointermove", onMove)
      grip.removeEventListener("pointerup", onUp)
      grip.removeEventListener("pointercancel", onUp)
      grip.removeEventListener("keydown", onKey)
      grip.remove()
      btn.remove()
      root.classList.remove("foldable", "is-collapsed", "is-dragging", "fold-idle")
      root.style.removeProperty("--ic-max")
      delete root.dataset.cardH
      delete root.dataset.folded
    },
  }
}
