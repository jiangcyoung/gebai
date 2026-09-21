/**
 * 文件工作台 · 「转到符号」面板：把当前文件的符号列出来，边打边筛、↑↓ 选、Enter 跳。
 *
 * 与 Monaco 自带的 Ctrl+Shift+O 并存（分工明确）：焦点在编辑器内时由 Monaco 处理（它有自己的一套
 * 快速选择交互，且能顺带显示内置语言服务的符号）；焦点在编辑器之外（文件树、变更面板、Git 面板）时
 * 由本面板接管——两者用的是**同一份符号数据**（`symbols-core.ts`）与**同一套面板语言**
 * （复用「快速打开」的 `.fw-qo-*` 样式与 ↑↓/Enter/Esc 语义，用户不必在两套手感之间切换）。
 *
 * 与快速打开的关键差别：符号是**当前文件**的，不需要索引与网络请求；但提取本身可能是**异步**的
 * （有语法文件的语言要解析语法树），因此面板**先开、后填**：立即可用，解析完成再列出行，
 * 期间键盘操作不丢（回车会在结果就绪后才生效）。它也是降级编辑器（Monaco 不可用）的符号跳转入口。
 */
import { popKeyScope, pushEscScope } from "../keymap"
import { fuzzyMatch } from "./quick-open-core"
import type { ExtractSource } from "./symbols-extract"
import type { FlatSym, SymKind } from "./symbols-core"
import { searchSymbols } from "./symbols-core"
import { h, icon } from "./ui"

/** 符号种类的展示名（面板右上角的小胶囊）。 */
const KIND_LABEL: Record<SymKind, string> = {
  module: "模块",
  namespace: "命名空间",
  package: "包",
  class: "类",
  interface: "接口",
  struct: "结构体",
  trait: "trait",
  enum: "枚举",
  enumMember: "枚举项",
  function: "函数",
  method: "方法",
  constructor: "构造器",
  field: "字段",
  property: "属性",
  variable: "变量",
  constant: "常量",
  type: "类型",
  macro: "宏",
  event: "事件",
  heading: "标题",
  section: "节",
  key: "键",
  label: "标签",
  table: "表",
  view: "视图",
  procedure: "过程",
  resource: "资源",
  object: "对象",
}

/** 面板渲染上限（与快速打开同口径：再多也不是键盘挑得动的量）。 */
const LIMIT = 200

export interface SymbolPanelDeps {
  /** 当前文件的符号（每次重算都取最新——文件可能刚被编辑过）；异步：可能要走语法树解析。 */
  symbols: () => Promise<FlatSym[]>
  /** 状态栏补充说明（当前语言）。 */
  hint: () => string
  /** 结果来源（语法树 / 词法）——异步取，用于状态栏标注。 */
  source?: () => Promise<ExtractSource>
  /** 跳到目标符号（`line` 为 0 基）。 */
  jump: (sym: FlatSym) => void
}

let active: { focus: () => void } | null = null

/** 面板是否已打开（键位表据此决定 Ctrl+Shift+O 要不要让位给面板自己）。 */
export function isSymbolPanelOpen(): boolean {
  return active !== null
}

