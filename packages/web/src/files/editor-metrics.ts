/**
 * 文件工作台 · 编辑器字符宽度测量：字体就绪、自检与校准（自 editor.ts 拆出，纯逻辑可单测）。
 *
 * **为什么需要它**：Monaco 只在 `editor.create` 时用 canvas 量一次字符宽度（`spaceWidth` / 典型半角宽）
 * 并长期缓存，此后光标位置、选区矩形、鼠标点击落点一律按「列号 × 该宽度」算。而编辑器字体是
 * `@font-face` + `font-display: swap` 的懒加载 woff2：一旦这次测量落在字体落地之前，量到的是
 * **回退字体的前进宽度**，字体随后换上时正文按真字体排版、缓存却不再更新——光标与文字错位，并且
 * **误差随列号累积**（回退的 Consolas 是 0.55em、JetBrains Mono 是 0.6em，几十列就偏出一个字符，
 * 行越长越明显；不同平台/缩放档位下回退字体的前进宽度不同，于是只在部分桌面显著）。
 *
 * 三条应对，成本从低到高：
 * 1. **建编辑器前把字体等到就位**（`ensureEditorFont`）——已在缓存里零等待，真等在取时有上限，
 *    超时照常建编辑器（不阻塞打开文件）；
 * 2. **字体后到 / 像素比变化时重测**（`createMetricsSync` 的全局触发）——`remeasureFonts()` 清掉陈旧缓存；
 * 3. **实绘前进宽度自检**——重测后仍与实绘不一致（如分数像素比下逐字形取整）时，关掉等宽快速路径
 *    （该路径正是「列号 × 缓存宽度」假定的来源），并按实绘逐段测量，同时留一条控制台诊断。
 */
import type { editor as MonacoEditor } from "monaco-editor"

type Monaco = typeof import("monaco-editor")
/** 编辑器实例类型（与 `import("monaco-editor").editor.*` 同源）。 */
type ICodeEditor = MonacoEditor.ICodeEditor

/** 编辑器字体（与 base.css 的 @font-face、vendor 的 woff2 同源，随产物分发）。 */
export const EDITOR_FONT_FAMILY = '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace'
/** 编辑器字号（px）：与 lineHeight 一起构成 Monaco 的测量口径。 */
export const EDITOR_FONT_SIZE = 13
/** 建编辑器前等待字体的上限（ms）。 */
const FONT_READY_TIMEOUT_MS = 800
/** 缓存宽度与实绘前进宽度的允许偏差（px/字符）：超过即判「等宽快速路径不可信」。 */
export const MONOSPACE_DRIFT_TOLERANCE = 0.05

/**
 * 等宽快速路径是否可信：偏差在容差内即可信；量不到实绘宽度（编辑器隐藏、正文没有可测行）返回 true
 * ——宁可不干预，也不误关优化。
 */
export function fastPathTrustworthy(spaceWidth: number, paintedAdvance: number | null): boolean {
  if (!Number.isFinite(spaceWidth) || spaceWidth <= 0) return true
  if (paintedAdvance == null || !Number.isFinite(paintedAdvance) || paintedAdvance <= 0) return true
  return Math.abs(paintedAdvance - spaceWidth) <= MONOSPACE_DRIFT_TOLERANCE
}

/** 本次会话是否已判定等宽快速路径不可信：此后新建的编辑器直接带着关闭项创建，不再先错一次。 */
let fastPathDisabled = false

/** 本会话内等宽快速路径是否已被判定不可信（`createEditor` 据此决定初始选项）。 */
export function monoFastPathDisabled(): boolean {
  return fastPathDisabled
}

let fontLoaded = false
let fontWait: Promise<boolean> | null = null

/**
 * 等编辑器字体就绪：先 `fonts.check`（已在缓存里就同步命中），未就绪则显式触发加载并有上限地等待
 * （webfont 不被样式用到就不会去取，`fonts.load` 是主动预热）。返回是否已就绪；超时或缺 API 返回 false。
 */
