/**
 * 分屏 / 整窗模式：把文件工作台嵌进主界面。
 *
 * 文件工作台与「会话工作台」（主界面）是**同窗的两个工作台**，共有三种共存形态
 * （`SplitMode`，见 files-split-core.ts）：
 *
 * | 形态 | 界面 | 入口 |
 * |---|---|---|
 * | `off` | 会话工作台独占整窗（缺省） | 主按钮（分屏打开） |
 * | `split` | 会话与文件**并列**（文件停在停靠侧，宽度可拖） | 主按钮（关闭分屏，点亮） |
 * | `solo` | 文件工作台**独占整窗**（会话收起但 DOM/状态全留着） | 悬浮副按钮（整窗打开） |
 *
 * - **整窗与窗口宽度无关**：窄窗口下分屏只会把两侧挤成条，那时主按钮就是整窗开关（副按钮在那个宽度收起）。
 * - **退出整窗回到进入前的形态**：从并列来的回并列，从会话桌面来的回会话桌面（见 exitSolo）。
 * - **切形态从不重载 iframe**：工作台的标签、滚动位置、Git 状态照旧（重新加载一次要几秒白屏不值当）。
 *
 * ## 停靠侧（会话区与工作台左右互换）
 *
 * 缺省**左侧**（文件工作区在左、会话区在右，`gebai.ui.filesSplitSide` 持久化）；工作台「更多」菜单里
 * 可随时改到另一侧（嵌入态才有的「停靠改到左侧 / 右侧」）。布局全部由 `body[data-files-split-side]`
 * 驱动——列序、标题栏归哪一列、分界线朝向、拖条贴哪条边、主题的太阳以哪块为中心，CSS 一处都不用改 JS；
 * 换侧因此只是改一个属性 + 重发一条消息，**iframe 不重载**（工作台的标签、滚动位置、Git 状态全留着）。
 *
 * ## 为什么用 iframe，而不是把工作台组件化搬进主界面
 *
 * 工作台本身就是独立页面（vite 多入口 `files.html`：Monaco + Git 面板 + 完整状态模型）。
 * iframe 让它保持**单实例**、**故障隔离**（编辑器崩了不带走会话，反之亦然）与**状态独立**
 * （滚到哪、开了哪些标签、底部工具窗高低都是它自己的事）；主界面这边只多出「一个容器」的概念。
 * 组件化则要把整套状态搬进 SPA 生命周期，且与「整窗打开」形成两套运行形态，收益不抵成本。
 *
 * 代价是跨界的几个动作（主题变更、关闭、停靠侧、形态）要走 `postMessage` 桥接——就是下面 `bridge` 那几段。
 *
 * ## 状态与生命周期
 *
 * - 关闭同窗形态（含 `solo`）**不销毁 iframe**（只 `hidden`）：IDE 里工具窗关掉再开也是原样，工作台重新加载
 *   一次要重建 Monaco/Git 状态，几秒白屏不值当。真正销毁是页面刷新。
 * - 宽度与**停靠侧**持久化（localStorage）；**形态也持久化**——刷新页面后把上次的形态重新拉起来
 *   （`gebai.ui.filesSplitOpen` 存 `split`/`solo`：用户主动关闭时清除，而因窗口过窄被自动退出时保留——那是"窗口放不下"
 *   而非"不要分屏"，把窗口拉回来再刷新，分屏照旧在）。恢复延到空闲期，不让一个重工作台
 *   与主界面首屏数据抢带宽。
 * - 折叠/展开是 **200ms 滑入/滑出**（`#files-split.anim`，见 files-split.css）：面板整体从窗口边缘
 *   平移进出（transform，合成层位移），栅格宽度一步到位。**不做宽度过渡**——会话区每帧重排整段
 *   会话在长会话上是几十上百毫秒一次，宽度过渡会被挤成两三帧（实测数字见 CSS）。
 */
import { filesUrl, type FilesOpenOpts } from "./files-entry"
import { insertIntoComposer } from "./composer"
import { popKeyScope, pushEscScope } from "./keymap"
import { clampSplitWidth, normalizeSplitMode, normalizeSplitSide, splitFitsWindow, splitWidthFromPointer, type SplitMode, type SplitSide } from "./files-split-core"

export type { SplitSide }

/** 分屏宽度（px）持久化键；缺省用 50vw。 */
const W_KEY = "gebai.ui.filesSplitW"
/**
 * 跨界「发送会话」的载荷上限（字符）：工作台侧已按行/字符截断（见 `files/editor-ref.ts`），
 * 这里是跨窗口的**最后一道**——异常大的消息不该能把输入框与消息渲染一起拖死。
 */