export function openSymbolPanel(deps: SymbolPanelDeps): void {
  if (active) {
    active.focus()
    return
  }
  const input = h("input", { class: "fw-qo-input", placeholder: "按符号名搜索（支持缩写，如 pscharge）", spellcheck: "false", autocomplete: "off" })
  const list = h("div", { class: "fw-qo-list" })
  const status = h("div", { class: "fw-qo-status" })
  const card = h("div", { class: "fw-qo" }, [h("div", { class: "fw-qo-head" }, [icon("symbols", 14), input]), list, status])
  const overlay = h("div", { class: "fw-overlay fw-qo-overlay" }, [card])

  let all: FlatSym[] = []
  let items: FlatSym[] = []
  let selected = 0
  /** 解析未完成前不渲染结果区（避免闪一下「没有符号」再出结果） */
  let loading = true
  let sourceNote = ""

  /** 名字里命中查询的位置（用来加粗强调——「匹配到哪几个字」要一眼可见）。 */
  const hitsOf = (sym: FlatSym): Set<number> => {
    const q = input.value.trim()
    if (!q) return new Set()
    const m = fuzzyMatch(q, sym.qualified)
    return new Set(m?.positions ?? [])
  }

  const render = (): void => {
    list.replaceChildren()
    if (loading) {
      list.appendChild(h("div", { class: "fw-qo-empty", text: "正在解析符号…" }))
      status.textContent = deps.hint()
      return
    }
    if (!all.length) {
      list.appendChild(h("div", { class: "fw-qo-empty", text: "这个文件里没有提取到符号（该语言暂不支持，或文件内容为空）" }))
      status.textContent = deps.hint()
      return
    }
    if (!items.length) {
      list.appendChild(h("div", { class: "fw-qo-empty", text: "没有匹配的符号" }))
      status.textContent = `${all.length} 个符号 · ${deps.hint()}${sourceNote}`
      return
    }
    items.forEach((sym, i) => {
      const hits = hitsOf(sym)
      const mark = (text: string, offset: number): DocumentFragment => {
        const frag = document.createDocumentFragment()
        let buf = ""
        let bold = false
        const flush = (): void => {
          if (!buf) return
          frag.appendChild(bold ? h("b", { class: "fw-qo-hit", text: buf }) : document.createTextNode(buf))
          buf = ""
        }
        for (let ci = 0; ci < text.length; ci++) {
          const isHit = hits.has(offset + ci)
          if (isHit !== bold) {
            flush()
            bold = isHit
          }
          buf += text[ci]
        }
        flush()
        return frag
      }
      // 归属（`Class.`）压暗、名字为主体：跳转时最关心的是「哪个名字」而不是「在哪一层」
      const dot = sym.qualified.length - sym.name.length
      const row = h("div", { class: `fw-qo-row${i === selected ? " active" : ""}` })
      const label = h("span", { class: "fw-qo-path" })
      if (dot > 0) label.appendChild(mark(sym.qualified.slice(0, dot), 0))
      label.appendChild(mark(sym.name, dot))
      row.appendChild(label)
      row.appendChild(h("span", { class: "fw-qo-tag", text: KIND_LABEL[sym.kind] }))
      row.appendChild(h("span", { class: "fw-qo-tag", text: String(sym.line + 1) }))
      row.onmousedown = (e) => e.preventDefault()
      row.onclick = () => {
        selected = i
        accept()
      }
      list.appendChild(row)
    })
    // 保持选中行在视野内（行高与 `.fw-qo-row` 一致）
    const rowH = 22
    list.scrollTop = Math.max(0, (selected - 4) * rowH)
    status.textContent = `${items.length} / ${all.length} 个符号 · ${deps.hint()}${sourceNote}`
  }

  /** 重新取符号（异步）：面板已开时保持旧的选中位置。 */
  const reload = (): void => {
    const token = ++loadToken
    void deps.symbols().then((list) => {
      if (token !== loadToken) return // 期间又发起了新的加载
      all = list
      loading = false
      items = searchSymbols(all, input.value, LIMIT)
      selected = Math.min(selected, Math.max(0, items.length - 1))
      render()
      if (!deps.source) return
      void deps.source().then((src) => {
        if (token !== loadToken) return
        sourceNote = src === "lsp" ? " · 语言服务器" : src === "tree-sitter" ? " · 语法树" : " · 词法规则"
        render()
      })
    })
  }
  let loadToken = 0

  const recompute = (): void => {
    items = searchSymbols(all, input.value, LIMIT)
    selected = 0
    render()
  }

  const accept = (): void => {
    const sym = items[selected]
    if (!sym) return
    close()
    deps.jump(sym)
  }

  let scopeId = ""
  const close = (): void => {
    overlay.remove()
    popKeyScope(scopeId)
    document.removeEventListener("keydown", onDocKey, true)
    active = null
  }

  /** 焦点跑出输入框时（点了别处）仍要能 Esc 关：在 document 捕获阶段兜一层。 */
  const onDocKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  input.oninput = () => recompute()
  input.onkeydown = (e) => {
    if (e.isComposing) return // 中文候选态的 Enter/↑↓ 属于输入法
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {      e.preventDefault()
      selected = Math.min(selected + 1, items.length - 1)
      render()
      return
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault()
      selected = Math.max(selected - 1, 0)
      render()
      return
    }
    if (e.key === "PageDown") {
      e.preventDefault()
      selected = Math.min(selected + 10, Math.max(0, items.length - 1))
      render()
      return
    }
    if (e.key === "PageUp") {
      e.preventDefault()
      selected = Math.max(selected - 10, 0)
      render()
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      accept()
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  overlay.onclick = (e) => {
    if (e.target === overlay) close()
  }
  document.body.appendChild(overlay)
  scopeId = pushEscScope("wb.symbols", "关闭符号列表", close)
  document.addEventListener("keydown", onDocKey, true)
  active = { focus: () => input.focus() }
  input.focus()
  reload()
}
