/**
 * 文件工作台（`/files` 独立页与主界面分屏 iframe）的键位表。
 *
 * 与主界面同构：键位族与守卫规则在 `keymap.ts`，动作绑定由 `files/main.ts` 注入
 * （标签、编辑器、面板都在那边的闭包里），本文件负责建表、安装与元素级键位的登记。
 *
 * 三条与主界面不同的守卫约定：
 * ① **终端面板内的按键归终端**——焦点落在 `.xterm` / 终端面板内时，工作台全局键一律不接管
 *   （shell 的 readline 键 `Ctrl+W` 删词 / `Ctrl+P` 上一条 / `Ctrl+E` 行尾 / `Ctrl+K` 删至行尾 / `Ctrl+B` 光标左移
 *   全部回归终端；歌白的同名键只在其它焦点环境生效）；
 * ② **输入框内按用途分档**：接管浏览器默认的全局键（`Ctrl+S/P/W/B`、`F5`…）在输入框里也生效——
 *   否则在提交信息框里按 Ctrl+S 弹出的是浏览器的「保存网页」；只有编辑器查找类（`Ctrl+F`）让位；
 * ③ 需要抢在 Monaco / xterm 之前的绑定显式声明 `phase: "capture"`。
 */
import { createKeymap, setActiveKeymap, type KeyBinding, type KeyTarget } from "../keymap"

/**
 * 元素级键位登记（`owned: false`，不参与分发）：这些按键由各自控件直接监听，语义与具体
 * 元素绑定（列表行的 Enter、输入框内的 Enter、分界条的箭头）。登记在此供帮助 UI 与文档使用，
 * 每条 note 给出实现位置。终端内的按键不在此列——见 `terminal-pty.ts` / `terminal-legacy.ts`。
 */
const elementBindings: KeyBinding[] = [
  {
    id: "wb.searchView.enter",
    keys: "Enter",
    label: "搜索视图：按当前关键词/文件名模式搜索",
    group: "wb.ui",
    note: "搜索视图的输入框内（files/main.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.git.logSearchEnter",
    keys: "Enter",
    label: "Git 日志：按输入内容筛选",
    group: "wb.ui",
    note: "日志搜索框内（files/git.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.compare.pathEnter",
    keys: "Enter",
    label: "比较视图：应用路径过滤",
    group: "wb.ui",
    note: "比较页路径输入框内（files/compare.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.list.open",
    keys: ["Enter", "Space"],
    label: "列表项：打开（提交 / 分支 / 标签 / 变更文件）",
    group: "wb.ui",
    note: "Git 面板各列表行获焦后（files/git.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.splitter.resize",
    keys: ["←", "→"],
    label: "Git 分栏分界条：调整列宽（Shift 加速）",
    group: "wb.ui",
    note: "分界条获焦后（files/git.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.refPop.navigate",
    keys: ["↑", "↓"],
    label: "分支/标签选择浮层：上下移动高亮",
    group: "wb.ui",
    note: "浮层搜索框内（files/git.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.term.searchBox",
    keys: "Enter",
    label: "终端搜索：下一个匹配（Shift+Enter 上一个）",
    group: "wb.term",
    note: "终端搜索框内（files/terminal-pty.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.legacyTerm.input",
    keys: "Enter",
    label: "降级终端：执行命令",
    group: "wb.term",
    note: "降级终端输入框内（files/terminal-legacy.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.legacyTerm.history",
    keys: ["↑", "↓"],
    label: "降级终端：命令历史",
    group: "wb.term",
    note: "降级终端输入框内（files/terminal-legacy.ts）",
    owned: false,
    run: () => {},
  },
  {
    id: "wb.monaco.native",
    keys: "Ctrl+F",
    label: "编辑器内查找（Monaco 内置）",
    group: "wb.file",
    note: "Monaco 自带的编辑快捷键（Ctrl+F 查找、Ctrl+H/D/Z/Y 等）在编辑器内保持原样——工作台的 Ctrl+F（目录过滤）只声明 other，不进编辑器",
    owned: false,
    run: () => {},
  },
]

export const workbenchKeymap = createKeymap([...elementBindings])

/** 安装：注入动作绑定、接管 document keydown、登记为活跃表（浮层作用域从此可用）。 */
export function installWorkbenchKeys(bindings: KeyBinding[], target?: KeyTarget): void {
  workbenchKeymap.addAll(bindings)
  setActiveKeymap(workbenchKeymap)
  workbenchKeymap.install(target)
}
