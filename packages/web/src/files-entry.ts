/**
 * 文件工作台入口的**跳转（新标签）**一侧：URL 拼装、在新标签/当前标签打开、副按钮绑定。
 *
 * 分工：标题栏入口的**主按钮 = 分屏打开**（见 files-split.ts，那是这个仓位最常用的动作）；
 * 悬浮时从右侧弹出的**副按钮 = 新标签打开**（整个工作台页面，与聊天并行浏览时用）。
 * 本模块只负责后者与 URL 拼装（分屏也要用它拼 iframe 的 src）。
 *
 * 为什么新标签而不是同页路由：文件工作台是重量级 IDE 式工作区（Monaco + Git 面板 + 大量
 * 资源请求），独立页面带来故障隔离——编辑器崩了不影响会话，反之亦然。
 *
 * 传参：
 *   · `session`  = 会话 id（令 `sess:` 根指向该会话工作区，Agent 产物就地可查）；
 *                 缺省取当前会话（历史消息里的产物链接需显式传它所属会话）；
 *   · `root`     = 根 id（`proj:gebai` / `abs:/path` …），显式指定则直接打开该根；
 *   · `project`  = 预置项目名（等价于 `root=proj:<name>`）；
 *   · `path`     = 直达文件（会话相对或绝对路径均可，工作台自行定位所属根）；
 *   · `line`     = 直达行号（1 起始，与 `path` 同用）；
 *   · `from`/`to`= 直接开比较视图的两端；
 *   · 主题**不进 URL**：工作台与主界面共享同一份用户级偏好（localStorage `gebai.ui.style`，
 *     theme-core 的 initTheme 会以 urlPrefs:false 忽略 URL 上的主题参数），
 *     否则一个旧链接就能把两页拆成两套配色。
 */
import { getCurrentSession } from "./state"
import type { KeyBinding } from "./keymap"
import { FOCUS_WITH_INPUT } from "./keymap"
import { appPath } from "@gebai/sdk"

/** 打开工作台的参数（各字段可选，缺省按当前会话/主题补齐）。 */
export interface FilesOpenOpts {
  path?: string
  root?: string
  project?: string
  from?: string
  to?: string
  /** 1 起始行号（与 path 同用，打开后跳到该行）。 */
  line?: number
  /** 显式会话 id（历史消息的产物链接须传它渲染时的会话，否则落到当前会话的工作区）。 */
  session?: string
}

/** 文件工作台 URL（保留会话上下文；主题不走 URL）。 */
export function filesUrl(opts: FilesOpenOpts = {}): string {
  const params = new URLSearchParams()
  const session = opts.session ?? getCurrentSession()?.id
  if (session) params.set("session", session)
  if (opts.root) params.set("root", opts.root)
  if (opts.project) params.set("project", opts.project)
  if (opts.path) params.set("path", opts.path)
  if (opts.line && opts.line > 0) params.set("line", String(opts.line))
  if (opts.from) params.set("from", opts.from)
  if (opts.to) params.set("to", opts.to)
  const qs = params.toString()
  return `${appPath("/files")}${qs ? `?${qs}` : ""}`
}

/** 在当前标签（或新标签）打开文件工作台。 */
export function openFiles(opts: FilesOpenOpts = {}, newTab = true): void {
  const url = filesUrl(opts)
  if (newTab) window.open(url, "_blank", "noopener")
  else location.href = url
}

/**
 * 入口的副按钮 = **新标签打开**（分屏在主按钮上，见 files-split.ts）。
 * 两者分工：主按钮是常驻可见的那一个，承担最常用的动作（分屏对照）；
 * 副按钮只在浮空时从右侧弹出，承担"这次要看整页"的少数情况。
 */
export function bindFilesEntry(): void {
  const btn = document.getElementById("files-tab-btn") as HTMLButtonElement | null
  if (!btn) return
  btn.addEventListener("click", () => openFiles())
}

/**
 * 主界面快捷键：Ctrl+Alt+E 开关文件分屏（VSCode 的「显示/隐藏侧边编辑器」同款语义）——
 * 连按两次回到无分屏，而不是攒出两个新标签页。
 * 用 Ctrl+Alt 族是硬约束：Ctrl+Shift+E 在 Firefox 是网络监视器、Ctrl+N/W/P 等更是拦不住的浏览器保留键。
 *
 * `focus` 含 `input`：主界面的默认焦点就在聊天输入框（进草稿页/切会话/回答结束都会 `focusInput()`），
 * 不含它这条快捷键就基本没机会命中（而 Ctrl+Alt+字母 在输入框里没有输入语义，
 * 中文候选态另由分发器的 `isComposing` 守卫兜住）。
 */
export const splitBindings: KeyBinding[] = [
  {
    id: "main.split.toggle",
    keys: "Ctrl+Alt+E",
    label: "开关文件分屏",
    group: "main.session",
    focus: FOCUS_WITH_INPUT,
    run: () => void import("./files-split").then((m) => m.toggleSplit({ path: undefined })),
  },
]
