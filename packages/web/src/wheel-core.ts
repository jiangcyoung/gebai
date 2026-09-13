/**
 * 通用「按钮轮盘」原语：hover 入口按钮 → 双弧扇形展开一组按钮。
 *
 * 为什么抽出来：标题栏最右（`wheel.ts`）与文件工作台编辑器右上角（`files/main.ts`）用的是**同一套交互**——
 * 常驻位只留高频动作，其余收进轮盘。复制两遍意味着两套坐标/保持区/收起时序，改一处忘一处
 * （典型症状：一个入口 hover 就能弹、另一个点了才弹；一个外点收起、另一个不收起）。
 * 这里只放**几何与交互**，按钮长什么样、有哪些，全部由调用方给（`items` 里是已经绑好事件的元素）。
 *
 * 布局：两弧——内弧（主组，半径小）与外弧（次组，半径大），两弧之间一条细弧线分区；
 * 屏幕角 0°=正右、90°=正下，扇形朝**下（左）方**展开（入口都在界面上缘，只有向下有空间）。
 *
 * 保持区 = 入口按钮 ∪ 各可见扇形按钮的**边界盒**（外扩 KEEP_PAD）：指针在盒内不收起。
 * 用边界盒而不是精确扇形，是为了容忍指针在两个按钮之间抄近路穿过空隙——精确扇形会在
 * 空隙里判定"离开"，手一抖菜单就收了。
 *
 * 交互：入口 hover 展开（OPEN_DELAY 默认 0）、指针离开保持区 CLOSE_DELAY 后收起、
 * 外点 / Esc / resize 立即收起。**不支持点击切换**（悬停即开，点了也没意义）；
 * 键盘可及性——入口按钮获焦后 Enter/空格/↓ 同样展开，之后 Tab 进扇形按钮。
 * 点击扇形里的按钮后自动收起（点击事件在容器上冒泡到）。
 *
 * 用法：
 * ```ts
 * const w = createWheel({ trigger: btn, items: [{ el: a, group: "inner" }, { el: b }] })
 * // 容器与监听由 destroy() 一并清理（重渲染前务必调用，否则每次重建都多留一份 DOM 与监听）
 * w.destroy()
 * ```
 * 样式见 `css/wheel.css`（容器类默认 `wheel`，扇形按钮统一被加上 `wheel-item` / `wheel-inner`）。
 */
import { el } from "./state"

export interface WheelItem {
  /** 扇形按钮本体（调用方建好、事件已绑） */
  el: HTMLElement
  /** 内弧（主组）还是外弧（次组），缺省外弧 */
  group?: "inner" | "outer"
}

export interface WheelOptions {
  /** 入口按钮（hover 展开，位置即扇形圆心） */
  trigger: HTMLElement
  items: WheelItem[]
  /** 容器类名（默认 `wheel`） */
  containerClass?: string
  /** 内弧半径（px） */
  innerR?: number
  /** 外弧半径（px） */
  outerR?: number
  /** 两弧之间分区弧线的半径（px；0 = 不画） */
  dividerR?: number
  /** 扇形按钮边长（未取到实际尺寸时的兜底 + 保持区计算） */
  buttonSize?: number
  /** 内弧角度区间（屏幕角，度） */
  innerRange?: [number, number]
  /** 外弧角度区间（屏幕角，度） */
  outerRange?: [number, number]
  /** hover 到展开的延迟（0 = 立即） */
  openDelay?: number
  /** 指针离开保持区后的收起延迟 */
  closeDelay?: number
}

export interface WheelHandle {
  open(): void
  close(): void
  isOpen(): boolean
  /** 摘下容器与全部监听（重渲染前调用；之后 handle 不可再用） */
  destroy(): void
}

/** 分区弧线 SVG 的画布边长（弧线用 SVG 画，圆心在画布中心）。 */
const ARC_SVG_SIZE = 300
/** 保持区相对边界盒的外扩（px）。 */
const KEEP_PAD = 8
/** 扇形弹出动画时长（ms；与 css/wheel.css 里的 transition 对齐）。 */
const ANIM_MS = 140
/** 按钮错落弹出的间隔（ms）。 */
const STAGGER_MS = 14

/** 按角度区间均布 n 个角度。 */
function angs(n: number, range: [number, number]): number[] {
  if (n <= 1) return [range[0]]
  return Array.from({ length: n }, (_, i) => range[0] + ((range[1] - range[0]) * i) / (n - 1))
}

