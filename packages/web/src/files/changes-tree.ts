/**
 * 变更列表的**树形视图**数据（纯逻辑，无 DOM，可单测）。
 *
 * 为什么单独成模块：列表视图按「冲突 / 已暂存 / 未暂存 / 未跟踪」分组后再按路径平铺，路径的层级
 * 只体现为行首那截灰色目录名；目录一深（`packages/web/src/files/…`）就只剩半行文件名。树视图把
 * 同一批改动按目录收拢，渲染只负责缩进与展开箭头。把「怎么建树、怎么拍平」与「怎么画」分开，
 * 是因为前者错起来（顺序乱、计数错、折叠后还漏出子行）不会报错，只是看起来乱。
 */
import type { GitChange } from "./api"

/** 树里的文件节点：指向原始改动条目。 */
export interface TreeFile<T> {
  kind: "file"
  /** 末段名（渲染用） */
  name: string
  /** 根内相对路径（原样，别处用它做 stage/diff 的入参） */
  path: string
  item: T
}

/** 树里的目录节点：`fileCount` 是它下面**全部**文件数（折叠时也要能显示“这一层有几处改动”）。 */
export interface TreeDir<T> {
  kind: "dir"
  name: string
  path: string
  fileCount: number
  children: Array<TreeDir<T> | TreeFile<T>>
}

/** 拍平后的一行（渲染顺序即数组顺序）。目录行与文件行各自带 `depth`（0 起）。 */
export type TreeRow<T> =
  | { kind: "file"; name: string; path: string; depth: number; item: T }
  | { kind: "dir"; name: string; path: string; depth: number; fileCount: number }

/** 目录在前、文件在后，各自按名称的自然顺序（`a2` 在 `a10` 前——与资源管理器的排序口径一致）。 */
const byName = (a: { kind: "dir" | "file"; name: string }, b: { kind: "dir" | "file"; name: string }): number => {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
}

/**
 * 把一批改动按路径建成目录树，返回**虚拟根**（`path === ""`，渲染时跳过它本身）。
 *
 * 空路径（或只有 `/`）的条目会被丢弃：它们没有可展示的名字，硬塞进树里只会多出无名行。
 */
export function buildChangeTree<T extends Pick<GitChange, "path">>(items: T[]): TreeDir<T> {
  const root: TreeDir<T> = { kind: "dir", name: "", path: "", fileCount: 0, children: [] }
  for (const item of items) {
    const segs = item.path.split("/").filter(Boolean)
    if (!segs.length) continue
    let dir = root
    // 末段是文件名，其余每段进一层目录（同名目录复用，不重复建）
    for (let i = 0; i < segs.length - 1; i++) {
      const path = segs.slice(0, i + 1).join("/")
      let next = dir.children.find((c): c is TreeDir<T> => c.kind === "dir" && c.name === segs[i])
      if (!next) {
        next = { kind: "dir", name: segs[i]!, path, fileCount: 0, children: [] }
        dir.children.push(next)
      }
      dir = next
    }
    dir.children.push({ kind: "file", name: segs[segs.length - 1]!, path: item.path, item })
  }
  sortAndCount(root)
  return root
}

/** 递归排序并回填每层的 `fileCount`（自底向上，一次遍历）。 */
function sortAndCount<T>(dir: TreeDir<T>): number {
  let n = 0
  for (const child of dir.children) n += child.kind === "dir" ? sortAndCount(child) : 1
  dir.children.sort(byName)
  dir.fileCount = n
  return n
}

/**
 * 按当前折叠状态把树拍平成行序列（深度优先，父目录行在它的子行之前）。
 * `isCollapsed(path)` 返回 true 的目录：只出目录行，子行整段跳过。
 */
export function treeRows<T>(root: TreeDir<T>, isCollapsed: (path: string) => boolean = () => false): Array<TreeRow<T>> {
  const rows: Array<TreeRow<T>> = []
  const walk = (dir: TreeDir<T>, depth: number): void => {
    for (const child of dir.children) {
      if (child.kind === "dir") {
        rows.push({ kind: "dir", name: child.name, path: child.path, depth, fileCount: child.fileCount })
        if (!isCollapsed(child.path)) walk(child, depth + 1)
      } else {
        rows.push({ kind: "file", name: child.name, path: child.path, depth, item: child.item })
      }
    }
  }
  walk(root, 0)
  return rows
}

/**
 * 目录路径 → 它这一支下的**全部改动路径**（浅层到深层都算，不止直接子级）。
 *
 * 为什么单独成函数并单测：树视图的目录行上有「暂存该目录 / 取消暂存该目录」——一键作用到整棵子树。
 * 这个映射错了不会报错，只会**少动或多动文件**（多动尤其糟：把用户只想暂存的一个目录连隔壁一起提交了）。
 * 键是相对分组根的目录路径，与 `TreeDir.path` / `TreeRow.path` 同一口径（树行的 path 正是这里的前缀）。
 */
export function collectDirPaths<T extends { path: string }>(items: T[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const item of items) {
    const segs = item.path.split("/").filter(Boolean)
    // 末段是文件名：只为它的每一层祖先目录登记（不含文件自身所在的"目录"以外的路径）
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/")
      const arr = map.get(dir)
      if (arr) arr.push(item.path)
      else map.set(dir, [item.path])
    }
  }
  return map
}
