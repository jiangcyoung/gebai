/**
 * 文件工作台 · 编辑器层：Monaco（VSCode 同款内核）只读/编辑双态 + 差异视图，附降级编辑器。
 *
 * 为什么用 AMD 版 Monaco（`/vendor/monaco/vs/loader.js`）而不是 `import * as monaco from "monaco-editor"`：
 * - vite 会把 ESM 版切成大量带 hash 的 chunk，dev-reload（vite build --watch）重建后旧页面引用旧 chunk → 404；
 *   与 mermaid/plantuml/d2 同一处置：**稳定文件名的静态 vendor** 由 build-vendor.ts 拷入 public/vendor/；
 * - 语言高亮 / 各语言 worker 按需从同目录加载，无需前端打包器介入。
 *
 * 主题：用 `editor.defineTheme` 把当前界面的 CSS 令牌（--bg-elev/--text/--accent…）映射成 Monaco 主题，
 * 主题切换时重新 defineTheme + setTheme（与主界面换肤联动，而不是硬编码一套配色）。
 * **半透明令牌必须先合成再喂给 Monaco**（经 `cssVarToHex`）：主题令牌多为半透明（默认主题 acrylic 的
 * `--bg-elev` 是 `rgba(18,18,23,.82)`，`--bg-inset` 亮色下是 `rgba(0,0,0,.05)`），直接丢 alpha 只取 rgb
 * 分量会得到与页面无关的假色——亮色主题下编辑器会被判成暗色（`base: vs-dark`）并铺成黑底，
 * 再叠上亮色主题的深色前景 `--text` 就是「黑底黑字」。
 * 降级：vendor 缺失（如裁剪构建）/加载超时 → 自动降级为 `highlight.js 静态高亮 + textarea 编辑`，
 * 功能不缺失（查看/编辑/保存仍可用），仅体验降级。
 */

import { cssVarToHex } from "../css-color"
import { appPath } from "@gebai/sdk"
import { blameHover, blameLabel, toBlameIndex, type BlameLine } from "./blame"
import { readWordWrap, saveWordWrap } from "./wrap"

export type { BlameLine }

type Monaco = typeof import("monaco-editor")

/** 光标/选择变化回调。 */
export type CursorListener = (info: { line: number; column: number; selected: number }) => void

export interface EditorOptions {
  value: string
  language: string
  readOnly: boolean
  /** 小地图（文件工作台默认开启，窄屏由 CSS 折衷） */
  minimap?: boolean
  /** 自动换行覆盖项；缺省用模块级开关（`isWordWrap()`：用户偏好，轮盘 / Alt+Z 切换） */
  wordWrap?: boolean
  /** 大文件降级阈值（字符数）：超过则关闭小地图/括号彩化/词法高亮，保流畅 */
  largeFileChars?: number
}

/** 行级 blame 信息见 `blame.ts`（两种显示形态共用同一份数据）。 */

export interface EditorHandle {
  kind: "monaco" | "fallback"
  getValue(): string
  setValue(value: string): void
  setLanguage(language: string): void
  setReadOnly(readOnly: boolean): void
  isReadOnly(): boolean
  /** 自动换行开关（查看/编辑两态都即时生效） */
  setWordWrap(on: boolean): void
  focus(): void
  layout(): void
  revealLine(line: number, column?: number): void
  getScrollTop(): number
  setScrollTop(top: number): void
  getCursor(): { line: number; column: number; selected: number }
  onCursor(cb: CursorListener): void
  onChange(cb: () => void): void
  /** 全文替换（撤销栈视为一次编辑；保存后重新对齐基线用） */
  markClean(): void
  /**
   * 设置 blame 数据与两种显示形态的开关（两态**互相独立**）：
   * `gutter` = 左侧作者列（全局）；`inline` = 光标行行尾注释。数据为空则两态都画不出。
   */
  setBlame(lines: BlameLine[], show: { gutter: boolean; inline: boolean }): void
  dispose(): void
}

export interface DiffHandle {
  kind: "monaco" | "fallback"
  layout(): void
  /** 自动换行开关（差异两侧一起切） */
  setWordWrap(on: boolean): void
  dispose(): void
  /**
   * 差异块导航（Monaco 可用；降级模式为 null）。
   * `state().index` 从 1 起，0 = 位置未知（尚未定位）；`onChange` 让工具条上的计数实时跟随。
   */
  nav?: DiffNav
}

/** 差异块导航：在「上/下一处差异」间跳，位置跟随滚动实时变化。 */
export interface DiffNav {
  next(): void
  prev(): void
  state(): { index: number; total: number }
  /**
   * 订阅计数变化（滚动、跳转、差异重算都会触发）。
   * 返回退订函数——订阅方是**标签栏**，每次重建标签栏都要退订旧的，
   * 否则重渲染几次就有几个野订阅在更新早已移除的 DOM。
   */
  onChange(cb: (s: { index: number; total: number }) => void): () => void
}

let monacoPromise: Promise<Monaco | null> | null = null
let monacoRef: Monaco | null = null
/** 已插入 head 的 AMD loader script（失败/超时后清理或复用，防重试时叠加多个 loader）。 */
let monacoScript: HTMLScriptElement | null = null
let currentTheme = "gebai-dark"
let lightTheme = false

