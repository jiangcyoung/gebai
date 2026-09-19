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
 * **半径固定，不随项数自动扩大**：内弧与外弧的半径只由调用方给（`innerR`/`outerR`）——弧位拥挤的正解是减项或改分组，
 * 拿半径去让路会把“两圈”变成一大一小两个不清不楚的圈。角度**从起始角向左侧长**（起始角固定，
 * 对称外扩会把首个按钮顶出屏幕右缘），上限 = min(maxSpan, 不越过入口那一行)，上限内尽量拉到「边长 + 间隙」，
 * 拉不开就停在上限（宁可挤一点，也不改半径）。唯一会往外让的是**外弧的半径下限**：
 * 至少要离内弧一个按钮位，否则两弧贴脸也会视觉重叠。
 *
 * 保持区 = 入口按钮 ∪ 各可见扇形按钮的**边界盒**（外扩 KEEP_PAD）：指针在盒内不收起。
 * 用边界盒而不是精确扇形，是为了容忍指针在两个按钮之间抄近路穿过空隙——精确扇形会在
 * 空隙里判定"离开"，手一抖菜单就收了。
 *
 * **保持区不吃指针事件**：容器是一块覆盖整盒的实心矩形，而盒下面往往正是标签栏/消息区里的真实控件
 * （入口在界面右上角，扇形向下左展开，盒子自然压住它们）。容器若可命中，展开期间那些控件就都点不到
 * 了——点击落在容器上，既不触发下方按钮、也不算“点了外面”（典型症状：hover 轮盘入口后，旁边那颗
 * 常驻按钮就点不动了）。所以容器一律 `pointer-events: none`（见 css/wheel.css），只有扇形按钮
 * 自己 `pointer-events: auto`；“指针还在保持区内”改由 document 上的 pointermove 用坐标比对判定
 * （展开期间才挂，收起态不跑）。
 *
 * 交互：鼠标（细指针）入口 hover 展开（OPEN_DELAY 默认 0）、指针离开保持区 CLOSE_DELAY 后收起；
 * 触屏（粗指针）没有 hover，改为**点按入口开合**（同一个入口按钮再点一下收起），
 * 同时不挂 hover 的开/收时序（触屏上 pointerenter/leave 会紧跟同一根手指触发，
 * 会把刚展开的扇形立刻定时收起）。外点 / Esc / resize 立即收起，两种指针都一样；
 * 键盘可及性——入口按钮获焦后 Enter/空格/↓ 同样展开，之后 Tab 进扇形按钮。
 * 点击扇形里的按钮后自动收起（点击事件在容器上冒泡到，与容器是否可命中无关）。
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
import { popKeyScope, pushEscScope } from "./keymap"

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
  /** 内弧半径（px；项多时会自动加大，这是首选项） */
  innerR?: number
  /** 外弧半径（px；项多时会自动加大，这是首选项） */
  outerR?: number
  /** 两弧之间分区弧线的半径（px；0 = 不画。默认取两弧半径的中点） */
  dividerR?: number
  /** 扇形按钮边长（未取到实际尺寸时的兜底 + 保持区计算） */
  buttonSize?: number
  /** 弧上相邻按钮的间隙（px；自适应扩角/加半径按它算） */
  buttonGap?: number
  /** 单弧最大张角（度）：超过则不再拉大角度（半径固定，不允许为了塞下多撑弧） */
  maxSpan?: number
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

/** 分区弧线 SVG 的最小画布边长（弧线用 SVG 画，圆心在画布中心；实际按分区半径放大）。 */
const ARC_SVG_MIN = 300
/** 保持区相对边界盒的外扩（px）。 */
const KEEP_PAD = 8
/** 扇形弹出动画时长（ms；与 css/wheel.css 里的 transition 对齐）。 */
const ANIM_MS = 140
/** 按钮错落弹出的间隔（ms）。 */
const STAGGER_MS = 14

/** 单弧几何结果：有效半径与各项角度（度）。 */
interface ArcFit {
  r: number
  angles: number[]
}

/** 角度（度）转弧度。 */
const rad = (deg: number): number => (deg * Math.PI) / 180