export function ensureEditorFont(timeoutMs = FONT_READY_TIMEOUT_MS): Promise<boolean> {
  if (fontLoaded) return Promise.resolve(true)
  if (fontWait) return fontWait
  const spec = `${EDITOR_FONT_SIZE}px "JetBrains Mono"`
  fontWait = (async () => {
    const fonts = (document as Document).fonts
    if (!fonts?.load) return false
    if (fonts.check?.(spec)) return true
    const within = <T>(p: Promise<unknown>, fallback: T): Promise<T> =>
      Promise.race([p.then(() => true as unknown as T).catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), timeoutMs))])
    await within(fonts.load(spec), false)
    return fonts.check?.(spec) === true
  })().then((ok) => {
    fontLoaded = ok
    fontWait = null // 未就绪不缓存结论：下次打开文件再等一次（字体可能稍后才可用）
    return ok
  })
  return fontWait
}

/** 单条渲染行内若干字符的前进宽度（CSS px/字符）：取首个字符到第 n 个字符的布局间距。 */
function advanceOfText(node: Text): number | null {
  const n = Math.min(40, node.data.length - 1)
  if (n < 1) return null
  const range = document.createRange()
  const left = (i: number): number => {
    range.setStart(node, i)
    range.setEnd(node, i + 1)
    return range.getBoundingClientRect().left
  }
  const adv = (left(n) - left(0)) / n
  return Number.isFinite(adv) && adv > 0 ? adv : null
}

/** 节点子树里的文本节点（按文档顺序）。 */
function textNodesOf(root: Node): Text[] {
  const out: Text[] = []
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType === 3) out.push(child as Text)
      else walk(child)
    }
  }
  walk(root)
  return out
}

/**
 * 实测「实绘前进宽度」：优先量编辑器**自己渲染的行**（最贴近真实排版），取不到时用探针 span 兜底
 * （复制编辑器 DOM 的计算字体）——正文全是中文或全是短行时仍能自检。编辑器隐藏（非当前标签/面板
 * 未展开）时没有布局，返回 null，调用方按「尚未测」处理，等下一次时机（布局变化/字体落地）。
 */
function paintedAdvance(ed: ICodeEditor): number | null {
  const dom = ed.getDomNode()
  if (!dom?.isConnected || dom.offsetWidth === 0) return null
  for (const line of dom.querySelectorAll<HTMLElement>(".view-lines .view-line")) {
    for (const node of textNodesOf(line)) {
      // 只取纯标识符的长行：折行段、宽字符、行首空白都会掺进别的宽度
      if (!/^[A-Za-z0-9_]{8,}$/.test(node.data)) continue
      const adv = advanceOfText(node)
      if (adv != null) return adv
    }
  }
  const cs = getComputedStyle(dom)
  const probe = document.createElement("span")
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;white-space:pre;" +
    `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};` +
    `letter-spacing:${cs.letterSpacing};font-feature-settings:${cs.fontFeatureSettings};font-variation-settings:${cs.fontVariationSettings}`
  probe.textContent = "M".repeat(20)
  dom.appendChild(probe)
  const adv = probe.getBoundingClientRect().width / 20
  probe.remove()
  return Number.isFinite(adv) && adv > 0 ? adv : null
}

export interface MetricsSync {
  /** 复检一次（已校准过的同步器会跳过；用于布局变化后补测隐藏期无法测的编辑器）。 */
  check(): void
  dispose(): void
}

interface RecheckOpts {
  /** 先 `remeasureFonts()`（字体或像素比变了：缓存宽度得跟着更新） */
  remeasure?: boolean
  /** 先 `layout()`（像素比变化后重排） */
  relayout?: boolean
}
interface SyncImpl extends MetricsSync {
  recheck(opts: RecheckOpts): void
}