/**
 * 自动换行（word wrap）：**模块级偏好 + 活动实例注册**。
 *
 * 为什么是模块级而不是每个编辑器各带一个入参：它是用户级偏好（刷新、跨文件、跨入口都一致），
 * 切换点却有多处（动作轮盘 / Alt+Z），而同一时刻可能有好几个编辑器活着（每个文件标签一个，
 * 合并视图还一次开三个）——把「记住开关」与「应用到全部」收在一处，调用方说一次 toggle 即可，
 * 不必自己遍历标签。实例 dispose 时自行注销，集合不会留住已卸载的编辑器。
 */
let wrapOn = readWordWrap()
type WrapAware = { setWordWrap: (on: boolean) => void }
const wrapTargets = new Set<WrapAware>()

/** 当前开关（轮盘按钮据此显示状态）。 */
export function isWordWrap(): boolean {
  return wrapOn
}

/** 设置开关：写回偏好并应用到所有活动编辑器（含差异视图）。 */
export function setWordWrap(on: boolean): void {
  wrapOn = on
  saveWordWrap(on)
  for (const t of wrapTargets) t.setWordWrap(on)
}

/** 切换开关并返回新状态（轮盘按钮与 Alt+Z 共用）。 */
export function toggleWordWrap(): boolean {
  setWordWrap(!wrapOn)
  return wrapOn
}

/** Monaco vendor 目录（`public/vendor/monaco/vs`）。 */
export function monacoVsPath(): string {
  return appPath("/vendor/monaco/vs")
}

/**
 * 加载 Monaco（AMD loader，单例；失败/超时返回 null 触发降级）。
 *
 * 单例语义分两层（可重试）：
 * - **进行中**的加载全局共享同一 promise——并发调用（空闲预热 + 用户打开文件）不重复下载内核；
 * - **失败/超时**不固化——复位单例并移除 loader script，后续调用可重新尝试。
 *   旧版把 resolve(null) 的 promise 永久缓存：一次网络抖动/超时就把本页永久降级为轻量编辑器。
 *   另：即使本次已超时，若 AMD require 稍后才成功（window.monaco 就位），下次调用会直接复用。
 */
export function loadMonaco(timeoutMs = 25000): Promise<Monaco | null> {
  if (monacoRef) return Promise.resolve(monacoRef)
  if (monacoPromise) return monacoPromise
  const promise = new Promise<Monaco | null>((resolve) => {
    const w = window as unknown as Record<string, unknown>
    let settled = false
    const settle = (m: Monaco | null): void => {
      if (settled) return
      settled = true
      if (m) defineTheme(m)
      monacoRef = m
      resolve(m)
      if (m) return
      // 失败/超时：撤销单例缓存（下次调用可重试）并清掉 loader script（重试时重新插入）
      queueMicrotask(() => {
        if (monacoPromise === promise) monacoPromise = null
        monacoScript?.remove()
        monacoScript = null
      })
    }
    if (w.monaco) {
      settle(w.monaco as Monaco)
      return
    }
    const vs = monacoVsPath()
    w.MonacoEnvironment = {
      getWorkerUrl: (_moduleId: string, _label: string) => `${vs}/base/worker/workerMain.js`,
    }
    const script = monacoScript ?? document.createElement("script")
    monacoScript = script
    script.src = `${vs}/loader.js`
    script.async = true
    script.onload = () => {
      const requireFn = w.require as ((deps: string[], cb: () => void) => void) | undefined
      try {
        ;(w.require as { config?: (o: unknown) => void }).config?.({ paths: { vs } })
        requireFn?.(["vs/editor/editor.main"], () => {
          settle(((window as unknown as Record<string, unknown>).monaco as Monaco | undefined) ?? null)
        })
      } catch {
        settle(null)
      }
    }
    script.onerror = () => {
      console.warn("[files] Monaco 加载失败（vendor 缺失？），降级为轻量编辑器")
      settle(null)
    }
    if (!script.isConnected) document.head.appendChild(script)
    setTimeout(() => {
      if (!monacoRef) settle(null)
    }, timeoutMs)
  })
  monacoPromise = promise
  return promise
}

/**
 * 首屏就绪后的**空闲预热**（静默，失败与未预热等价）。
 *
 * Monaco 首次加载要拉约 1MB 分块（editor 核心 + 语言 + worker），本地实测约 0.5s、远程更久。
 * 放在 requestIdleCallback（无此 API 时退化为短延时）里预热：不与他人争首屏带宽，
 * 用户首次打开文件时内核已就位，不再等加载。预热失败不影响后续：打开文件时自会重试并可能降级。
 */
export function prewarmMonaco(): void {
  if (monacoRef || monacoPromise) return
  const run = (): void => {
    void loadMonaco().catch(() => undefined)
  }
  const schedule = (): void => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    if (typeof ric === "function") ric(run, { timeout: 2500 })
    else setTimeout(run, 500)
  }
  // 后台标签页（Ctrl+点击开的新标签）：首屏并不在看，先不拉这 1MB，等切到前台再预热
  if (document.hidden) {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden) schedule()
      },
      { once: true },
    )
    return
  }
  schedule()
}