/** 半径 + 屏幕角 → [dx, dy] 偏移。 */
function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [r * Math.cos(rad), r * Math.sin(rad)]
}

export function createWheel(opts: WheelOptions): WheelHandle {
  const trigger = opts.trigger
  const items = opts.items
  const innerR = opts.innerR ?? 85
  const outerR = opts.outerR ?? 145
  const dividerR = opts.dividerR ?? 115
  const innerRange = opts.innerRange ?? [93, 147]
  const outerRange = opts.outerRange ?? [97, 153]
  const fallbackSize = opts.buttonSize ?? 32
  const openDelay = opts.openDelay ?? 0
  const closeDelay = opts.closeDelay ?? 250

  // 容器 = hover 保持区 + 分区弧线（挂 body，fixed，不随任何 transform 祖先偏移）
  const keep = el("div", opts.containerClass ?? "wheel")
  document.body.appendChild(keep)
  /** 分区弧线（半径为 0 时不画） */
  let arcEl: SVGSVGElement | null = null
  if (dividerR > 0) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", `0 0 ${ARC_SVG_SIZE} ${ARC_SVG_SIZE}`)
    svg.setAttribute("class", "wheel-arc")
    const c = ARC_SVG_SIZE / 2
    const pt = (deg: number): [number, number] => {
      const rad = (deg * Math.PI) / 180
      return [c + dividerR * Math.cos(rad), c + dividerR * Math.sin(rad)]
    }
    const [x0, y0] = pt(88)
    const [x1, y1] = pt(158)
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
    path.setAttribute("d", `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${dividerR} ${dividerR} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`)
    svg.appendChild(path)
    arcEl = svg
    keep.appendChild(svg)
  }

  // 按钮移入容器（事件绑定在元素上，搬移不失效），并打上统一类名供 CSS 定尺寸
  for (const it of items) {
    it.el.classList.add("wheel-item")
    if (it.group === "inner") it.el.classList.add("wheel-inner")
    keep.appendChild(it.el)
  }

  // 初始收起态（无过渡，先落位再启用动画）
  for (const it of items) {
    it.el.style.transition = "none"
    it.el.style.transform = "translate(0, 0) scale(0.4)"
    it.el.style.opacity = "0"
  }
  void keep.offsetWidth
  for (const it of items) it.el.style.transition = ""

  let expanded = false
  let openTimer: number | null = null
  let closeTimer: number | null = null
  let hideTimer: number | null = null
  let destroyed = false

  /** 按钮实际尺寸（用 offsetWidth/Height 而非 rect：rect 含 transform，收起态的 scale 会缩掉）。 */
  const sizeOf = (node: HTMLElement): { w: number; h: number } => ({ w: node.offsetWidth || fallbackSize, h: node.offsetHeight || fallbackSize })

  function layout(): void {
    const r = trigger.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (arcEl) {
      arcEl.style.left = `${cx - ARC_SVG_SIZE / 2}px`
      arcEl.style.top = `${cy - ARC_SVG_SIZE / 2}px`
    }
    for (const it of items) {
      const { w, h } = sizeOf(it.el)
      it.el.style.left = `${cx - w / 2}px`
      it.el.style.top = `${cy - h / 2}px`
    }
    // 弧位计算 + 保持区收紧为扇形边界盒（入口按钮 ∪ 各可见扇形按钮，外扩 KEEP_PAD）
    let minX = r.left
    let minY = r.top
    let maxX = r.right
    let maxY = r.bottom
    const place = (it: WheelItem, deg: number, rad: number) => {
      const { w, h } = sizeOf(it.el)
      const [dx, dy] = polar(rad, deg)
      it.el.dataset.wheel = `translate(${dx}px, ${dy}px)`
      minX = Math.min(minX, cx - w / 2 + dx)
      minY = Math.min(minY, cy - h / 2 + dy)
      maxX = Math.max(maxX, cx + w / 2 + dx)
      maxY = Math.max(maxY, cy + h / 2 + dy)
    }
    const visible = items.filter((it) => !it.el.hidden)
    const visInner = visible.filter((it) => it.group === "inner")
    const visOuter = visible.filter((it) => it.group !== "inner")
    const innerAngs = angs(visInner.length, innerRange)
    const outerAngs = angs(visOuter.length, outerRange)
    visInner.forEach((it, i) => place(it, innerAngs[i], innerR))
    visOuter.forEach((it, i) => place(it, outerAngs[i], outerR))
    for (const it of items) if (it.el.hidden) it.el.dataset.wheel = "translate(0px, 0px) scale(0.4)"
    keep.style.left = `${minX - KEEP_PAD}px`
    keep.style.top = `${minY - KEEP_PAD}px`
    keep.style.width = `${maxX - minX + KEEP_PAD * 2}px`
    keep.style.height = `${maxY - minY + KEEP_PAD * 2}px`
  }

  function open(): void {
    if (expanded || destroyed) return
    expanded = true
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    layout()
    keep.classList.add("open")
    trigger.classList.add("active")
    trigger.setAttribute("aria-expanded", "true")
    let i = 0
    for (const it of items) {
      if (it.el.hidden) continue
      it.el.style.transitionDelay = `${i++ * STAGGER_MS}ms`
      it.el.style.transform = it.el.dataset.wheel ?? ""
      it.el.style.opacity = "1"
    }
  }

  function close(): void {
    if (!expanded) return
    expanded = false
    if (openTimer) clearTimeout(openTimer)
    for (const it of items) {
      it.el.style.transitionDelay = "0ms"
      it.el.style.transform = "translate(0, 0) scale(0.4)"
      it.el.style.opacity = "0"
    }
    trigger.classList.remove("active")
    trigger.setAttribute("aria-expanded", "false")
    hideTimer = window.setTimeout(() => keep.classList.remove("open"), ANIM_MS + 20)
  }

  function scheduleOpen(): void {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (expanded || openTimer || destroyed) return
    openTimer = window.setTimeout(() => {
      openTimer = null
      open()
    }, openDelay)
  }

  function scheduleClose(): void {
    if (openTimer) clearTimeout(openTimer)
    openTimer = null
    if (!expanded || closeTimer) return
    closeTimer = window.setTimeout(() => {
      closeTimer = null
      close()
    }, closeDelay)
  }

  const onKeepEnter = (): void => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }
  const onDocPointerDown = (e: PointerEvent): void => {
    if (expanded && !keep.contains(e.target as Node) && !trigger.contains(e.target as Node)) close()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close()
  }
  /** 键盘入口：入口按钮获焦后 Enter/空格/↓ 展开（扇形不靠鼠标也能看到；之后 Tab 进扇形按钮）。 */
  const onTriggerKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return
    e.preventDefault()
    open()
  }
  const onResize = (): void => close()
  const onContainerClick = (e: MouseEvent): void => {
    // 点扇形里的按钮就收起（动作已由按钮自己的处理器执行；收起在冒泡阶段做，
    // 保证按钮处理器先跑——有的处理器会顺手重建标签栏，把整个轮盘一起拆掉）
    if ((e.target as HTMLElement | null)?.closest("button")) close()
  }

  trigger.addEventListener("pointerenter", scheduleOpen)
  trigger.addEventListener("pointerleave", scheduleClose)
  trigger.addEventListener("keydown", onTriggerKeyDown)
  keep.addEventListener("pointerenter", onKeepEnter)
  keep.addEventListener("pointerleave", scheduleClose)
  keep.addEventListener("click", onContainerClick)
  document.addEventListener("pointerdown", onDocPointerDown)
  document.addEventListener("keydown", onKeyDown)
  window.addEventListener("resize", onResize)
  /* 这里不监听入口按钮是否被重建（早期用 MutationObserver 做过）：
     入口重建的场景（工作台标签栏重渲染）会 **destroy() 整个轮盘**，容器与监听一并摘掉；
     而 MutationObserver 要看着整个 body 的 childList（工作台里 Monaco 每次击键都会改 DOM），
     为了一个已被 destroy 覆盖的场景常驻一个每帧跑的回调，不值。 */

  return {
    open,
    close,
    isOpen: () => expanded,
    destroy: () => {
      destroyed = true
      if (openTimer) clearTimeout(openTimer)
      if (closeTimer) clearTimeout(closeTimer)
      if (hideTimer) clearTimeout(hideTimer)
      trigger.removeEventListener("pointerenter", scheduleOpen)
      trigger.removeEventListener("pointerleave", scheduleClose)
      trigger.removeEventListener("keydown", onTriggerKeyDown)
      keep.removeEventListener("pointerenter", onKeepEnter)
      keep.removeEventListener("pointerleave", scheduleClose)
      keep.removeEventListener("click", onContainerClick)
      document.removeEventListener("pointerdown", onDocPointerDown)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", onResize)
      trigger.classList.remove("active")
      trigger.setAttribute("aria-expanded", "false")
      keep.remove()
    },
  }
}