/** 在起始角 start 起、张角 span 上均布 count 项的角度。 */
function spreadAngles(start: number, span: number, count: number): number[] {
  if (count <= 1) return [start]
  return Array.from({ length: count }, (_, i) => start + (span * i) / (count - 1))
}

/**
 * 该角度序列在半径 r 上是否「两两不叠」。
 *
 * 判定用**方块的实际不重叠条件**（|Δx| ≥ 边长 或 |Δy| ≥ 边长），不是圆心距/弦长——
 * 斜向相邻（弦与坐标轴成 45° 附近）时弦长达标、两个正方形仍会压住几个像素，那正是「看着叠在一起」。
 */
function arcFits(r: number, angles: number[], minGap: number): boolean {
  for (let i = 1; i < angles.length; i++) {
    const dx = Math.abs(r * (Math.cos(rad(angles[i]!)) - Math.cos(rad(angles[i - 1]!))))
    const dy = Math.abs(r * (Math.sin(rad(angles[i]!)) - Math.sin(rad(angles[i - 1]!))))
    if (Math.max(dx, dy) + 1e-6 < minGap) return false
  }
  return true
}

/**
 * 算一弧的角度：让相邻按钮方块尽量拉开到「边长 + 间隙」。
 *
 * **半径固定不动**（上游给多少就是多少）：为了多塞按钮而把弧撑大，是在用“看着还是两圈吗”换“一排能放下”——
 * 弧位拥挤的正确解法是减项或改分组（内圈往外挪按钮），不是拿半径去让路。所以本函数只调**角度**，
 * 在张角上限内尽量满足间隙；上限内满足不了就停在上限（宁可挤一点，也不改弧的半径）。
 *
 * 张角**从起始角向左侧长**（起始角固定）——对称外扩会在入口靠窗口右缘时把首个按钮顶出屏幕。
 * 张角上限 = min(maxSpan, 终点角不超过 dyMin 对应的角)，后者保证最上方那个按钮仍落在锚点行**下方**。
 *
 * 纯函数（不读闭包状态）：几何是轮盘最容易被改坏的部分，参数化后能直接单测。
 */
function fitArc(o: {
  count: number
  size: number
  gap: number
  r: number
  start: number
  prefEnd: number
  maxSpan: number
  /** 终点角处的最小纵向偏移（px）：按钮中心相对圆心的 dy 不得小于它（否则压住锚点行） */
  dyMin: number
}): ArcFit {
  const { count, size, gap, r, start, prefEnd, maxSpan, dyMin } = o
  const spanPref = Math.max(0, prefEnd - start)
  if (count <= 0) return { r, angles: [] }
  if (count === 1) return { r, angles: [start + spanPref / 2] }
  const endLimit = dyMin <= 0 || dyMin >= r ? 180 : 180 - (Math.asin(dyMin / r) * 180) / Math.PI
  const cap = Math.max(0, Math.min(maxSpan, endLimit - start))
  // 在 [首选张角, 上限] 里二分出「刚好拉开到间隙要求」的最小张角
  let lo = Math.min(spanPref, cap)
  let hi = cap
  if (arcFits(r, spreadAngles(start, hi, count), size + gap)) {
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2
      if (arcFits(r, spreadAngles(start, mid, count), size + gap)) hi = mid
      else lo = mid
    }
  }
  return { r, angles: spreadAngles(start, hi, count) }
}

/** 触屏（粗指针）：无 hover 语义，轮盘改点按开合（见文件头交互说明）。 */
function coarsePointer(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches === true
  } catch {
    return false
  }
}

/** 半径 + 屏幕角 → [dx, dy] 偏移。 */
function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180
  return [r * Math.cos(rad), r * Math.sin(rad)]
}