const SEND_MAX_CHARS = 64 * 1024
/** 停靠侧持久化键；缺省由 files-split-core 的 SPLIT_DEFAULT_SIDE 决定（左侧）。 */
const SIDE_KEY = "gebai.ui.filesSplitSide"
/**
 * **同窗形态**的记忆键（存 `"split"` / `"solo"`；回到 `off` 即清键，见 readMode / closeToOff）。
 * 旧版本这里存的是 `"1"`（那时只有开/关两态），`normalizeSplitMode` 把它平移到 `split`。
 */
const OPEN_KEY = "gebai.ui.filesSplitOpen"
/** 折叠/展开动画时长（ms）——与 files-split.css 里 `#files-split.anim` 的 transform 过渡同值。 */
const ANIM_MS = 200

let pane: HTMLElement | null = null
let frame: HTMLIFrameElement | null = null
/** 主按钮（分屏 / 整窗开关，常驻可见）。 */
let mainBtn: HTMLButtonElement | null = null
/** 悬浮副按钮（文件工作台 / 会话工作台同窗切换，见 toggleSolo）。 */
let soloBtn: HTMLButtonElement | null = null
/** 记住上一次进入时的参数，重新打开时沿用（会话/根/主题由 filesUrl 现取）。 */
let lastOpts: FilesOpenOpts = {}
/**
 * 当前**同窗形态**。
 * 回 `off` 的收起过渡期内它就已经是 `off`——此刻再点开关是「重新推开」（enterSplit 会把宽度
 * 又交回 CSS 变量，过渡从当前宽度续上，不会先塌到 0 再展开）；而**布局**（body 类）留到动画收尾
 * 才撤（见 finishClose），否则收起走到一半面板那一列就被栅格收掉、面板被压着滑出去。
 */
let mode: SplitMode = "off"
/** 进入整窗前的形态（`split` = 从并列来的，回并列；`off` = 从会话桌面来的，回会话桌面）。 */
let soloReturn: "off" | "split" = "off"
/**
 * 整窗态在键位表里占的 Esc 作用域 id（进整窗时推到栈顶，退出时弹掉）。
 * 用**浮层作用域**而不是自挂一个 document 监听：分发器按「后推的优先」匹配，
 * 所以整窗态下再打开文件预览 / 设置面板时，Esc 仍先归那一层——不会把「关预览」抢成「退出整窗」。
 */
let soloEscScope: string | null = null
/** 当前停靠侧（内存态；读自 readSide，写在 setSplitSide）。 */
let side: SplitSide = readSide()
/** 生效宽度的 px 值；null = 交给 CSS 的 50vw（真正的五五开，窗口缩放时自己跟）。 */
let targetW: number | null = null
/** 收起动画的兜底/收尾定时器（transitionend 不保证来：过渡被中途打断、元素被隐藏、浏览器优化掉远帧都可能）。 */
let animTimer = 0

/**
 * **并列（分屏）**是否处于打开态。
 * 收起的 200ms 动画里返回 false：这段时间里按钮已是「分屏打开」，语义上就该按已关对待
 * （Esc/点会话列表再关一次没有意义，而重新点是「推开」）。
 */
export function isSplitOpen(): boolean {
  return mode === "split"
}

/** 当前同窗形态（入口按钮态、键位 `when` 与桥接消息都读它）。 */
export function splitMode(): SplitMode {
  return mode
}

/* --------------------------- 停靠侧 --------------------------- */

function readSide(): SplitSide {
  try {
    // 归一到 left/right 在 files-split-core（脏值 → 缺省侧），那支有单测守着
    return normalizeSplitSide(localStorage.getItem(SIDE_KEY))
  } catch {
    return normalizeSplitSide(null)
  }
}

/** 上次的同窗形态（脏值当关闭，归一在 files-split-core，带单测）。 */
function readMode(): SplitMode {
  try {
    return normalizeSplitMode(localStorage.getItem(OPEN_KEY))
  } catch {
    return "off"
  }
}