/* --------------------------- 主题映射 --------------------------- */

/**
 * 读取 CSS 令牌的**浏览器计算值**（任意颜色语法 → `rgb()`/`rgba()` 文本）。
 * 令牌值可能是 hsl()/color-mix()/颜色关键字，交给浏览器在探针元素上算一次最稳。
 */
function computedVar(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!raw) return ""
  const probe = document.createElement("span")
  probe.style.color = raw
  probe.style.position = "absolute"
  probe.style.opacity = "0"
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  return computed
}

function alpha(hex: string, a: number): string {
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, "0")
  return `${hex}${v}`
}

/** 依据当前 CSS 令牌重定义 Monaco 主题（light/dark 同名两套，按当前主题明暗选择）。 */
export function defineTheme(monaco: Monaco): void {
  // 逐层合成出**不透明**实色：页面底（body 计算背景）→ 编辑器底。
  // 编辑器底取**视图面板底**（--bg-elev，与左栏/工具窗/标签栏/状态栏同一层）：编辑器坐在工作台视图里，
  // 两邊同亮度才是一整块；早期用内凹色 --bg-inset（输入框/代码内嵌的语义）比面板暗 4~19 级——
  // 亮色亚克力下就是面板 250 里嵌一块 236 的灰块（用户可见：视图背景与编辑器背景亮度差得有点大）。
  // 与面板同样直接叠在**页面底**上（面板就在透明容器里直接露页面底，叠在 --bg 上会多亮一档）。
  const page = getComputedStyle(document.body).backgroundColor || "#0d1117"
  const pick = (name: string, fallback: string, backdrop: string): string => cssVarToHex(computedVar(name), backdrop, fallback)
  const bg = pick("--bg-elev", pick("--bg", page, page), page)
  const fg = pick("--text", "#e6edf3", bg)
  const muted = pick("--text-muted", "#8b949e", bg)
  const faint = pick("--text-faint", "#6e7681", bg)
  const accent = pick("--accent", "#6366f1", bg)
  const border = pick("--border", "#262b3a", bg)
  const elev = pick("--bg-elev-2", bg, bg) // 浮层/建议框：面板再抬一档（各主题均定义；缺失则与编辑器同底，靠 border 分辨）
  const success = pick("--success", "#3fb950", bg)
  const danger = pick("--danger", "#f85149", bg)
  const warning = pick("--warning", "#d29922", bg)

  // 明暗判定：合成后的编辑器底色亮度（不依赖 data-theme，任何主题/黑白变体都能自适应）
  const rgb = bg.match(/\w\w/g) ?? []
  const lum = rgb.length === 3 ? (parseInt(rgb[0], 16) * 0.299 + parseInt(rgb[1], 16) * 0.587 + parseInt(rgb[2], 16) * 0.114) / 255 : 0
  lightTheme = lum > 0.5

  monaco.editor.defineTheme("gebai", {
    base: lightTheme ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: fg.slice(1), background: bg.slice(1) },
      { token: "comment", foreground: faint.slice(1), fontStyle: "italic" },
      { token: "keyword", foreground: accent.slice(1) },
      { token: "string", foreground: success.slice(1) },
      { token: "number", foreground: warning.slice(1) },
      { token: "regexp", foreground: warning.slice(1) },
      { token: "type", foreground: accent.slice(1) },
      { token: "type.identifier", foreground: accent.slice(1) },
      { token: "function", foreground: muted.slice(1) },
      { token: "variable", foreground: fg.slice(1) },
      { token: "tag", foreground: accent.slice(1) },
      { token: "attribute.name", foreground: warning.slice(1) },
      { token: "delimiter", foreground: muted.slice(1) },
      { token: "invalid", foreground: danger.slice(1) },
    ],
    colors: {
      "editor.background": bg,
      "editor.foreground": fg,
      "editorLineNumber.foreground": faint,
      "editorLineNumber.activeForeground": muted,
      "editorCursor.foreground": accent,
      "editor.selectionBackground": alpha(accent, lightTheme ? 0.22 : 0.3),
      "editor.inactiveSelectionBackground": alpha(accent, 0.14),
      "editor.selectionHighlightBackground": alpha(accent, 0.14),
      "editor.lineHighlightBackground": alpha(muted, lightTheme ? 0.09 : 0.07),
      "editor.lineHighlightBorder": "#00000000",
      "editorIndentGuide.background1": alpha(border, 0.75),
      "editorIndentGuide.activeBackground1": alpha(accent, 0.5),
      "editorBracketMatch.background": alpha(accent, 0.18),
      "editorBracketMatch.border": alpha(accent, 0.5),
      "editorWhitespace.foreground": alpha(faint, 0.5),
      "editorGutter.background": bg,
      "editorWidget.background": elev,
      "editorWidget.border": border,
      "editorSuggestWidget.background": elev,
      "editorSuggestWidget.selectedBackground": alpha(accent, 0.22),
      "editorHoverWidget.background": elev,
      "editorHoverWidget.border": border,
      "input.background": bg,
      "input.border": border,
      "scrollbar.shadow": "#00000000",
      "scrollbarSlider.background": alpha(muted, 0.22),
      "scrollbarSlider.hoverBackground": alpha(muted, 0.36),
      "scrollbarSlider.activeBackground": alpha(accent, 0.5),
      "minimap.background": bg,
      "menu.background": elev,
      "menu.border": border,
      "list.hoverBackground": alpha(muted, 0.12),
      "list.activeSelectionBackground": alpha(accent, 0.24),
      "diffEditor.insertedTextBackground": alpha(success, 0.16),
      "diffEditor.removedTextBackground": alpha(danger, 0.16),
      "diffEditor.insertedLineBackground": alpha(success, 0.09),
      "diffEditor.removedLineBackground": alpha(danger, 0.09),
      "diffEditorGutter.insertedLineBackground": alpha(success, 0.2),
      "diffEditorGutter.removedLineBackground": alpha(danger, 0.2),
    },
  })
}