const metricsSyncs = new Set<SyncImpl>()
let metricsTriggersBound = false

function recheckAll(opts: RecheckOpts): void {
  for (const s of [...metricsSyncs]) s.recheck(opts)
}

/** 全局触发（只装一次）：字体后到、像素比变化时让所有活着的编辑器复检。 */
function bindMetricsTriggers(): void {
  if (metricsTriggersBound) return
  metricsTriggersBound = true
  // 字体后到（首屏慢、上面那次等待超时后落地、运行中换字体）：缓存宽度必须跟着更新
  ;(document as Document).fonts?.addEventListener?.("loadingdone", () => recheckAll({ remeasure: true }))
  // 像素比变化（窗口拖到另一块缩放不同的显示器、改系统缩放）：测量与绘制口径一起变——重测并重排
  const listenDpr = (): void => {
    window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`)?.addEventListener?.(
      "change",
      () => {
        recheckAll({ remeasure: true, relayout: true })
        listenDpr()
      },
      { once: true },
    )
  }
  listenDpr()
}

/**
 * 建一份度量同步：把「字体后到 / 像素比变化 / 布局变化」三类时机收敛到同一处复检。
 * 复检口径 = 缓存字符宽度 vs 实绘前进宽度：
 * - 一致 → 标为已校准，此后不再打扰；
 * - 不一致 → 先 `remeasureFonts()` 重测（多数情况是字体晚到留下的陈旧缓存，重测即校准）；
 * - 重测后仍不一致 → 关掉等宽快速路径（该路径假定「列号 × 缓存宽度 = 实绘位置」，正是光标/选区
 *   随列号漂移的来源；关掉后 Monaco 按实绘逐段测量）并留一条控制台诊断，供事后定位。
 *
 * `editors` 给要同步的编辑器（差异视图给内层两个：原/改）。调用方在句柄销毁时 `dispose()`。
 */
export function createMetricsSync(monaco: Monaco, editors: () => ICodeEditor[]): MetricsSync {
  bindMetricsTriggers()
  let verified = false
  let reported = false
  let running = false
  let dead = false
  let frame = 0

  const run = (opts: RecheckOpts): void => {
    if (dead || running) return
    running = true
    try {
      const list = editors().filter((e) => !!e)
      if (!list.length) return
      if (opts.relayout) for (const e of list) e.layout()
      if (opts.remeasure) monaco.editor.remeasureFonts()
      const ed = list[0]
      const cached = ed.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth
      const painted = paintedAdvance(ed)
      if (painted == null) return // 未布局或无可测行：保持未校准，等下次时机
      if (fastPathTrustworthy(cached, painted)) {
        verified = true
        return
      }
      monaco.editor.remeasureFonts()
      const after = ed.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth
      verified = fastPathTrustworthy(after, painted)
      if (verified) return
      fastPathDisabled = true
      for (const e of list) e.updateOptions({ disableMonospaceOptimizations: true })
      if (!reported) {
        reported = true
        console.warn(
          `[editor] 字符宽度测量与实绘不一致（缓存 ${after.toFixed(3)}px/字符，实绘 ${painted.toFixed(3)}px/字符）：` +
            "已关闭等宽快速路径，避免光标与选区随列号漂移。",
        )
      }
    } finally {
      running = false
    }
  }

  const schedule = (opts: RecheckOpts): void => {
    // 已校准且不是外部口径变化（字体/像素比）：不再复检
    if (verified && !opts.remeasure) return
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      run(opts)
    })
  }

  const sync: SyncImpl = {
    check: () => schedule({}),
    recheck: (opts) => schedule(opts),
    dispose: () => {
      dead = true
      metricsSyncs.delete(sync)
      if (frame) cancelAnimationFrame(frame)
      frame = 0
    },
  }
  metricsSyncs.add(sync)
  schedule({}) // 首帧后自检：字体已在建编辑器前等到，正常情况一次通过
  return sync
}