/** 记住 / 忘掉同窗形态（回到 `off` 时清键而不是写 "off"，不留残留）。 */
function writeMode(m: SplitMode): void {
  try {
    if (m === "off") localStorage.removeItem(OPEN_KEY)
    else localStorage.setItem(OPEN_KEY, m)
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 换停靠侧（文件工作区在左 ↔ 在右）。
 * 只改 `body[data-files-split-side]`：列序/标题栏列/分界线/拖条边全在 CSS 里按它分支，
 * 面板宽度不变，因此 iframe 内的编辑区一点也不用重排（工作台只多收一条「侧」消息，用于换图标朝向后重画活动栏）。
 */
export function setSplitSide(next: SplitSide): void {
  if (next !== "left" && next !== "right") return
  if (next === side) return
  side = next
  try {
    localStorage.setItem(SIDE_KEY, side)
  } catch {
    /* 隐私模式忽略 */
  }
  applySide()
  syncEntry()
}

/** 左右互换（工作台「更多」菜单里的那一项走这里）。 */
export function toggleSplitSide(): void {
  setSplitSide(side === "left" ? "right" : "left")
}

/** 应用停靠侧：写 body 属性（CSS 据此换列序与朝向）+ 通知 iframe 里的工作台。 */
function applySide(): void {
  document.body.dataset.filesSplitSide = side
  postSide()
}

/**
 * 应用形态的**布局**（body 类 + 形态属性）：进/出各调一次，**动画期间保持不动**。
 *
 * 收起时不能立刻撤：面板那一列一旦被栅格收掉，收起动画就变成「被压着滑出去」
 * （宽度一步到位、动画只位移，正是为了不每帧重排会话，见 CSS）。
 * 所以 `closeToOff` 里只改内存态与按钮，布局留到 `finishClose` 收尾时撤。
 */
function applyLayout(next: SplitMode): void {
  document.body.classList.toggle("files-split", next === "split")
  document.body.classList.toggle("files-split-solo", next === "solo")
  document.body.dataset.filesSplitMode = next
  postMode()
}

/* --------------------------- 宽度 --------------------------- */

function storedWidth(): number | null {
  try {
    const raw = localStorage.getItem(W_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * 写入生效宽度：根元素上的 `--files-split-w` —— 面板宽度、主题的太阳定位、分屏的栅格列都读它。
 * 只写变量、不碰面板的内联尺寸，宽度始终归 CSS（`width: var(--files-split-w, 50vw)`）。
 */
function applyWidth(w: number | null): void {
  const root = document.documentElement
  if (w === null) {
    root.style.removeProperty("--files-split-w")
    targetW = null
  } else {
    const c = clampSplitWidth(w, window.innerWidth)
    root.style.setProperty("--files-split-w", `${c}px`)
    targetW = c
  }
}

/* --------------------------- 分屏面板 --------------------------- */

/**
 * 分屏面板 = **纯容器**：只有 iframe 与分界线上的拖条，没有标题栏。
 *
 * 为什么不留标题栏：它要为一条 30px 的横条付出整个编辑区的垂直空间，而里面那些按钮各有更好的去处——
 *   · 「打开」= 标题栏入口主按钮（并列）与副按钮（整窗）；
 *   · 「重新加载 / 停靠改到左侧 / 回到会话工作台」= 扫进工作台自己的「更多」菜单（页面级动作归页面自己）；
 *   · 「关闭」另有**面板内**与全局几条路径（活动栏最下方那颗按钮、
 *     Ctrl+\、整窗态的 Esc；另有点标题栏「会话列表」也会关，见 bindFilesSplit 末尾）。
 * 面板因此完全让位给工作台本身：它自己就是 IDE 式界面，自带顶栏与状态栏。
 */
function buildPane(): HTMLElement {
  const el = document.createElement("div")
  el.id = "files-split"
  el.hidden = true

  // 分界拖条：全高，hover 高亮；双击回到五五开（贴哪条边由停靠侧决定，见 files-split.css）
  const resizer = document.createElement("div")
  resizer.className = "files-split-resizer"
  resizer.title = "拖动调整宽度（双击恢复五五开）"
  bindResizer(resizer)

  const f = document.createElement("iframe")
  f.className = "files-split-frame"
  f.title = "文件工作台"
  // 不用 sandbox：同源同信任级别（工作台就是本站页面），sandbox 反而会切断 localStorage
  // （主题偏好）与下载等能力；它需要的只是一个「容器」。
  f.setAttribute("referrerpolicy", "same-origin")
  // 加载完成即补一次主题、停靠侧与形态：首帧的消息早于子页监听器注册是常态，靠 load 事件兜底。
  f.addEventListener("load", () => {
    postTheme()
    postSide()
    postMode()
  })

  el.append(resizer, f)
  // 动画的收尾统一走 settle（transitionend 与兜底定时器都进它）：
  // 展开完撤 .anim（否则会一直挂在合成层上），收起完藏面板（见 finishClose）。
  el.addEventListener("transitionend", (e) => {
    const ev = e as TransitionEvent
    if (ev.target !== el || ev.propertyName !== "transform") return
    settle(el)
  })
  pane = el
  frame = f
  return el
}

function bindResizer(resizer: HTMLElement): void {
  let dragging = false

  const onMove = (e: PointerEvent): void => {
    if (!dragging || !pane) return
    // 面板贴着窗口的哪一侧，就用「指针到那一侧边缘」的距离当宽度（换算在 files-split-core，有单测）
    applyWidth(splitWidthFromPointer(e.clientX, pane.getBoundingClientRect().left, window.innerWidth, side))
  }
  /*
   * pointerup 可能落在 iframe 里：指针一旦进入 iframe，它自己的文档接管事件，
   * 拖条上的 pointerleave/pointerup 就收不到，拖动会"粘住"不结束。
   * 两道保险：① iframe 上的 pointer-events 在拖动时置 none（见 files-split.css，
   * 但那是"下一次移动时"才生效，快速拖动仍可能丢）；② pointerup 同时监听 window
   * 的**捕获阶段**——window 在文档之外，iframe 内松开也收得到。
   */
  const onUp = (): void => {
    if (!dragging) return
    dragging = false
    resizer.classList.remove("dragging")
    document.body.classList.remove("files-split-dragging")
    if (targetW !== null) {
      try {
        localStorage.setItem(W_KEY, String(targetW))
      } catch {
        /* 隐私模式忽略 */
      }
    }
  }

  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    dragging = true
    resizer.classList.add("dragging")
    document.body.classList.add("files-split-dragging")
    resizer.setPointerCapture(e.pointerId)
  })
  resizer.addEventListener("pointermove", onMove)
  resizer.addEventListener("pointerup", onUp)
  resizer.addEventListener("pointercancel", onUp)
  window.addEventListener("pointerup", onUp, true)
  window.addEventListener("blur", onUp) // 切窗口（如 Alt+Tab）也算松手
  // 双击：清掉自定义宽度 → 回到 CSS 里的 50vw
  resizer.addEventListener("dblclick", () => {
    try {
      localStorage.removeItem(W_KEY)
    } catch {
      /* 忽略 */
    }
    applyWidth(null)
  })
}

/* --------------------------- 进入 / 退出 --------------------------- */

/** 用户关掉了动效（系统级「减少动态效果」）：折叠/展开直接到位，不留过渡。 */
function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** 面板挂进 #app 并备好桥（三种形态共用；已挂过就只是取回它）。 */
function mountPane(): HTMLElement | null {
  const app = document.getElementById("app")
  if (!app) return null
  const el = pane ?? buildPane()
  if (!el.isConnected) app.appendChild(el)
  ensureBridge()
  return el
}

/** 让 iframe 指向目标（已经指着同一个目标就不换 src：工作台的标签与滚动位置全留着）。 */
function pointFrame(url: string): void {
  if (frame && frame.src !== new URL(url, location.href).href) frame.src = url
}

/** 记忆当前形态 + 立即刷新入口按钮态；**布局**由调用方在合适的时机落地（见 applyLayout 的调用点）。 */
function rememberMode(next: SplitMode, persist: boolean): void {
  mode = next
  if (persist) writeMode(next)
  syncEntry()
}

/**
 * 进入**并列**形态（会话与文件各占一栏）。
 * 窗口容不下分屏时不再是「另开一个标签页」——整窗形态与宽度无关，直接转给 enterSolo。
 */
export function enterSplit(opts: FilesOpenOpts = {}): void {
  if (!splitFitsWindow(window.innerWidth)) {
    enterSolo(opts)
    return
  }
  lastOpts = { ...opts }
  const el = mountPane()
  if (!el) return
  pointFrame(filesUrl(opts))
  const wasVisible = mode !== "off"
  rememberMode("split", true)
  applyLayout("split")
  applyWidth(storedWidth())
  clearTimeout(animTimer)
  animTimer = 0
  if (!wasVisible || el.hidden) openPane(el)
}

/**
 * 进入**整窗**形态：文件工作台铺满整窗，会话工作台收起（DOM 与状态全留着，切回来是原样）。
 *
 * 与窗口宽度无关——窄窗口下这就是入口按钮的唯一形态；不做滑入动画（一整屏的东西横着滑进来
 * 只是拖时间，而且面板要么本来就在、要么是从零出现，没有“从边上推开”的语义）。
 */
export function enterSolo(opts: FilesOpenOpts = {}): void {
  lastOpts = { ...opts }
  const el = mountPane()
  if (!el) return
  pointFrame(filesUrl(opts))
  // 记下「从哪来」：整窗是临时插进来的一段，退出时该回原处（见 exitSolo）
  if (mode !== "solo") soloReturn = mode === "split" ? "split" : "off"
  rememberMode("solo", true)
  applyLayout("solo")
  // Esc 兜底：整窗态下面板占了整屏，万一 iframe 没加载出来（或焦点落在宿主页面上），
  // 手上总得有一条退路（正常路径是面板里那颗「回到会话工作台」/ 它的 Ctrl+\）。
  if (!soloEscScope) soloEscScope = pushEscScope("main.filesSolo", "回到会话工作台（退出整窗）", () => exitSolo())
  // 整窗态的面板宽度由 CSS 吃满整窗，分屏宽度变量留着只会让切回时多一次夹取
  applyWidth(null)
  el.hidden = false
  el.style.removeProperty("transform")
  el.classList.remove("anim")
}

/** 回到 `off`（会话工作台独占整窗）：滑出 → 收尾时才撤布局（见 finishClose）。 */
function closeToOff(opts: { animate?: boolean; persist?: boolean } = {}): void {
  if (!pane || mode === "off") return
  mode = "off"
  if (opts.persist !== false) writeMode("off")
  clearTimeout(animTimer)
  animTimer = 0
  syncEntry()
  // 窗口窄到分屏下限以下时的自动退出不播动画：面板马上要被挤没，过渡只会拖出一个残影
  if (opts.animate === false || prefersReducedMotion()) finishClose(pane)
  else closePane(pane)
}

/**
 * 关掉同窗形态（`split` / `solo` 都回到会话工作台）。
 *
 * 宿主侧唯一的「关闭」入口：工作台里那颗按钮与 `Ctrl+\` 在两种形态下语义相同
 * （关掉我、把整窗还给会话），只是文案与图标随形态变，所以桥上也只发这一条消息。
 * `persist: false` 给「窗口缩到分屏下限以下」的自动退出用：那是窗口放不下、不是用户不要分屏，
 * 记忆留着（把窗口拉回来再刷新，分屏照旧在）。
 */
export function exitSplit(opts: { animate?: boolean; persist?: boolean } = {}): void {
  if (mode === "solo") {
    exitSolo(opts)
    return
  }
  closeToOff(opts)
}

/**
 * 退出整窗：回到**进入整窗前**的形态（从并列来的回并列，从会话桌面来的回会话桌面）。
 *
 * 从并列来的那条路不重载 iframe、也不重播滑入动画——面板本来就在，只是把会话区拿回来
 * （列序与宽度由 applyLayout/applyWidth 重新落地，工作台的状态一点没动）。
 */
export function exitSolo(opts: { animate?: boolean; persist?: boolean } = {}): void {
  if (mode !== "solo") return
  if (soloEscScope) {
    popKeyScope(soloEscScope)
    soloEscScope = null
  }
  const back = soloReturn
  soloReturn = "off"
  if (back === "split") {
    // 先置回 off 再进并列：openPane 只在「此前不可见」时播动画，这里面板一直可见，不会抽一下
    mode = "off"
    enterSplit(lastOpts)
    return
  }
  closeToOff(opts)
}

/**
 * 主按钮的动作：`off ⇄ split`；窗口容不下分屏时退化为 `off ⇄ solo`；整窗态下是「回会话工作台」。
 */
export function toggleSplit(opts: FilesOpenOpts = {}): void {
  if (mode === "split") exitSplit()
  else if (mode === "solo") exitSolo()
  else if (!splitFitsWindow(window.innerWidth)) enterSolo(opts)
  else enterSplit(opts)
}

/** 副按钮的动作：`off/split ⇄ solo`——文件工作台与会话工作台在同窗里二选一。 */
export function toggleSolo(opts: FilesOpenOpts = {}): void {
  if (mode === "solo") exitSolo()
  else enterSolo(opts)
}

/**
 * 刷新后恢复：上次是什么形态就照旧（`bindFilesSplit` 在空闲期调一次）。
 *
 * 两道闸门：① 没有记忆 / 记忆是 `off` → 不动（缺省不开——多数访问只是来看会话的）；
 * ② 记忆是 `split` 而窗口窄于分屏下限 → 也不开，**而不是**退化成整窗：用户要的是并列，
 * 悄悄开出一整屏文件工作台是另一种意外（记忆留着，窗口拉回来再刷新照旧）。
 */
export function restoreMode(): void {
  if (mode !== "off") return // 已开着（双保险调度重合 / 用户已点开）不重入
  const stored = readMode()
  if (stored === "solo") enterSolo({})
  else if (stored === "split" && splitFitsWindow(window.innerWidth)) enterSplit({})
}

/**
 * 推开面板（带滑入动画）。
 *
 * 顺序是关键：**先把面板整体推到窗外（内联 transform）并强制一帧**，再移除内联值交给 CSS——
 * 否则浏览器只看到「hidden → 显示 + 归位」这一次状态变化，没有"上一个位置"可插值，动画根本不会发生。
 * 栅格（`body.files-split`）在这一步之前就已落地（applyLayout）：会话区一次性重排到位，此后整场动画只位移、不再重排。
 */
function openPane(el: HTMLElement): void {
  el.hidden = false
  if (prefersReducedMotion()) {
    el.classList.remove("anim")
    el.style.removeProperty("transform")
    return
  }
  el.classList.add("anim")
  el.style.transform = offEdge()
  void el.offsetWidth
  el.style.removeProperty("transform")
  // 兜底：动画被中途打断（换侧/连点）而不再有 transitionend 时，.anim 不能永远留着
  armSettleTimer(el)
}

/** 面板在窗外（分界线那一侧的外面）：左停靠从左边滑进来，右停靠从右边。 */
function offEdge(): string {
  return `translateX(${side === "left" ? "-" : ""}100%)`
}

/**
 * 收合面板（带滑出动画）：面板整体滑到窗外，滑完交给 settle（transitionend 或定时器先到者）。
 * 栅格此刻还撑着面板那一列（会话区照旧窄着）：面板先出画，最后一步才把空间还给会话区
 * （见 finishClose）——那一步只有一次会话重排，中途没有。
 */
function closePane(el: HTMLElement): void {
  el.classList.add("anim")
  el.style.transform = offEdge()
  armSettleTimer(el)
}

/** 兜底定时器：比 CSS 过渡时长略长，收起时万一 transitionend 不来也能收尾。 */
function armSettleTimer(el: HTMLElement): void {
  clearTimeout(animTimer)
  animTimer = window.setTimeout(() => settle(el), ANIM_MS + 120)
}

/**
 * 过渡收尾（transitionend 与兜底定时器共用，幂等）：
 * 展开态只把 `.anim` 撤掉（面板保持打开），收起态才真藏面板（见 finishClose）。
 */
function settle(el: HTMLElement): void {
  clearTimeout(animTimer)
  animTimer = 0
  if (mode !== "off") el.classList.remove("anim")
  else finishClose(el)
}

/**
 * 收起收尾：藏面板、撤动画态、退出同窗布局（`--files-split-w` 与 body 类一起收回）。
 * 会话区在这一步才展开——收起动画里它一直是窄的那份布局，只在最后重排一次。
 */
function finishClose(el: HTMLElement): void {
  clearTimeout(animTimer)
  animTimer = 0
  if (mode !== "off") return // 收起途中又被推开：收尾交给展开流程
  el.hidden = true
  el.style.removeProperty("transform")
  el.classList.remove("anim")
  applyLayout("off")
  applyWidth(null)
  syncEntry()
}

/**
 * 入口主按钮的文案/图标/开关态随形态变（副按钮文案固定：它就是「整窗切换」，**且不标快捷键**——
 * `Ctrl+\` 归主按钮：那个键管的是并列开关，不是整窗。两个按钮标同一个键，只会让人按了才发现对不上）。
 *
 * | 形态 | 主按钮（常驻） | 副按钮（悬浮弹出） |
 * |---|---|---|
 * | `off` | 分屏打开 | 整窗打开文件工作台 |
 * | `split` | 关闭分屏（点亮） | 整窗打开文件工作台 |
 * | `solo` | 回到会话工作台 | ——（整窗态下标题栏本就不可见） |
 *
 * 窗口容不下分屏时（手机端为主）主按钮**换成整窗开关**——图标（`.solo-only`，见 files-split.css）
 * 与文案一起换，副按钮随之收起（那个宽度下两个按钮是同一个动作，并排摆着只是让人多点一次）。
 *
 * 标题栏上不再有✕：关闭同窗形态改由**工作台自己**（嵌入态下它就在面板里，那里才是"关掉我"的自然位置）：
 * 「更多」菜单的「回到会话工作台 / 关闭分屏」、活动栏最下方那颗按钮、以及全局的 Ctrl+\；
 * 此外点标题栏的「会话列表」也会回到会话工作台（见 bindFilesSplit 末尾）。
 */
function syncEntry(): void {
  if (!mainBtn) return
  const fits = splitFitsWindow(window.innerWidth)
  /*
   * 文案取「动作（快捷键）」两句式，与标题栏其他入口同调（如「新会话（Alt+N）」）。
   * 早先这里是「分屏打开（右侧对照，可拖动分界 · Ctrl+\）」——一个 30 字的单行气泡，
   * 比按钮宽四倍、压在按钮下方，悬浮时相当抢眼；而「右侧对照 / 可拖动分界」是点下去一眼就懂的事，
   * 不必写进提示。
   * 整窗态下标题栏不可见（它被整窗面板盖掉），文案只是为了状态一致。
   */
  const tip = !fits
    ? mode === "solo" ? "回到会话工作台" : "整窗打开文件工作台"
    : mode === "split" ? "关闭分屏（Ctrl+\\）" : mode === "solo" ? "回到会话工作台" : "分屏打开（Ctrl+\\）"
  /*
   * `aria-label` 取**不带快捷键的干净动作名**（屏幕阅读器读“分屏打开”就够，“Ctrl+反斜杠”是视觉提示
   * 那一层的事）；文档里那个键又恰好是“开/关”两义，念进耳朵里只会更乱。
   */
  const label = !fits
    ? mode === "solo" ? "回到会话工作台" : "整窗打开文件工作台"
    : mode === "split" ? "关闭分屏" : mode === "solo" ? "回到会话工作台" : "分屏打开文件工作台"
  // resize 每帧都会调到这里（见 bindFilesSplit 的 resize 监听）：值没变就不碰 DOM——属性一写，
  // 悬浮提示的 attr() 就得重新解析一遍
  if (mainBtn.dataset.tip === tip && mainBtn.getAttribute("aria-label") === label) return
  mainBtn.dataset.tip = tip
  mainBtn.setAttribute("aria-label", label)
  mainBtn.classList.toggle("solo-only", !fits)
  // 「是否开着」只对并列态有意义：整窗态下标题栏不可见，开关态无从表达
  if (fits && mode !== "solo") mainBtn.setAttribute("aria-expanded", String(mode === "split"))
  else mainBtn.removeAttribute("aria-expanded")
  // .icon-btn.active 是全站通用的"已开启"语义（轮盘按钮同款），这里就是「分屏开着」
  mainBtn.classList.toggle("active", mode === "split")
}

/* --------------------------- 跨界桥接 --------------------------- */

let bridged = false

/**
 * 主题、停靠侧、形态与关闭这四件事必须跨界，其余一概不桥（桥越多耦合越紧）。
 * 主题：工作台是独立文档，改了主界面主题它不会自己变，只能显式通知；
 * 停靠侧：工作台的「关闭」箭头要指出向、「更多」菜单那项要写对文案；
 * 形态：整窗态下那颗按钮该叫「回到会话工作台」而不是「关闭分屏」（图标也换）；
 * 关闭：嵌在 iframe 里的工作台点那颗按钮时应关掉面板，而不是把 iframe 导航到主界面。
 */
function ensureBridge(): void {
  if (bridged) return
  bridged = true

  document.addEventListener("gebai:theme-change", () => postTheme())

  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin || e.source !== frame?.contentWindow) return
    const data = e.data as { type?: string; text?: string } | null
    if (data?.type === "gebai:files-close-split") exitSplit()
    if (data?.type === "gebai:files-split-swap") toggleSplitSide()
    // 工作台编辑器右键「发送会话」：往输入框里插一段带出处的代码（见 composer.insertIntoComposer）。
    // 长度再卡一道：跨窗口的消息不信任来源内容（iframe 已被同源检查，只是防一手异常大载荷把输入框拖死）。
    if (data?.type === "gebai:files-send-to-chat" && typeof data.text === "string" && data.text.length <= SEND_MAX_CHARS) insertIntoComposer(data.text)
  })
}

