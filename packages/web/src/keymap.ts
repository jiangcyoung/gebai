/**
 * 键盘快捷键的**唯一声明源**与分发器：键位规范化、匹配、焦点守卫、浮层层级、冲突校验、帮助数据。
 *
 * 为什么集中：此前每个模块各自 `addEventListener("keydown")`（主界面 25 处、工作台 24 处），
 * 谁也说不清同一个手势被谁抢走——终端里按 Ctrl+W 顺手关掉标签、一次 Esc 同时关掉一排浮层、
 * Alt+↓ 的含义随差异标签里的文件数变化，都是「分散登记」的必然结果。一张表 + 一个分发器之后：
 * 键位只有一处可写、重复与浏览器冲突在测试里直接报错（`validateKeymap`）、帮助 UI 与文档由它生成。
 *
 * 键位族的硬约束：歌白只用**浏览器与系统都没有默认绑定**的组合（主族 `Ctrl+Alt+*`）。
 * `browserRisk` 是这条约束的可执行形式——`Ctrl+N/W/S/P/K/E`、`Ctrl+Shift+*`、`F5/F7/F11/F12`、
 * 裸 `Alt+字母/方向` 一律判为保留键，测试断言全表为零命中。
 */
/* ------------------------------ 键位与焦点 ------------------------------ */

/** 键盘事件的最小形状（与 KeyboardEvent 结构兼容，便于用例直接构造字面量）。 */
export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
  target?: unknown
  preventDefault(): void
  stopPropagation(): void
}

/** 按键发生时的焦点环境：守卫按它决定「这个键该不该归歌白管」。 */
export type FocusKind = "other" | "input" | "editor" | "terminal"

/** 终端面板内的元素（含 xterm 画布与降级终端的输入行）：全局键在这里一律让位给 shell。 */
const TERMINAL_SELECTOR = ".xterm, .fw-term-panel, .fw-term-host, .fw-term-body"
/** 编辑器内（Monaco 与降级编辑器）：Monaco 自己也吃按键，需要它的场景用捕获阶段显式声明。 */
const EDITOR_SELECTOR = ".monaco-editor, .fw-fallback"

/**
 * 判定焦点环境。顺序要紧：Monaco 与 xterm 内部都是隐藏 textarea——
 * 先按容器归属认出「编辑器 / 终端」，剩下的才是普通输入框（聊天框、搜索框、提交框）。
 */
export function focusKind(target: unknown): FocusKind {
  const el = target as (HTMLElement & { tagName?: string; isContentEditable?: boolean }) | null
  if (!el || typeof el !== "object") return "other"
  const inSel = (sel: string): boolean => (typeof el.closest === "function" ? !!el.closest(sel) : false)
  if (inSel(TERMINAL_SELECTOR)) return "terminal"
  if (inSel(EDITOR_SELECTOR)) return "editor"
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return "input"
  return "other"
}

/** 键名归一：同一物理键的多种写法（ArrowDown / down / ↓）收敛成一个规范名。 */
const KEY_ALIASES: Record<string, string> = {
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  // Shift+= 出的是 "+"，与 "=" 同一物理键（终端字号这类场景两种按法都要认）
  "+": "=",
}

export function normalizeKeyName(raw: string): string {
  if (!raw) return ""
  const alias = KEY_ALIASES[raw.toLowerCase()]
  if (alias) return alias
  if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase()
  return raw.length === 1 ? raw.toUpperCase() : raw
}

