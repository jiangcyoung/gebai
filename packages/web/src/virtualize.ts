/**
 * 消息列 DOM 窗口化——DOM 编排层（坐标算术见 virtual-window.ts）：
 *
 * DOM 结构（#messages 的直接子节点）：
 *   [.vz-spacer.top] [挂载中的块 .vz-block …] [.vz-spacer.bottom] [尾部活动区节点 …]
 *
 * - **块**是最小挂载单位（一段连续消息，划分规则见 history-chunk.ts）：未挂载时只有一侧
 *   spacer 的高度，挂载时是容器里的真实节点（高度实测）。已渲染节点的引用常驻——卸载只是
 *   从 DOM 摘下，重挂零重建（在途流 `run.el`、工具卡 `pendingTools`、子会话容器 body 等运行态
 *   引用因此不掉线）。
 * - **尾部活动区**（新消息 / 在途流 / 工具卡 / 异常提示）恒定挂载在末尾，其高度由 DOM 真实
 *   承担，不参与估高。
 * - 滚动位置稳定：以「视口顶部块 + 块内偏移」为锚点，DOM 变更（渲染实测、卸载、spacer 更新）
 *   后同帧把 `scrollTop` 修正回锚点位置——向下滚动时卸载的都是刚测过的真实高度（零补偿），
 *   向上滚动时新挂载块由估高变实测，差值由锚点补齐。
 * - 安全阀：视口不可测（`clientHeight <= 0`，测试替身 / 容器隐藏）时区间取全部块——退化为
 *   「不窗口化」，语义与窗口化前一致。
 */

import { createVzModel, type VzModel, type VzRange, type VzSlotSeed } from "./virtual-window"

/** 视口上方预挂载余量（视口高度倍数）：与下方对称——上滚时也先渲染再进入视野，避免视口落进估高区域。 */
const MARGIN_ABOVE = 1.5
/** 视口下方预挂载余量：滚动主要向下，留足一屏半。 */
const MARGIN_BELOW = 1.5
/** 贴底阈值（px）：与粘底跟随（sticky-scroll）同口径——距底不超过该值视为在底部。 */
const BOTTOM_THRESHOLD = 64

export interface VirtualizeOpts {
  container: HTMLElement
  /** 渲染第 index 号块：把该块的消息节点 append 进 host（同步；host 尚未入 DOM）。 */
  renderBlock: (index: number, host: HTMLElement) => void
}

export interface Virtualizer {
  /** 重设块表并落底（会话切换 / 重新加载）：清空容器（含尾部活动区）后建立 spacer。 */
  reset(seeds: VzSlotSeed[]): void
  /** 按当前滚动位置立即同步挂载集合（含锚定补偿）。 */
  sync(): void
  /** 尾部活动区挂载（恒在 spacer 之后，恒挂载）。 */
  appendTail(node: Node): void
  /** 当前视口顶部锚点（顶部 / 落在尾部活动区时返回 null）。 */
  anchor(): { key: string; offset: number } | null
  /** 按锚点恢复滚动位置（跨会话记忆）；返回落位后的 scrollTop，键不存在返回 null。 */
  scrollToAnchor(key: string, offset: number): number | null
  /** 块 key → 全渲染坐标（导航高亮）；不存在返回 null。 */
  posOfKey(key: string): number | null
  /** 块 key → 当前采用高度。 */
  heightOfKey(key: string): number | null
  /** 注入「是否处于粘底跟随」判定（意图驱动；省略时用几何贴底判定）。 */
  setFollowSource(fn: (() => boolean) | null): void
  /** 注入「内容已变更」通知（贴底赋值后交跟随核心接手后续对齐）。 */
  setContentChangedHook(fn: (() => void) | null): void
  /** 容器内容原点（padding-top）：块坐标 → 屏幕坐标的换算偏移（导航高亮用）。 */
  contentTop(): number
}