/** 把当前生效的主题/配色推给 iframe（主界面 documentElement 上的 dataset 是权威值）。 */
function postTheme(): void {
  const el = document.documentElement
  frame?.contentWindow?.postMessage(
    { type: "gebai:theme", theme: el.dataset.theme ?? null, cnyScheme: el.dataset.cnyScheme ?? null, acrylicLt: el.dataset.acrylicLt ?? null },
    location.origin,
  )
}

/** 把停靠侧推给 iframe（工作台据此选「关闭」箭头朝向与「停靠改到左/右」文案）。 */
function postSide(): void {
  frame?.contentWindow?.postMessage({ type: "gebai:files-split-side", side }, location.origin)
}

/** 把当前形态推给 iframe（工作台据此决定那颗按钮的文案/图标：关闭分屏 ⇄ 回到会话工作台）。 */
function postMode(): void {
  frame?.contentWindow?.postMessage({ type: "gebai:files-mode", mode }, location.origin)
}

/* --------------------------- 绑定入口 --------------------------- */

export function bindFilesSplit(): void {
  // 停靠侧与形态先落到 body 上：CSS 的列序/朝向分支（含 #files-split 自身）读它，不必等第一次进分屏
  applySide()
  applyLayout(mode)
  mainBtn = document.getElementById("files-btn") as HTMLButtonElement | null
  if (!mainBtn) return
  soloBtn = document.getElementById("files-solo-btn") as HTMLButtonElement | null
  /*
   * 主按钮 = 并列（分屏）开关；副按钮 = 整窗切换（文件工作台 / 会话工作台二选一）。
   * 指针点击时 `:focus-visible` 为 false，于是按钮淡出后**仍然握着焦点**：
   * 此后随手按一下 Enter/空格，分屏会"隐形地"再切一次；聚焦提示气泡也会悬在那儿不散。
   * 所以指针触发的点击后主动让出焦点；键盘触发的保留（:focus-visible 会让它继续显形）。
   */
  mainBtn.addEventListener("click", () => {
    const fromKeyboard = mainBtn!.matches(":focus-visible")
    toggleSplit()
    if (!fromKeyboard) mainBtn?.blur()
  })
  soloBtn?.addEventListener("click", () => {
    const fromKeyboard = soloBtn!.matches(":focus-visible")
    toggleSolo()
    if (!fromKeyboard) soloBtn?.blur()
  })
  /*
   * 没有标题栏✕：关闭走工作台自己的「更多」菜单（嵌入态的「回到会话工作台 / 关闭分屏」）
   * 与全局 Ctrl+\（由 main 的快捷键表统一处理；整窗态另有 Esc，作为面板没加载出来时的退路，
   * 见 enterSolo 里的 pushEscScope）。
   *
   * 并列开着时点「会话列表」按钮 = 我要看会话：退出并列把列表拿回来，
   * 而不是去切一个此刻根本看不见的栏位（否则那个按钮在分屏期间形同死去）。
   * 挂 document 捕获阶段：先于按钮自己的处理器，才拦得住。
   */
  document.addEventListener(
    "click",
    (e) => {
      if (mode === "off") return
      if (!(e.target as HTMLElement | null)?.closest("#sidebar-toggle")) return
      e.stopPropagation()
      e.preventDefault()
      exitSplit()
    },
    true,
  )
  syncEntry()
  /*
   * 窗口尺寸变化（每事件合并到一帧：拖窗口时 resize 每帧都来，写 CSS 变量会连带着抖动）：
   * ① 宽度跨过分屏下限 → 入口按钮换语义（分屏 ⇄ 整窗，见 syncEntry）。故挂在**入口绑定**里
   *    而不是 ensureBridge：没开过分屏的页面（手机端一进来就是这种）也要跟着窗口宽度走；
   * ② 分屏开着时 → 缩到下限以下自动退出（否则两侧都挤成条，比整窗更糟）；
   *    自定义宽度重新夹进新窗口（缺省五五开不用管：CSS 里的 50vw 自己跟）。
   */
  let resizeRaf = 0
  window.addEventListener("resize", () => {
    if (resizeRaf) return
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      syncEntry()
      if (!isSplitOpen()) return
      if (!splitFitsWindow(window.innerWidth)) exitSplit({ animate: false, persist: false })
      else if (targetW !== null) applyWidth(targetW)
    })
  })
  /*
   * 刷新恢复：上次是什么形态就再打开。延一小段而不是立刻——iframe 里的工作台是重页面
   * （Monaco + Git 面板），让主界面把首屏那批请求先发出去，避免与之抢带宽。
   *
   * 为何两条腿走路：空闲回调在无头/高负载环境下可能很晚才到（实测有 10s 窗口内仍未触发的情形），
   * 而这是「用户上次明确开着的东西」，迟迟不出现与不做无异；两条调度谁先到都行
   * （restoreMode 自身幂等：已开着直接返回）。
   */
  if (readMode() !== "off") {
    const kick = (): void => restoreMode()
    if (typeof requestIdleCallback === "function") requestIdleCallback(kick, { timeout: 1200 })
    setTimeout(kick, 400)
  }
}