/** 解析后的键位：修饰键是否精确匹配 + 规范键名。 */
export interface ParsedKey {
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

/**
 * 解析键位写法（"Ctrl+Alt+S"、"Ctrl+Alt+↓"、"F2"、"Y"、"Esc"）。
 * `Ctrl`/`Cmd`/`Meta` 视作同一个修饰键（Mac 上按 Cmd 也命中）；写法不合法返回 null（由校验报出）。
 */
export function parseSpec(spec: string): ParsedKey | null {
  let s = spec.trim()
  let trailingPlus = false
  if (s.length > 1 && s.endsWith("+")) {
    trailingPlus = true
    s = s.slice(0, -1)
  }
  const mods = { ctrl: false, alt: false, shift: false }
  let key = ""
  for (const raw of s.split("+")) {
    const p = raw.trim()
    if (!p) continue
    const low = p.toLowerCase()
    if (low === "ctrl" || low === "control" || low === "cmd" || low === "meta" || low === "mod") mods.ctrl = true
    else if (low === "alt" || low === "option") mods.alt = true
    else if (low === "shift") mods.shift = true
    else key = p
  }
  if (trailingPlus) key = "+"
  if (!key) return null
  return { ...mods, key: normalizeKeyName(key) }
}

/** 规范显示写法（修饰键固定顺序 Ctrl+Alt+Shift+键）：帮助 UI、文档、提示文案共用。 */
export function formatSpec(spec: string): string {
  const p = parseSpec(spec)
  if (!p) return spec
  const parts: string[] = []
  if (p.ctrl) parts.push("Ctrl")
  if (p.alt) parts.push("Alt")
  if (p.shift) parts.push("Shift")
  parts.push(p.key)
  return parts.join("+")
}

/** 事件是否命中键位：修饰键**精确相等**（Ctrl+Alt+S 不会被 Ctrl+Alt+Shift+S 触发）。 */
export function matchKey(e: KeyEventLike, parsed: ParsedKey): boolean {
  // 缺失的修饰键字段按 false 处理（程序化构造的事件常不带它们）
  const ctrl = !!(e.ctrlKey || e.metaKey)
  if (ctrl !== parsed.ctrl || !!e.altKey !== parsed.alt || !!e.shiftKey !== parsed.shift) return false
  return normalizeKeyName(e.key ?? "") === parsed.key
}

/* ------------------------------ 分组与绑定声明 ------------------------------ */

/** 帮助 UI 与文档的分组（顺序即展示顺序）。 */
export type KeyGroupId =
  | "main.session"
  | "main.composer"
  | "main.approval"
  | "main.nav"
  | "main.overlay"
  | "wb.file"
  | "wb.view"
  | "wb.diff"
  | "wb.term"
  | "wb.ui"

export const KEY_GROUPS: Record<KeyGroupId, string> = {
  "main.session": "主界面 · 会话与布局",
  "main.composer": "主界面 · 输入框",
  "main.approval": "主界面 · 审批",
  "main.nav": "主界面 · 消息导航",
  "main.overlay": "主界面 · 弹窗与浮层",
  "wb.file": "工作台 · 文件",
  "wb.view": "工作台 · 视图与面板",
  "wb.diff": "工作台 · 差异与合并",
  "wb.term": "工作台 · 终端",
  "wb.ui": "工作台 · 弹窗与菜单",
}

export interface KeyBinding {
  /** 唯一 id（形如 `workbench.save`），冲突校验与帮助文案定位都用它。 */
  id: string
  /** 键位写法（可多个，如终端字号同时认 `=` 与 `+`）。 */
  keys: string | string[]
  /** 帮助 UI / 文档里的动作说明。 */
  label: string
  group: KeyGroupId
  run: (e: KeyEventLike) => void
  /**
   * 允许生效的焦点环境（默认 `["other","editor"]`——输入框与终端内不接管）。
   * 输入框内也要生效的显式加 `"input"`；主界面的默认焦点就是聊天输入框，
   * 所以那里的带修饰键绑定一律用 `FOCUS_WITH_INPUT`（测试断言这条约束，见 keymap.test.ts）。
   */
  focus?: FocusKind[]
  /** 命中后的附加条件（如「活动标签是差异视图」）；不满足则继续让给下一个绑定。 */
  when?: (e: KeyEventLike) => boolean
  /** 监听阶段：默认冒泡；需要抢在 Monaco / xterm 之前接管的用 `"capture"`。 */
  phase?: "capture" | "bubble"
  /** 命中后是否阻止默认行为与继续传播（默认 true）。 */
  intercept?: boolean
  /** 是否允许长按重复触发（默认 false：按住不放不该连发动作）。 */
  allowRepeat?: boolean
  /** 帮助 UI 里的补充说明（例如「工作台内接管 Monaco 的光标组合」）。 */
  note?: string
  /**
   * false = 该键由模块自行管理元素级监听，只登记进表（帮助 / 文档 / 冲突校验用），
   * 不参与分发。元素级监听必须先于全局判定（列表行 Enter、输入框内 Enter 等）。
   */
  owned?: boolean
}

/**
 * 默认焦点：普通页面区域与编辑器内生效，输入框与终端内不接管。
 *
 * 主界面是例外——那里的默认焦点就是聊天输入框（进草稿页/切会话/回答结束都会 `focusInput()`），
 * 所以会话语的全局键显式带上 `"input"`（见 `FOCUS_WITH_INPUT`）；工作台则相反：
 * 默认焦点在编辑器（本就含在默认集里），输入框是临时落点，除保存/刷新/提交等显式例外不接管。
 */
export const DEFAULT_FOCUS: FocusKind[] = ["other", "editor"]

/** 主界面会话区的全局键用这组：聊天输入框是默认焦点，快捷键必须在那里也能用。 */
export const FOCUS_WITH_INPUT: FocusKind[] = ["other", "editor", "input"]

/** 单键与列表两种写法归一成数组。 */
export function toSpecList(keys: string | string[]): string[] {
  return Array.isArray(keys) ? keys : [keys]
}

/* ------------------------------ 浏览器安全 ------------------------------ */

export interface BrowserRisk {
  /** true = 浏览器/系统占用了这个组合，歌白不得使用。 */
  reserved: boolean
  reason?: string
}

/** 无修饰键里浏览器不占用的那些。 */
const SAFE_BARE_KEYS = new Set(["Esc", "Enter", "Tab", "Space", "↑", "↓", "←", "→", "Home", "End", "PageUp", "PageDown", "F2", "F8", "F9", "Backspace", "Delete"])
/**
 * 允许单独与 Ctrl 搭配的键：浏览器要么没有绑定（Enter），要么把按键交给页面处理（C 是编辑键，
 * 页面可以接管——终端的中断语义就建在它上面；Ctrl+N/W/T 那类才是浏览器自己带走的）。
 */
const SAFE_CTRL_KEYS = new Set(["Enter", "C"])

/**
 * 该组合是否被浏览器或系统保留。歌白的硬约束是「表内零保留」——测试遍历全表断言。
 *
 * 判定依据：`Ctrl+Alt+*` 在 Chromium / Edge / Firefox / Windows / macOS 上都无默认绑定
 * （系统级仅 Ctrl+Alt+Del，不涉及）；`Ctrl+*`、`Ctrl+Shift+*`、裸 `Alt+*`、F 键区与
 * `Ctrl+=/−/0` 则大量被占用（新窗口 / 关标签 / 打印 / 保存 / 查找 / 缩放 / 刷新 / 前进后退）。
 */
export function browserRisk(spec: string): BrowserRisk {
  const p = parseSpec(spec)
  if (!p) return { reserved: true, reason: "键位写法无法解析" }
  if (p.ctrl && p.alt) return { reserved: false }
  if (p.ctrl) {
    if (!p.shift && SAFE_CTRL_KEYS.has(p.key)) return { reserved: false }
    if (p.shift && p.key === "F") return { reserved: false }
    return { reserved: true, reason: "Ctrl 单修饰是浏览器保留键（新窗口/关标签/打印/保存/查找/缩放/刷新等）" }
  }
  if (p.alt) {
    if (p.key === "Z") return { reserved: false }
    return { reserved: true, reason: "裸 Alt+字母/方向在浏览器（前进后退）与系统菜单里有默认行为" }
  }
  if (SAFE_BARE_KEYS.has(p.key)) return { reserved: false }
  if (/^F\d{1,2}$/.test(p.key)) return { reserved: true, reason: "F1/F3/F5/F6/F7/F10/F11/F12 在浏览器有默认行为" }
  return { reserved: false }
}

/* ------------------------------ 分发器 ------------------------------ */

/**
 * 浮层作用域：弹窗 / 菜单 / 查看器在打开时入栈，关闭时出栈。
 * 栈顶作用域的绑定优先命中——这就是「一次 Esc 只关最上层」的实现方式
 * （此前 11 个文档级 Esc 监听互不相让，按一次会连续关掉一排浮层）。
 */
export interface KeyScope {
  id: string
  bindings: KeyBinding[]
}

/** 可挂监听的宿主（document 或测试替身）。 */
export interface KeyTarget {
  addEventListener(type: string, listener: (e: KeyEventLike) => void, capture?: boolean): void
  removeEventListener(type: string, listener: (e: KeyEventLike) => void, capture?: boolean): void
}

export interface Keymap {
  /** 当前表内全部绑定（含安装后新增的），供帮助 UI 与校验读取。 */
  bindings(): readonly KeyBinding[]
  /** 安装后追加绑定（模块在初始化函数里注册各自键位；重复登记由 `validateKeymap` 在测试里拦住）。 */
  add(binding: KeyBinding): void
  addAll(bindings: readonly KeyBinding[]): void
  install(target?: KeyTarget): void
  uninstall(): void
  pushScope(scope: KeyScope): void
  popScope(id: string): void
  hasScope(id: string): boolean
}

interface Prepared {
  binding: KeyBinding
  keys: ParsedKey[]
}

function prepare(bindings: KeyBinding[]): Prepared[] {
  return bindings.map((binding) => ({
    binding,
    keys: toSpecList(binding.keys)
      .map((s) => parseSpec(s))
      .filter((k): k is ParsedKey => !!k),
  }))
}

/**
 * 建键位表：`install()` 后接管 document 的 keydown（捕获 + 冒泡各一个监听）。
 * 命中判定顺序 = 作用域栈顶优先 → 表内声明顺序；命中即拦截（`intercept: false` 除外）。
 */
export function createKeymap(bindings: KeyBinding[]): Keymap {
  const base: Prepared[] = prepare(bindings)
  const scopes: Array<{ id: string; prepared: Prepared[] }> = []
  const installed: Array<{ target: KeyTarget; fn: (e: KeyEventLike) => void; capture: boolean }> = []

  function handle(e: KeyEventLike, phase: "capture" | "bubble"): void {
    // 输入法组合态一律不接管：Enter/Esc 属于候选确认
    if (e.defaultPrevented || e.isComposing) return
    const queue = [...scopes].reverse().flatMap((s) => s.prepared).concat(base)
    for (const { binding, keys } of queue) {
      if (binding.owned === false) continue
      if ((binding.phase ?? "bubble") !== phase) continue
      if (e.repeat && binding.allowRepeat !== true) continue
      if (!keys.some((k) => matchKey(e, k))) continue
      if (!(binding.focus ?? DEFAULT_FOCUS).includes(focusKind(e.target))) continue
      if (binding.when && !binding.when(e)) continue
      if (binding.intercept !== false) {
        e.preventDefault()
        e.stopPropagation()
      }
      binding.run(e)
      return
    }
  }

  return {
    bindings: () => base.map((p) => p.binding),
    add(b) {
      base.push(...prepare([b]))
    },
    addAll(list) {
      base.push(...prepare([...list]))
    },
    install(target: KeyTarget = document as unknown as KeyTarget) {
      const capture = (e: KeyEventLike) => handle(e, "capture")
      const bubble = (e: KeyEventLike) => handle(e, "bubble")
      target.addEventListener("keydown", capture, true)
      target.addEventListener("keydown", bubble, false)
      installed.push({ target, fn: capture, capture: true }, { target, fn: bubble, capture: false })
    },
    uninstall() {
      for (const it of installed) it.target.removeEventListener("keydown", it.fn, it.capture)
      installed.length = 0
    },
    pushScope(scope) {
      scopes.push({ id: scope.id, prepared: prepare(scope.bindings) })
    },
    popScope(id) {
      const i = scopes.findIndex((s) => s.id === id)
      if (i >= 0) scopes.splice(i, 1)
    },
    hasScope(id) {
      return scopes.some((s) => s.id === id)
    },
  }
}

/* ------------------------------ 帮助与校验 ------------------------------ */

export interface HelpRow {
  id: string
  keys: string[]
  label: string
  note?: string
}

export interface HelpGroup {
  id: KeyGroupId
  title: string
  rows: HelpRow[]
}

/** 帮助 UI 与文档的唯一数据源：按分组输出（空组不出现）。 */
export function helpGroups(bindings: readonly KeyBinding[]): HelpGroup[] {
  const groups: HelpGroup[] = (Object.keys(KEY_GROUPS) as KeyGroupId[]).map((id) => ({ id, title: KEY_GROUPS[id], rows: [] }))
  const byId = new Map(groups.map((g) => [g.id, g]))
  for (const b of bindings) {
    const g = byId.get(b.group)
    if (!g) continue
    g.rows.push({ id: b.id, keys: toSpecList(b.keys).map(formatSpec), label: b.label, note: b.note })
  }
  return groups.filter((g) => g.rows.length > 0)
}

export type KeymapIssueKind = "duplicate" | "browser-reserved" | "invalid"

export interface KeymapIssue {
  kind: KeymapIssueKind
  id: string
  detail: string
}

function focusOverlap(a: KeyBinding, b: KeyBinding): boolean {
  const fa = a.focus ?? DEFAULT_FOCUS
  const fb = b.focus ?? DEFAULT_FOCUS
  return fa.some((f) => fb.includes(f))
}

/**
 * 校验一张键位表（测试断言返回空数组）：
 * ① 写法可解析 ② 不含浏览器保留组合 ③ 同阶段 + 同键位 + 焦点重叠的重复登记。
 * 作用域表（`KeyScope`）可单独校验——作用域内与基表同键是合法的（栈顶优先就是它的语义）。
 */
export function validateKeymap(bindings: readonly KeyBinding[], where = "base"): KeymapIssue[] {
  const issues: KeymapIssue[] = []
  const seen = new Map<string, KeyBinding>()
  for (const b of bindings) {
    const specs = toSpecList(b.keys)
    if (specs.length === 0) issues.push({ kind: "invalid", id: b.id, detail: "未声明键位" })
    for (const spec of specs) {
      const parsed = parseSpec(spec)
      if (!parsed) {
        issues.push({ kind: "invalid", id: b.id, detail: `键位写法无法解析：${spec}` })
        continue
      }
      const risk = browserRisk(spec)
      if (risk.reserved) issues.push({ kind: "browser-reserved", id: b.id, detail: `${formatSpec(spec)}：${risk.reason}` })
      // 元素级登记不参与重复检测：它们各自作用在具体控件上（列表行、输入框），天然互斥
      if (b.owned === false) continue
      const slot = `${b.phase ?? "bubble"}|${formatSpec(spec)}`
      const prev = seen.get(slot)
      if (prev && focusOverlap(prev, b)) {
        issues.push({ kind: "duplicate", id: b.id, detail: `${formatSpec(spec)} 与 ${prev.id} 重复（${where}）` })
      } else if (!prev) {
        seen.set(slot, b)
      }
    }
  }
  return issues
}

/* ------------------------------ 活跃键位表 ------------------------------ */

/**
 * 当前文档的活跃键位表（主界面与文件工作台各一份；分屏时工作台在 iframe 内，属于另一个文档、
 * 另一份表）。浮层模块（对话框、菜单、下拉、查看器）经 `pushKeyScope` 入栈自己的 Esc 绑定，
 * 不再各自往 document 上挂 keydown——这正是「一次 Esc 只关最上层」的来源。
 */
let activeMap: Keymap | null = null

export function setActiveKeymap(map: Keymap | null): void {
  activeMap = map
}

export function activeKeymap(): Keymap | null {
  return activeMap
}

/** 浮层打开：把该层绑定推到栈顶；无活跃表（测试环境/未安装）时静默忽略。 */
export function pushKeyScope(scope: KeyScope): void {
  activeMap?.pushScope(scope)
}

export function popKeyScope(id: string): void {
  activeMap?.popScope(id)
}

/** 浮层作用域 id 生成（同名浮层可能同时存在两层，如确认框里再开确认框）。 */
let scopeSeq = 0
export function nextScopeId(prefix: string): string {
  scopeSeq += 1
  return `${prefix}#${scopeSeq}`
}

/**
 * 推入一个「Esc 关闭」作用域并返回其 id——绝大多数浮层（弹窗、查看器、菜单、下拉）的全部键位
 * 需求就是这一条。关闭时用返回的 id 调 `popKeyScope`。
 */
export function pushEscScope(prefix: string, label: string, run: () => void, group: KeyGroupId = "main.overlay"): string {
  const id = nextScopeId(prefix)
  // Esc 要能在浮层自己的输入框里生效（promptDialog 打开即聚焦输入框），但终端内不抢——
  // 那里的 Esc 属于 shell（vim 等）
  pushKeyScope({ id, bindings: [{ id: `${prefix}.esc`, keys: "Esc", label, group, focus: ["other", "editor", "input"], run }] })
  return id
}