export function createVirtualizer(opts: VirtualizeOpts): Virtualizer {
  const container = opts.container
  const model: VzModel = createVzModel()
  const padTop = document.createElement("div")
  const padBottom = document.createElement("div")
  padTop.className = "vz-spacer"
  padBottom.className = "vz-spacer"
  /** 已渲染块的容器（未渲染为 undefined；卸载只摘 DOM，引用常驻）。 */
  const blocks: Array<HTMLElement | undefined> = []
  const blockIndexOf = new Map<Element, number>()
  /** 容器内容原点（padding-top）：scrollTop 从 padding 盒顶起算，块坐标从首个块顶起算。 */
  let origin = 0
  let rafId = 0
  let syncing = false
  let resetting = false
  let followSource: (() => boolean) | null = null
  let contentChangedHook: (() => void) | null = null

  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame.bind(globalThis) : (cb: () => void) => { cb(); return 0 }

  const roContainer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { measureMetrics(); sync() }) : null
  const roBlocks = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver((entries) => {
        let changed = false
        for (const entry of entries) {
          const index = blockIndexOf.get(entry.target)
          if (index === undefined || !model.slots[index]?.mounted) continue
          if (measureBlock(index)) changed = true
        }
        // 只重算 spacer 与滚动位置，不改挂载集合（避免与本次尺寸变化互相触发）
        if (changed) reflow(mountedRange())
      })
    : null

  /** 读取容器度量（块间距 / 内容原点）：spacer 补偿与坐标换算依赖它们。 */
  function measureMetrics() {
    try {
      const cs = getComputedStyle(container)
      const gap = parseFloat(cs.rowGap || cs.gap || "0")
      model.setGap(Number.isFinite(gap) ? gap : 0)
      const pt = parseFloat(cs.paddingTop || "0")
      origin = Number.isFinite(pt) ? pt : 0
    } catch {
      /* 无样式环境（测试替身）：按 0 处理 */
    }
  }

  function measureBlock(index: number): boolean {
    const el = blocks[index]
    if (!el || !el.isConnected) return false
    const h = el.getBoundingClientRect?.().height ?? 0
    return model.measure(index, h)
  }

  function mountBlock(index: number) {
    let el = blocks[index]
    if (!el) {
      el = document.createElement("div")
      el.className = "vz-block"
      opts.renderBlock(index, el)
      blocks[index] = el
      blockIndexOf.set(el, index)
      model.markRendered(index)
      roBlocks?.observe(el)
    }
    // 块按升序挂载 → 依次插到尾部 spacer 之前即保持顺序
    if (padBottom.parentNode === container) container.insertBefore(el, padBottom)
    else container.appendChild(el)
    model.markMounted(index)
    measureBlock(index)
  }

  function unmountBlock(index: number) {
    const el = blocks[index]
    if (!el) return
    if (el.isConnected) {
      measureBlock(index) // 摘除前确认真实高度（RO 已缓存，此处兜底）
      el.remove()
    }
    model.markUnmounted(index)
  }

  function applyPad(el: HTMLElement, height: number) {
    if (height > 0) {
      el.style.display = ""
      el.style.height = `${Math.round(height)}px`
    } else {
      el.style.display = "none"
      el.style.height = "0px"
    }
  }

  /** DOM 变更后的视口锚点快照（**变更前**取定）：
   *  - 视口顶部落在块内 → 按「块 + 块内偏移」修正；
   *  - 视口顶部已越过最后一个块（尾部活动区：运行中会话的新消息/在途流追加在块表之外，
   *    高度是真实 DOM、不入坐标表）→ 改按「距底距离」保持：块表坐标无从表达该区域，
   *    若照旧用 locate 的钳制值回写，每次滚动都会被拉回「末块末尾」——表现就是接近底部滚不动、
   *    到不了最底部（差距恰为尾部内容高度）。 */
  interface ReflowAnchor {
    index: number
    offset: number
    beyondTail: boolean
    bottomDist: number
  }

  /** DOM 变更后校准：粘底跟随时保持贴底，否则按锚点快照修正（视口内容原地不动）。
   *  贴底判定以**跟随意图**为准（`followSource`）：几何贴底在运行中会话里会随流式增长反复
   *  「不在底部」（距底超出阈值）——那时若走锚点分支，用户永远追不到持续增长的底部。 */
  function reflow(range: VzRange, anchor?: ReflowAnchor, keepBottom?: boolean) {
    if (!model.count()) return
    if (!(container.clientHeight > 0)) return
    const pad = model.padHeight(range)
    applyPad(padTop, pad.top)
    applyPad(padBottom, pad.bottom)
    if (keepBottom === undefined ? wantKeepBottom() : keepBottom) {
      const target = container.scrollHeight
      if (Math.abs(target - container.scrollTop) > 0.5) {
        container.scrollTop = target
        // 贴底赋值后通知跟随核心接手后续对齐（异步高度修正、尾部继续增长时咬住底部）
        contentChangedHook?.()
      }
      return
    }
    const snap = anchor ?? snapshotAnchor()
    const target = snap.beyondTail
      ? container.scrollHeight - container.clientHeight - snap.bottomDist
      : origin + model.pos(snap.index) + snap.offset
    if (Number.isFinite(target) && Math.abs(target - container.scrollTop) > 0.5) container.scrollTop = target
  }

  /** 取当前视口锚点快照（块内用块坐标，尾部活动区用距底距离）。 */
  function snapshotAnchor(): ReflowAnchor {
    const y = Math.max(0, container.scrollTop - origin)
    const loc = model.locate(y)
    return {
      index: loc.index,
      offset: loc.offset,
      beyondTail: model.beyondBlocks(y),
      bottomDist: distanceToBottom(),
    }
  }

  /** 是否应保持贴底：跟随意图优先（粘底跟随核心注入），未注入时退回几何判定（测试环境）。 */
  function wantKeepBottom(): boolean {
    if (followSource) {
      try {
        return followSource()
      } catch {
        /* 注入方异常：退回几何判定 */
      }
    }
    return isAtBottom()
  }

  /** 当前位置距底部距离（px）。 */
  function distanceToBottom(): number {
    return container.scrollHeight - container.scrollTop - container.clientHeight
  }

  /** 是否贴底（几何判定，与粘底跟随同阈值）。 */
  function isAtBottom(): boolean {
    const distance = distanceToBottom()
    return Number.isFinite(distance) && distance <= BOTTOM_THRESHOLD
  }

  /** 当前挂载块对应的区间（含包络）：ResizeObserver 只据它重算 spacer 与滚动位置，不改挂载集合。 */
  function mountedRange(): VzRange {
    let start = -1
    let end = 0
    for (let i = 0; i < model.count(); i++) {
      if (!model.slots[i].mounted) continue
      if (start < 0) start = i
      end = i + 1
    }
    return start < 0 ? { start: 0, end: 0 } : { start, end }
  }

  function sync() {
    if (syncing) return
    const n = model.count()
    if (!n) return
    syncing = true
    try {
      const viewportH = container.clientHeight
      const scrollTop = Math.max(0, container.scrollTop - origin)
      // 锚点快照与贴底态均在 DOM 变更前取定（变更会改高度表/滚动高度）
      const anchor = snapshotAnchor()
      const keepBottom = resetting || wantKeepBottom()
      const range = model.rangeFor(scrollTop, viewportH, MARGIN_ABOVE, MARGIN_BELOW)
      // 贴底：窗口锚定到末尾块（滚动位置即将落到底部，底部不留在估高空白侧）
      if (keepBottom) range.end = n
      for (let i = 0; i < n; i++) {
        const slot = model.slots[i]
        if (slot.mounted && (i < range.start || i >= range.end)) unmountBlock(i)
      }
      for (let i = range.start; i < range.end; i++) {
        if (!model.slots[i].mounted) mountBlock(i)
      }
      reflow(range, anchor, keepBottom)
    } finally {
      syncing = false
    }
  }

  function schedule() {
    if (rafId) return
    rafId = raf(() => {
      rafId = 0
      sync()
    })
  }

  const onScroll = () => schedule()
  const onResize = () => {
    measureMetrics()
    schedule()
  }

  container.addEventListener("scroll", onScroll, { passive: true })
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("resize", onResize)

  return {
    reset(seeds) {
      blocks.length = 0
      blockIndexOf.clear()
      roBlocks?.disconnect()
      model.setSlots(seeds)
      measureMetrics()
      container.replaceChildren(padTop, padBottom)
      // 初始全未挂载：顶部 spacer 撑起全高，先落底让窗口落在尾部（首屏只渲染尾部块）
      applyPad(padTop, model.totalHeight())
      applyPad(padBottom, 0)
      if (container.clientHeight > 0) container.scrollTop = container.scrollHeight
      roContainer?.disconnect()
      roContainer?.observe(container)
      // 重设后的首次 sync 强制落底（本帧只把窗口落在尾部；最终位置由调用方接着定：
      // 落底跟随或按锚点恢复阅读位置）——不能用跟随意图（上一会话可能处于阅读态）
      resetting = true
      try {
        sync()
      } finally {
        resetting = false
      }
      // 首批块实测后按样本定稿未渲染块的估高：此后滚动不再重算总高（布局稳定是位置稳定的前提）
      if (model.settleEstimates()) reflow(mountedRange(), undefined, true)
      schedule()
    },
    sync,
    appendTail(node) {
      if (padBottom.parentNode !== container) container.appendChild(padBottom)
      container.appendChild(node)
    },
    anchor() {
      const n = model.count()
      if (!n || !(container.clientHeight > 0)) return null
      const y = Math.max(0, container.scrollTop - origin)
      if (y <= 0) return null
      const loc = model.locate(y)
      // 视口顶部越过最后一个块（落在尾部活动区）：无块锚点（贴底语义由调用方判定）
      if (y > model.pos(n - 1) + model.heightAt(n - 1)) return null
      return { key: model.slots[loc.index].key, offset: loc.offset }
    },
    scrollToAnchor(key, offset) {
      const index = model.slots.findIndex((s) => s.key === key)
      if (index < 0) return null
      const want = Math.max(0, offset)
      container.scrollTop = origin + model.pos(index) + want
      sync() // 目标块可能未挂载：先挂载（实测高度替换估高）
      const refined = origin + model.pos(index) + Math.min(want, model.heightAt(index))
      if (Number.isFinite(refined) && Math.abs(refined - container.scrollTop) > 0.5) container.scrollTop = refined
      return container.scrollTop
    },
    posOfKey(key) {
      const index = model.slots.findIndex((s) => s.key === key)
      return index < 0 ? null : model.pos(index)
    },
    heightOfKey(key) {
      const index = model.slots.findIndex((s) => s.key === key)
      return index < 0 ? null : model.heightAt(index)
    },
    contentTop: () => origin,
    setFollowSource(fn) {
      followSource = fn
    },
    setContentChangedHook(fn) {
      contentChangedHook = fn
    },
  }
}
