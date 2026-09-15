/**
 * 流式 markdown 增量渲染（stream.ts 用）：
 *
 * 流式正文每 120ms 渲染一次，若每次都对累积全文重跑 markdown 解析（+ 代码高亮），长回答下成本
 * 随长度线性增长、整轮累计 O(n²)——这是「会话运行时掉帧」在特效降载到位后的剩余主因。
 * 这里按**块边界**把文本切成「已稳定的前缀」与「仍在增长的尾部」：前缀渲染一次即常驻复用，
 * 每次只重渲染尾部——尾部长度与「最后一块」同量级、不随回答变长，单帧成本近似恒定。
 *
 * 结构（与全量渲染完全一致，避免样式偏差）：容器内只有一个 `.markdown` 包裹层
 * （`> :first-child` / `> :last-child` 的边距归零规则依赖它），前缀块与尾部块都是它的直接子节点，
 * 尾部块每帧整体替换。片段单独渲染出的块挂进最终位置后，边距由相邻兄弟规则（margin 折叠）决定，
 * 故与整体渲染视觉一致。
 *
 * 切点安全性（只在块边界切，片段独立渲染与整体渲染结果一致）：
 * - 围栏代码块（``` / ~~~）未闭合期间不切（否则片段解析不出代码块）；
 * - 推理片段 `<think>…</think>` 未闭合期间不切（卡片抽取依赖成对标签）；
 * - 空行后的首个非空行若可能**延续前一个块**（列表项、引用、缩进块、表格行）则不切——
 *   markdown 的松散列表与多段引用会跨空行，切开会裂成两个块（编号列表重新计数等可见差异）。
 * markdown-it 配置 `html: false`（内联 HTML 按文本转义），故无 HTML 块跨空行的歧义。
 * 参考式链接定义（`[a]: url`）跨切点会失效——流式半成品场景可接受，封段后的渲染以全量文本为准。
 */

/** 围栏代码块起始行（```` ``` ```` / `~~~`，最多 3 空格缩进）。 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
/** 空行（含仅空白）。 */
const BLANK_RE = /^[ \t]*$/
/** 行类型（判断空行两侧是否属于同一个可跨空行的块）。 */
type LineKind = "blank" | "fence" | "list" | "quote" | "indent" | "other"

function classify(line: string): LineKind {
  if (BLANK_RE.test(line)) return "blank"
  if (FENCE_RE.test(line)) return "fence"
  if (/^\t/.test(line) || /^ {4,}/.test(line)) return "indent"
  if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line)) return "list"
  if (/^ {0,3}>/.test(line)) return "quote"
  return "other"
}

/** 跨越空行仍可能属于同一个块的行类型（松散列表 / 多段引用 / 缩进块）：切开会裂成两块。 */
const CONTINUABLE: ReadonlySet<LineKind> = new Set<LineKind>(["list", "quote", "indent"])

/**
 * 求「可安全切分」的位置（返回 `from` 之后最后一个块边界；无则返回 `from`）。
 * 约定：`from` 处必在围栏与 `<think>` 之外（调用方传入上一次的切点，或 0）。
 */
export function findStableCut(text: string, from = 0): number {
  let cut = Math.max(0, Math.min(from, text.length))
  let fence: string | null = null
  let inThink = false
  let candidate = -1
  let prevKind: LineKind = "other"
  const lines = text.slice(cut).split("\n")
  let pos = cut
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const isLast = li === lines.length - 1
    const next = pos + line.length + 1
    if (fence) {
      const m = FENCE_RE.exec(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null
      pos = next
      continue
    }
    const kind = classify(line)
    if (kind === "blank") {
      // 末尾空行（文本以换行结束）不作候选：尚不知后接何种块
      if (!isLast) candidate = next
      pos = next
      continue
    }
    if (candidate >= 0) {
      // 空行两侧同类且可跨空行延续（松散列表 / 多段引用 / 缩进块），或在推理片段内 → 不成边界
      if (!inThink && !(CONTINUABLE.has(prevKind) && prevKind === kind)) cut = candidate
      candidate = -1
    }
    // `<think>` 状态（围栏内是代码文本，已在上分支 continue）
    const open = line.lastIndexOf("<think>")
    const close = line.lastIndexOf("</think>")
    if (close >= 0 && close > open) inThink = false
    else if (open >= 0) inThink = true
    if (kind === "fence") fence = FENCE_RE.exec(line)?.[1] ?? "```"
    else prevKind = inThink ? "other" : kind
    pos = next
  }
  return cut
}

export interface StreamRenderer {
  /** 用最新累积文本更新容器（首参容器变化或文本被重写时自动重建）。 */
  update(container: HTMLElement, text: string): void
  /** 已常驻的前缀块数量（诊断/测试用）。 */
  stableBlocks(): number
  /** 当前是否处于增量形态（诊断/测试用）。 */
  incremental(): boolean
}

export interface StreamRendererOptions {
  /** 增量路径：把一段**无推理卡片**的 markdown 渲染为 `.markdown` 包裹元素（取 childNodes 挂进宿主容器）。 */
  renderFragment: (text: string) => { childNodes: ArrayLike<ChildNode> }
  /** 全量路径（含 `\u003cthink\u003e` 的文本与会话重建）：返回直接放进容器的节点。缺省用 renderFragment。 */
  renderFull?: (text: string) => { childNodes: ArrayLike<ChildNode> }
  /** 该文本是否可走增量（默认排除含 `\u003cthink\u003e` 的文本：卡片抽取需整体处理）。 */
  canIncremental?: (text: string) => boolean
}

export function createStreamRenderer(opts: StreamRendererOptions): StreamRenderer {
  const canIncremental = opts.canIncremental ?? ((text: string) => !/<think>/.test(text))
  let host: HTMLElement | null = null
  let stableEnd = 0
  let tail: ChildNode[] = []
  let renderedLength = 0
  let blocks = 0

  /** 确保容器内有一个我们管理的 `.markdown` 包裹层（外部清空/重建时重新开始）。 */
  function ensureHost(container: HTMLElement): HTMLElement {
    if (host && host.parentNode === container) return host
    container.replaceChildren()
    host = document.createElement("div")
    host.className = "markdown"
    container.appendChild(host)
    stableEnd = 0
    tail = []
    renderedLength = 0
    blocks = 0
    return host
  }

  function fullRender(container: HTMLElement, text: string): void {
    container.replaceChildren(...Array.from((opts.renderFull ?? opts.renderFragment)(text).childNodes))
    host = null
    stableEnd = 0
    tail = []
    renderedLength = text.length
    blocks = 0
  }

  return {
    update(container, text) {
      // 不可增量（含推理卡片）或文本被重写（重连重放等导致缩短）→ 全量重建
      if (!canIncremental(text) || text.length < renderedLength) {
        fullRender(container, text)
        return
      }
      const box = ensureHost(container)
      // 尾部块整体替换（前缀块常驻）
      for (const node of tail) node.remove()
      tail = []
      const cut = findStableCut(text, stableEnd)
      if (cut > stableEnd) {
        for (const node of Array.from(opts.renderFragment(text.slice(stableEnd, cut)).childNodes)) {
          box.appendChild(node)
          blocks++
        }
        stableEnd = cut
      }
      const rest = text.slice(stableEnd)
      if (rest) {
        tail = Array.from(opts.renderFragment(rest).childNodes)
        for (const node of tail) box.appendChild(node)
      }
      renderedLength = text.length
    },
    stableBlocks: () => blocks,
    incremental: () => host !== null,
  }
}