/** 按当前令牌定义并切到 gebai 主题。 */
function applyGebaiTheme(monaco: Monaco): void {
  defineTheme(monaco)
  monaco.editor.setTheme("gebai")
  currentTheme = "gebai"
}

/**
 * 主题切换时重映射（main.ts 监听 gebai:theme-change / 本地切换）。
 *
 * 为什么不直接同步定义：换肤会带动 body 背景的 CSS 过渡（base.css 的全局过渡名单含 body），
 * 而合成链（页面底 → --bg → --bg-inset）以 body 底色打底——过渡途中取色会把**中间值**
 * 固化成编辑器底色（亮色切回后整块偏暗），且此后不再有事件触发重定义、不会自愈。
 *
 * “两帧底色一致”这种稳定性判据不够：过渡要等样式变更后的下一帧才启动，头两帧读到的
 * 还是旧值（看者“稳定”），所以改用 `getAnimations()` 直接看 body 的 background-color 过渡
 * 是否还在跑（过渡结束才定义）；第一帧只作让位。getAnimations 不可用时按典型过渡时长延时兜底。
 */
export function refreshEditorTheme(): void {
  if (!monacoRef) return
  const monaco = monacoRef
  const apply = (): void => applyGebaiTheme(monaco)
  if (typeof requestAnimationFrame !== "function" || typeof document.body?.getAnimations !== "function") {
    setTimeout(apply, 320)
    return
  }
  const body = document.body
  const deadline = performance.now() + 1000
  let frames = 0
  const transitioning = (): boolean =>
    body.getAnimations().some((a) => a.playState === "running" && (a as CSSTransition).transitionProperty === "background-color")
  const step = (): void => {
    frames++
    if (frames > 1 && !transitioning()) {
      apply()
      return
    }
    if (performance.now() > deadline) {
      apply()
      return
    }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

export { currentTheme }

/* --------------------------- 编辑器实现 --------------------------- */

/** 大文件阈值：超过后关闭小地图与高级特性。 */
const LARGE_FILE_CHARS = 1_500_000

/**
 * 选区字符数：按行长度累加算出，**不物化选区文本**。
 *
 * 早期这里用 `model.getValueInRange(sel).length`——选中多少就分配多少字符的字符串：
 * 拖选/全选大文件时每个 mousemove 都要分配一遍（MB 级），是输入与拖选卡顿的元凶之一。
 * 行长度是 Monaco 的行元数据（O(1)），累加只与**选中行数**相关，与字符量无关。
 */
function rangeLength(model: { getLineLength: (n: number) => number }, startLine: number, startColumn: number, endLine: number, endColumn: number): number {
  if (endLine < startLine || (endLine === startLine && endColumn <= startColumn)) return 0
  let len = endLine - startLine // 行间换行
  for (let l = startLine; l <= endLine; l++) len += model.getLineLength(l)
  return Math.max(0, len - (startColumn - 1) - (model.getLineLength(endLine) - endColumn + 1))
}

export async function createEditor(host: HTMLElement, opts: EditorOptions): Promise<EditorHandle> {
  const loaded = await loadMonaco()
  if (!loaded) return createFallbackEditor(host, opts)
  // 取局部非空别名：闭包（侧边列/行尾注释的渲染函数）里 TS 不再保留对 `loaded` 的窄化
  const monaco: Monaco = loaded
  defineTheme(monaco)
  const large = opts.value.length > (opts.largeFileChars ?? LARGE_FILE_CHARS)
  const model = monaco.editor.createModel(opts.value, opts.language)
  /*
   * 编辑器与 blame 侧边列并排（flex）：侧边列**在 Monaco 容器之外**，不挤占也不覆盖代码内容——
   * 这是与「把注释注入行首」的关键区别（那种做法会把每行代码整体右移，看着就像代码里多了一列字）。
   * 列隐藏时 `hidden`（display:none），编辑器自动占满（automaticLayout 跟容器尺寸变化重排）。
   */
  const wrap = document.createElement("div")
  wrap.className = "fw-editor-wrap"
  const blameGutter = document.createElement("div")
  blameGutter.className = "fw-blame-gutter"
  blameGutter.hidden = true
  const blameInner = document.createElement("div")
  blameInner.className = "fw-blame-gutter-inner"
  blameGutter.appendChild(blameInner)
  const edHost = document.createElement("div")
  // 类名用 surface 而不是 host：调用方（files/main.ts）已经有一个 `.fw-editor-host` 作为外容器，
  // 同名会让选择器与样式双重歧义
  edHost.className = "fw-editor-surface"
  wrap.append(blameGutter, edHost)
  host.appendChild(wrap)
  const ed = monaco.editor.create(edHost, {
    model,
    theme: "gebai",
    readOnly: opts.readOnly,
    automaticLayout: true,
    minimap: { enabled: !large && (opts.minimap ?? true), maxColumn: 90, renderCharacters: false },
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 20,
    tabSize: 2,
    renderWhitespace: "selection",
    renderLineHighlight: large ? "none" : "all",
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    wordWrap: (opts.wordWrap ?? wrapOn) ? "on" : "off",
    bracketPairColorization: { enabled: !large },
    guides: { bracketPairs: !large, indentation: !large },
    stickyScroll: { enabled: false },
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
    scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11, useShadows: false },
    overviewRulerBorder: false,
    contextmenu: true,
    quickSuggestions: !opts.readOnly,
    suggestOnTriggerCharacters: !opts.readOnly,
    formatOnPaste: !opts.readOnly,
    padding: { top: 8, bottom: 24 },
    fixedOverflowWidgets: true,
  })
  /** 编辑器句柄的类型别名（闭包内用，避免为了窄化再重复断言）。 */
  type DecoCollection = ReturnType<typeof ed.createDecorationsCollection>

  /* ---------- 行内 blame：侧边列 + 光标行行尾 ---------- */

  /** 行号 → blame 条目；null = 没有数据（两态都画不出东西）。 */
  let blameIndex: Map<number, BlameLine> | null = null
  /** 两种显示形态的开关（**互不影响**：可以只开行尾、只开侧边列、或都开）。 */
  let gutterOn = false
  let inlineOn = false
  /** 侧边列的行节点池（滚动时逐帧复用，不重建 DOM）。 */
  const blameRows: HTMLElement[] = []
  let blameRaf = 0
  /** 光标行行尾注释（单独一个集合：只随光标移动更新一行）。 */
  let cursorBlame: DecoCollection | null = null

  /**
   * 重画侧边列：只渲染**当前可见行**（含折行时按行遍历）。
   * 位置用 `getScrolledVisiblePosition`（相对编辑器视口的 y），折行/自适应行高都对得上；
   * 它内部就是逐行几何，不用自己假定行高（CSS 行高与 Monaco 保持一致的口径留给样式表）。
   */
  function paintBlame(): void {
    blameRaf = 0
    if (!gutterOn || !blameIndex) return
    let i = 0
    for (const r of ed.getVisibleRanges()) {
      for (let line = r.startLineNumber; line <= r.endLineNumber; line++) {
        const info = blameIndex.get(line)
        if (!info) continue
        const pos = ed.getScrolledVisiblePosition({ lineNumber: line, column: 1 })
        if (!pos) continue
        const row = blameRows[i] ?? (blameRows[i] = document.createElement("div"))
        if (!row.isConnected) {
          row.className = "fw-blame-row"
          blameInner.appendChild(row)
        }
        i++
        row.hidden = false
        row.style.top = `${pos.top}px`
        row.style.height = `${pos.height}px`
        row.textContent = blameLabel(info)
        row.classList.toggle("is-uncommitted", info.uncommitted)
        row.dataset.tip = blameHover(info)
      }
    }
    for (; i < blameRows.length; i++) blameRows[i]!.hidden = true
  }

  function scheduleBlame(): void {
    if (!gutterOn || !blameIndex || blameRaf) return
    blameRaf = requestAnimationFrame(paintBlame)
  }

  /** 光标行行尾注释：只在光标所在行显示，样式比侧边列更弱（当前行的视线内提示）。 */
  function updateCursorBlame(): void {
    const pos = inlineOn ? ed.getPosition() : null
    const info = blameIndex && pos ? blameIndex.get(pos.lineNumber) : undefined
    if (!info || !pos) {
      cursorBlame?.clear()
      return
    }
    const range = new monaco.Range(pos.lineNumber, model.getLineMaxColumn(pos.lineNumber), pos.lineNumber, model.getLineMaxColumn(pos.lineNumber))
    const deco = {
      range,
      options: {
        description: "git-blame-eol",
        showIfCollapsed: true,
        after: {
          content: `  ${blameLabel(info)}`,
          inlineClassName: info.uncommitted ? "fw-blame-eol is-uncommitted" : "fw-blame-eol",
          /* 光标不在注释里停下（默认 Both 会让方向键卡在这段注入文本上）——它不是内容，只是批注 */
          cursorStops: monaco.editor.InjectedTextCursorStops?.None ?? null,
        },
      },
    }
    if (cursorBlame) cursorBlame.set([deco])
    else cursorBlame = ed.createDecorationsCollection([deco])
  }

  const blameSubs = [
    ed.onDidScrollChange(() => scheduleBlame()),
    ed.onDidLayoutChange(() => scheduleBlame()),
    ed.onDidChangeModelContent(() => {
      scheduleBlame()
      updateCursorBlame()
    }),
    ed.onDidChangeCursorPosition(() => updateCursorBlame()),
  ]
  /** 选区长度（同范围复用上次结果：光标事件与选区事件都会问一次，拖选时每个事件都要算） */
  let selKey = ""
  let selLen = 0
  const selectionLength = (): number => {
    const sel = ed.getSelection()
    if (!sel || sel.isEmpty()) {
      selKey = ""
      selLen = 0
      return 0
    }
    const key = `${sel.startLineNumber}:${sel.startColumn}-${sel.endLineNumber}:${sel.endColumn}`
    if (key !== selKey) {
      selKey = key
      selLen = rangeLength(model, sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn)
    }
    return selLen
  }

  const handle: EditorHandle = {
    kind: "monaco",
    getValue: () => model.getValue(),
    setValue: (v) => {
      model.setValue(v)
    },
    setLanguage: (lang) => {
      monaco.editor.setModelLanguage(model, lang || "plaintext")
    },
    setReadOnly: (ro) => ed.updateOptions({ readOnly: ro }),
    isReadOnly: () => ed.getOption(monaco.editor.EditorOption.readOnly),
    setWordWrap: (on) => ed.updateOptions({ wordWrap: on ? "on" : "off" }),
    focus: () => ed.focus(),
    layout: () => ed.layout(),
    revealLine: (line, column = 1) => {
      ed.revealLineInCenter(line + 1)
      ed.setPosition({ lineNumber: line + 1, column })
      ed.focus()
    },
    getScrollTop: () => ed.getScrollTop(),
    setScrollTop: (top) => ed.setScrollTop(top),
    getCursor: () => {
      const pos = ed.getPosition()
      return { line: pos?.lineNumber ?? 1, column: pos?.column ?? 1, selected: selectionLength() }
    },
    onCursor: (cb) => {
      ed.onDidChangeCursorPosition((e) => {
        cb({ line: e.position.lineNumber, column: e.position.column, selected: selectionLength() })
      })
      ed.onDidChangeCursorSelection((e) => {
        cb({ line: e.selection.positionLineNumber, column: e.selection.positionColumn, selected: selectionLength() })
      })
    },
    onChange: (cb) => {
      ed.onDidChangeModelContent(() => cb())
    },
    markClean: () => {
      /* Monaco 无需额外处理：脏标记由上层按内容比对维护 */
    },
    setBlame: (lines, show) => {
      /*
       * 两种形态互相独立（两个按钮各自开关）：
       * ① **侧边列**（`gutter`）——编辑器左侧独立一列，与代码内容分开（在 Monaco 容器之外，不挤占也不覆盖）；
       *    位置用 `getScrolledVisiblePosition` 随滚动/折行按帧重算，只渲染可见行。
       * ② **光标行行尾**（`inline`）——`after` 注入到光标所在行行尾，样式更弱；光标移动只更新这一个集合。
       *
       * 两处都是**装饰/注入文本，不进模型**：复制、保存、撤销拿到的都是原文，不会被 blame 污染。
       * 注入文本挂在**空 range** 上时必须显式 `showIfCollapsed: true`——Monaco 取注入文本会
       * 按 `showIfCollapsed || !range.isEmpty()` 过滤空 range，不给这个标记就是静默丢弃。
       */
      blameIndex = lines.length ? toBlameIndex(lines) : null
      gutterOn = show.gutter && !!blameIndex
      inlineOn = show.inline && !!blameIndex
      blameGutter.hidden = !gutterOn
      if (!gutterOn) {
        for (const row of blameRows) row.remove()
        blameRows.length = 0
        if (blameRaf) cancelAnimationFrame(blameRaf)
        blameRaf = 0
      }
      // 侧边列显隐改变编辑器可用宽度：先 layout（会触发 onDidLayoutChange → 重画可见行）
      ed.layout()
      paintBlame()
      updateCursorBlame()
    },
    dispose: () => {
      wrapTargets.delete(handle)
      cursorBlame?.clear()
      for (const sub of blameSubs) sub.dispose()
      if (blameRaf) cancelAnimationFrame(blameRaf)
      ed.dispose()
      model.dispose()
      wrap.remove()
    },
  }
  wrapTargets.add(handle)
  return handle
}

/** 降级编辑器：只读用 highlight.js 静态高亮，编辑用 textarea（功能对齐，体验降级）。 */
async function createFallbackEditor(host: HTMLElement, opts: EditorOptions): Promise<EditorHandle> {
  const wrap = document.createElement("div")
  wrap.className = "fw-fallback"
  // 自动换行在降级实现里只能靠 CSS（textarea 没有 Monaco 的选项）：类切换即生效
  wrap.classList.toggle("fw-wrap", wrapOn)
  const pre = document.createElement("pre")
  pre.className = "fw-fallback-code hljs"
  const area = document.createElement("textarea")
  area.className = "fw-fallback-edit"
  area.spellcheck = false
  area.value = opts.value
  let readOnly = opts.readOnly
  if (readOnly) area.style.display = "none"
  else pre.style.display = "none"
  wrap.appendChild(pre)
  wrap.appendChild(area)
  host.appendChild(wrap)

  const render = async () => {
    if (!readOnly) return
    try {
      const mod = (await import("highlight.js/lib/common")) as unknown as { default: { highlight: (c: string, o: { language: string }) => { value: string } } }
      const res = mod.default.highlight(area.value, { language: opts.language === "plaintext" ? "plaintext" : opts.language })
      pre.innerHTML = res.value
    } catch {
      pre.textContent = area.value
    }
  }
  await render()
  let cursorCb: CursorListener | null = null
  area.addEventListener("keyup", () => {
    if (!cursorCb) return
    const upto = area.value.slice(0, area.selectionStart)
    const lines = upto.split("\n")
    cursorCb({ line: lines.length, column: lines[lines.length - 1].length + 1, selected: Math.abs(area.selectionEnd - area.selectionStart) })
  })
  const handle: EditorHandle = {
    kind: "fallback",
    getValue: () => area.value,
    setValue: (v) => {
      area.value = v
      void render()
    },
    setLanguage: () => {
      void render()
    },
    setReadOnly: (ro) => {
      readOnly = ro
      area.readOnly = ro
      pre.style.display = ro ? "" : "none"
      area.style.display = ro ? "none" : ""
      void render()
    },
    isReadOnly: () => area.readOnly,
    setWordWrap: (on) => wrap.classList.toggle("fw-wrap", on),
    focus: () => area.focus(),
    layout: () => {},
    revealLine: (line) => {
      const lines = area.value.split("\n")
      const before = lines.slice(0, line).join("\n").length
      area.setSelectionRange(before, before)
      area.scrollTop = Math.max(0, (line - 6) * 20)
    },
    getScrollTop: () => area.scrollTop,
    setScrollTop: (top) => {
      area.scrollTop = top
    },
    getCursor: () => ({ line: 1, column: 1, selected: 0 }),
    onCursor: (cb) => {
      cursorCb = cb
    },
    onChange: () => {
      /* 降级模式由上层 input 事件驱动 */
    },
    markClean: () => {},
    setBlame: () => {},
    dispose: () => {
      wrapTargets.delete(handle)
      wrap.remove()
    },
  }
  wrapTargets.add(handle)
  return handle
}

/* --------------------------- 差异视图 --------------------------- */

export interface DiffOptions {
  original: string
  modified: string
  language: string
  /** 并列 / 行内 */
  inline?: boolean
}

export async function createDiffEditor(host: HTMLElement, opts: DiffOptions): Promise<DiffHandle> {
  const monaco = await loadMonaco()
  if (!monaco) {
    const pre = document.createElement("pre")
    pre.className = "fw-fallback-code"
    pre.textContent = `--- 原\n${opts.original}\n\n+++ 改\n${opts.modified}`
    host.appendChild(pre)
    return { kind: "fallback", layout: () => {}, setWordWrap: () => {}, dispose: () => pre.remove() }
  }
  defineTheme(monaco)
  const original = monaco.editor.createModel(opts.original, opts.language)
  const modified = monaco.editor.createModel(opts.modified, opts.language)
  const ed = monaco.editor.createDiffEditor(host, {
    theme: "gebai",
    readOnly: true,
    wordWrap: wrapOn ? "on" : "off",
    automaticLayout: true,
    renderSideBySide: !opts.inline,
    // 右侧概览尺 = 「差异都在哪」的地图（配合上一处/下一处按钮，是这个视图的核心导航手段）。
    // 普通编辑器关闭它保持干净；差异视图正需要它。
    renderOverviewRuler: true,
    ignoreTrimWhitespace: false,
    fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    lineHeight: 20,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    renderLineHighlight: "none",
    padding: { top: 8, bottom: 16 },
    fixedOverflowWidgets: true,
    scrollbar: { verticalScrollbarSize: 11, horizontalScrollbarSize: 11, useShadows: false },
  })
  ed.setModel({ original, modified })

  /* ---- 差异块导航 ----
   * Monaco 不直接提供 goToNextDiff，但 getLineChanges() 给出全部差异块
   *（原/改两侧的行号区间），据此自己跳。两个关键取舍：
   *  1. 「当前块」以**视口顶部**判定而不是内部游标：用户滚到哪里，计数就显示哪一块
   *     （与 VSCode 的 diff 导航一致）；
   *  2. 纯删除块在 modified 侧行号为 0，此时改在 original 侧定位——
   *     两侧滚动是同步的（diff editor 自带同步滚动），露一边两边都会跟。
   */
  let idx = -1
  const navCbs = new Set<(s: { index: number; total: number }) => void>()
  const changes = (): Array<{ originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number }> =>
    (ed.getLineChanges() ?? []) as never
  /** 差异块清单缓存（滚动事件每帧都问；onDidUpdateDiff 时失效）。 */
  let changeList: ReturnType<typeof changes> | null = null
  const list = (): ReturnType<typeof changes> => (changeList ??= changes())

  /** 视口顶部所在/之后的第一个差异块（都与视口无关时为最后一块）。按 modifiedEndLineNumber 单调递增做二分。 */
  function currentIndex(): number {
    const cs = list()
    if (!cs.length) return -1
    const range = ed.getModifiedEditor().getVisibleRanges()[0]
    const top = range ? range.startLineNumber : 1
    let lo = 0
    let hi = cs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cs[mid].modifiedEndLineNumber >= top) hi = mid
      else lo = mid + 1
    }
    return cs[lo].modifiedEndLineNumber >= top ? lo : cs.length - 1
  }

  function emit(): void {
    const total = list().length
    const s = { index: total ? currentIndex() + 1 : 0, total }
    for (const cb of navCbs) cb(s)
  }

  function reveal(i: number): void {
    const cs = list()
    const c = cs[i]
    if (!c) return
    idx = i
    const me = ed.getModifiedEditor()
    const oe = ed.getOriginalEditor()
    const hasMod = c.modifiedStartLineNumber >= 1
    const target = hasMod ? me : oe
    const start = hasMod ? c.modifiedStartLineNumber : c.originalStartLineNumber
    const end = hasMod ? Math.max(c.modifiedEndLineNumber, c.modifiedStartLineNumber) : Math.max(c.originalEndLineNumber, c.originalStartLineNumber)
    // 选中整块：目标一眼可见（仅 revealLine 时，块很长也不好认）。
    // 末列取该行**最大列**——单行变更若用 col 1 → col 1 是零宽选区（等于一个光标），
    // 编辑器不会画任何选区高亮，"跳过去了"就看不出来。
    const model = target.getModel()
    target.setSelection({ startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: model ? model.getLineMaxColumn(end) : 1 })
    target.revealLineInCenterIfOutsideViewport(start)
    // Monaco 只在**获焦**时画强选区高亮；顺便让后续按键（方向键、Ctrl+F）落到差异视图上。
    // 不抢表单焦点：在提交框/搜索框里打字时按 F7，不应把光标拽走。
    const active = document.activeElement as HTMLElement | null
    const inField = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
    if (!inField) target.focus()
    emit()
  }

  /** 从当前块出发到下一（dir=1）/ 上一（dir=-1）处；到头**回卷**（连点不会没反馈地卡住，同 IDEA）。 */
  function step(dir: 1 | -1): void {
    const cs = list()
    if (!cs.length) return
    const base = idx < 0 ? (dir === 1 ? -1 : 0) : idx
    const next = base + dir
    reveal(next < 0 ? cs.length - 1 : next >= cs.length ? 0 : next)
  }

  // 滚动 / 差异重算后刷新计数（滚动事件每帧都会回调：合并到一帧再算，计数 DOM 也随之少刷）
  let scrollRaf = 0
  const sub = ed.getModifiedEditor().onDidScrollChange(() => {
    if (scrollRaf) return
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0
      if (idx >= 0) idx = currentIndex()
      emit()
    })
  })
  const diffSub = ed.onDidUpdateDiff(() => {
    changeList = null
    idx = -1
    emit()
  })
  emit()

  const nav: DiffNav = {
    next: () => step(1),
    prev: () => step(-1),
    state: () => ({ index: list().length ? Math.max(1, (idx < 0 ? currentIndex() : idx) + 1) : 0, total: list().length }),
    onChange: (cb) => {
      navCbs.add(cb)
      cb(nav.state())
      return () => navCbs.delete(cb)
    },
  }

  /* 键盘：捕获阶段挂在 host 上。
   * 必须用 capture——Monaco 的 diff editor **内置**了 F7 / Shift+F7（diffReview）
   * 并会 stopPropagation，冒泡阶段（宿主 main.ts 的全局快捷键）根本收不到：
   * 编辑器一获焦，F7 就变成 Monaco 自己行为（且与我们的计数不同步）。
   * 捕获先于 Monaco 自己的监听器，拦下并自己处理；Alt+↑↓ 一并支持。 */
  const onKeyDown = (e: KeyboardEvent): void => {
    const isNext = e.key === "F7" && !e.shiftKey
    const isPrev = e.key === "F7" && e.shiftKey
    const isAlt = e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")
    if (!isNext && !isPrev && !isAlt) return
    e.preventDefault()
    e.stopPropagation()
    if (isPrev || e.key === "ArrowUp") nav.prev()
    else nav.next()
  }
  host.addEventListener("keydown", onKeyDown, true)

  const handle: DiffHandle = {
    kind: "monaco",
    nav,
    layout: () => ed.layout(),
    // 差异两侧一起切：只改一侧会变成“一边折行、一边横滚”
    setWordWrap: (on) => {
      const v: "on" | "off" = on ? "on" : "off"
      ed.getOriginalEditor().updateOptions({ wordWrap: v })
      ed.getModifiedEditor().updateOptions({ wordWrap: v })
    },
    dispose: () => {
      wrapTargets.delete(handle)
      host.removeEventListener("keydown", onKeyDown, true)
      sub.dispose()
      diffSub.dispose()
      ed.dispose()
      original.dispose()
      modified.dispose()
    },
  }
  wrapTargets.add(handle)
  // 构造项在部分内核版本下不透传给两侧子编辑器：以子编辑器为准对齐一次，保证初始态一致
  if (wrapOn) handle.setWordWrap(true)
  return handle
}

/** 是否已在当前页面加载出 Monaco（用于状态栏提示与测试）。 */
export function monacoReady(): boolean {
  return !!monacoRef
}