export function createWheel(opts: WheelOptions): WheelHandle {
  const trigger = opts.trigger
  const items = opts.items
  const innerR0 = opts.innerR ?? 85
  const outerR0raw = opts.outerR ?? 145
  const gap = opts.buttonGap ?? 8
  const maxSpan = opts.maxSpan ?? 100
  const innerRange = opts.innerRange ?? [93, 147]
  const outerRange = opts.outerRange ?? [97, 153]
  const fallbackSize = opts.buttonSize ?? 32
  const openDelay = opts.openDelay ?? 0
  const closeDelay = opts.closeDelay ?? 250

  // 容器 = hover 保持区 + 分区弧线（挂 body，fixed，不随任何 transform 祖先偏移）
  const keep = el("div", opts.containerClass ?? "wheel")
  document.body.appendChild(keep)
  /** 分区弧线（半径/张角随实际弧位在 layout 里重算；dividerR=0 时不画） */
  const arcSvg = opts.dividerR === 0 ? null : document.createElementNS("http://www.w3.org/2000/svg", "svg")
  const arcPath = opts.dividerR === 0 ? null : document.createElementNS("http://www.w3.org/2000/svg", "path")
  if (arcSvg && arcPath) {
    arcSvg.setAttribute("class", "wheel-arc")
    arcSvg.appendChild(arcPath)
    keep.appendChild(arcSvg)
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
    for (const it of items) {
      const { w, h } = sizeOf(it.el)
      it.el.style.left = `${cx - w / 2}px`
      it.el.style.top = `${cy - h / 2}px`
    }
    const visible = items.filter((it) => !it.el.hidden)
    const visInner = visible.filter((it) => it.group === "inner")
    const visOuter = visible.filter((it) => it.group !== "inner")
    /** 该弧里最大的按钮边长（自适应按最大者算，大小不一也不会叠）。 */
    const maxSize = (list: WheelItem[]): number =>
      list.reduce((m, it) => { const s = sizeOf(it.el); return Math.max(m, s.w, s.h) }, fallbackSize)
    /**
     * 终点角处按钮中心的最小纵向偏移：按钮顶边不得超过入口按钮的底边（否则压到入口那一行）。
     * 最长的按钮按 maxSize 估，宁可多留一点。
     */
    const dyMin = (r.bottom - cy) + maxSize(visible) / 2 + 4
    const innerFit = fitArc({
      count: visInner.length,
      size: maxSize(visInner),
      gap,
      r: innerR0,
      start: innerRange[0],
      prefEnd: innerRange[1],
      maxSpan,
      dyMin,
    })
    // 外弧至少离内弧一个「按钮 + 间隙」：两弧贴脸时按钮同样会视觉重叠（半径不同不代表够远）。
    // 注意：这只调**外弧**往外让，内弧半径永不为“塞下更多按钮”而动。
    const outerFit = fitArc({
      count: visOuter.length,
      size: maxSize(visOuter),
      gap,
      r: visInner.length ? Math.max(outerR0raw, innerFit.r + maxSize(visInner) + gap) : outerR0raw,
      start: outerRange[0],
      prefEnd: outerRange[1],
      maxSpan,
      dyMin,
    })

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
    visInner.forEach((it, i) => place(it, innerFit.angles[i]!, innerFit.r))
    visOuter.forEach((it, i) => place(it, outerFit.angles[i]!, outerFit.r))
    for (const it of items) if (it.el.hidden) it.el.dataset.wheel = "translate(0px, 0px) scale(0.4)"

    // 分区弧线：半径取两弧中点，张角覆盖两弧实际跨过的角度（两弧都在时才画）
    if (arcSvg && arcPath) {
      const both = visInner.length > 0 && visOuter.length > 0
      arcSvg.style.display = both ? "" : "none"
      if (both) {
        const dr = opts.dividerR ?? (innerFit.r + outerFit.r) / 2
        const lo = Math.min(innerFit.angles[0]!, outerFit.angles[0]!) - 4
        const hi = Math.max(innerFit.angles[innerFit.angles.length - 1]!, outerFit.angles[outerFit.angles.length - 1]!) + 4
        const box = Math.max(ARC_SVG_MIN, Math.ceil((dr + 16) * 2))
        const c = box / 2
        const pt = (deg: number): [number, number] => {
          const rad = (deg * Math.PI) / 180
          return [c + dr * Math.cos(rad), c + dr * Math.sin(rad)]
        }
        const [x0, y0] = pt(lo)
        const [x1, y1] = pt(hi)
        arcPath.setAttribute("d", `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${dr} ${dr} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`)
        arcSvg.setAttribute("viewBox", `0 0 ${box} ${box}`)
        // 显式定尺寸（CSS 里的 300px 只是兜底）：SVG 根元素没有 width/height 时会按包含块缩放，半径就不是算出来的值了
        arcSvg.style.left = `${cx - box / 2}px`
        arcSvg.style.top = `${cy - box / 2}px`
        arcSvg.style.width = `${box}px`
        arcSvg.style.height = `${box}px`
      }
    }

    keep.style.left = `${minX - KEEP_PAD}px`
    keep.style.top = `${minY - KEEP_PAD}px`
    keep.style.width = `${maxX - minX + KEEP_PAD * 2}px`
    keep.style.height = `${maxY - minY + KEEP_PAD * 2}px`
  }

  function open(): void {
    if (expanded || destroyed) return
    expanded = true
    scopeId = pushEscScope("main.wheel", "收起动作轮盘", close)
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    layout()
    document.addEventListener("pointermove", onDocPointerMove)
    // 捕获阶段：文档根的 pointerleave 不冒泡，靠捕获才收得到
    document.addEventListener("pointerleave", onDocPointerLeave, true)
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

/** 展开期间入栈的 Esc 作用域 id（收起即出栈，见 open / close）。 */
  let scopeId: string | null = null

  function close(): void {
    if (!expanded) return
    expanded = false
    if (scopeId) {
      popKeyScope(scopeId)
      scopeId = null
    }
    document.removeEventListener("pointermove", onDocPointerMove)
    document.removeEventListener("pointerleave", onDocPointerLeave, true)
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
    if (coarsePointer()) return // 触屏走点按开合，hover 时序只在细指针下生效
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
    if (coarsePointer()) return
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
  /**
   * 指针是否还在保持区内。
   *
   * 容器 `pointer-events: none`（不能吞掉下方控件的点击，见文件头），所以容器自身的
   * pointerenter/pointerleave 永远不会触发——“指针还在扇形附近”只能靠坐标判定：
   * 展开期间在 document 上挂一个 pointermove，逐次拿指针坐标比对容器矩形。
   * 挂/摘跟着展开态走（收起态全程不跑回调）；矩形每次都现读：保持区尺寸随弧位在 layout 里重算，
   * 展开期间窗口尺寸变化会先 close，不存在“盒子变了而监听还指着旧坐标”的窗口。
   */
  const onDocPointerMove = (e: PointerEvent): void => {
    if (!expanded) return
    const b = keep.getBoundingClientRect()
    const inside = e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom
    if (inside) onKeepEnter()
    else scheduleClose()
  }
  /**
   * 指针移出**文档**（切到别的窗口、贴到系统界面）：之后不会再产生 pointermove，保持区判定
   * 就收不到“离开”信号了，得手动收起。只在事件目标就是文档根时响应——元素级的 pointerleave
   * 也会被这个捕获监听收到（如指针从入口滑到扇形按钮上），而那些恰恰是“指针还在页面里”。
   */
  const onDocPointerLeave = (e: PointerEvent): void => {
    if (expanded && e.target === document.documentElement) scheduleClose()
  }
  const onDocPointerDown = (e: PointerEvent): void => {
    if (expanded && !keep.contains(e.target as Node) && !trigger.contains(e.target as Node)) close()
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

  /** 触屏点按入口开合（细指针下 hover 已经展开，这里不参与）。 */
  const onTriggerClick = (): void => {
    if (!coarsePointer()) return
    if (expanded) close()
    else open()
  }
  trigger.addEventListener("pointerenter", scheduleOpen)
  trigger.addEventListener("pointerleave", scheduleClose)
  trigger.addEventListener("click", onTriggerClick)
  trigger.addEventListener("keydown", onTriggerKeyDown)
  keep.addEventListener("click", onContainerClick)
  document.addEventListener("pointerdown", onDocPointerDown)
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
      trigger.removeEventListener("click", onTriggerClick)
      trigger.removeEventListener("keydown", onTriggerKeyDown)
      keep.removeEventListener("click", onContainerClick)
      document.removeEventListener("pointermove", onDocPointerMove)
      document.removeEventListener("pointerleave", onDocPointerLeave, true)
      document.removeEventListener("pointerdown", onDocPointerDown)
      window.removeEventListener("resize", onResize)
      trigger.classList.remove("active")
      trigger.setAttribute("aria-expanded", "false")
      keep.remove()
    },
  }
}
