/**
 * 「最近打开的文件」：快速打开（Ctrl+P）空查询时显示的内容，也是模糊排序的加权依据。
 *
 * 存 localStorage 而不是 sessionStorage：跨标签页/跨刷新都该记得（用户找的往往是刚看过的那个文件），
 * 与「工作台会话状态」（`session-state.ts`，本标签页的标签与视图）是两回事。按根隔离——
 * 同一个相对路径在不同根下是不同的文件。
 */
const KEY = "gebai.ui.recentFiles"
const MAX = 40

interface Entry {
  root: string
  path: string
  at: number
}

function load(): Entry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Entry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e) => e && typeof e.root === "string" && typeof e.path === "string")
  } catch {
    return []
  }
}

function save(list: Entry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* 存储不可用（隐私模式/配额满）时静默忽略：只是少个便利入口，不影响功能 */
  }
}

/** 记一次打开（同文件去重后置顶，超出上限截断）。 */
export function recordRecentFile(root: string, path: string): void {
  if (!root || !path) return
  const rest = load().filter((e) => !(e.root === root && e.path === path))
  save([{ root, path, at: Date.now() }, ...rest].slice(0, MAX))
}

/** 某根下最近打开的文件（最近的在前）。 */
export function recentFiles(root: string, limit = MAX): string[] {
  return load()
    .filter((e) => e.root === root)
    .slice(0, limit)
    .map((e) => e.path)
}
