/** 目录递归遍历（SDK 侧实现，供 projectAware 的 listFiles 使用）：grep 范围外路径与 code/explore 项目根遍历共用。 */
import type { FileEntry } from "./types"

/** 目录递归遍历时跳过的大型/生成目录（grep 范围外路径与 code/explore 项目根遍历共用，防全量扫描拖慢）。 */
export const WALK_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv", "target", ".idea", ".vscode", "coverage", ".turbo"])
export const WALK_MAX_DEPTH = 10

/** 并发 stat 上限（每个文件一次系统调用；无上限会在超大目录耗尽 fd）。 */
export const WALK_STAT_CONCURRENCY = 32

/** 目录递归遍历（跳过大型/生成目录、深度上限；root 为单文件时直接返回单条）。pathBase 传入时输出路径带该前缀
 *  （tmp/项目根外搜索的结果路径可直接用于 read 等文件工具），缺省相对 root；root 不存在/不可读返回空。
 *  遍历顺序保持与递归 readdir 一致（DFS、目录内按 readdir 序），然后**并发 stat** —— 逐文件串行 stat 是大目录
 *  列表的主要耗时，并发后数十毫秒级；结果按下标回填，命中顺序不变。
 *  **size 与 mtime 必须一并取出**：FileEntry.modifiedAt 恒为 0 会让「按修改时间排序/显示」类工具
 *  静默给出无效排序与 1970 年时间（工具自己无从判断这是"未提供"还是"真的很旧"）。 */
export async function walkDirFiles(root: string, pathBase = ""): Promise<FileEntry[]> {
  const { readdir, stat } = await import("node:fs/promises")
  const st = await stat(root).catch(() => null)
  if (!st) return []
  if (st.isFile()) return [{ path: pathBase || root.replace(/\\/g, "/"), size: st.size, modifiedAt: st.mtimeMs, isDir: false }]
  const found: Array<{ abs: string; rel: string }> = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (WALK_SKIP_DIRS.has(e.name)) continue
        await walk(`${dir}/${e.name}`, rel ? `${rel}/${e.name}` : e.name, depth + 1)
      } else if (e.isFile()) {
        found.push({ abs: `${dir}/${e.name}`, rel: rel ? `${rel}/${e.name}` : e.name })
      }
    }
  }
  await walk(root, "", 0)
  const out: FileEntry[] = found.map((f) => ({ path: pathBase ? `${pathBase}/${f.rel}` : f.rel, size: 0, modifiedAt: 0, isDir: false }))
  let cursor = 0
  const statOne = async (): Promise<void> => {
    for (;;) {
      const i = cursor++
      if (i >= found.length) return
      try {
        const s = await stat(found[i].abs)
        out[i].size = s.size
        out[i].modifiedAt = s.mtimeMs
      } catch {
        /* stat 失败按 0 处理 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WALK_STAT_CONCURRENCY, found.length) }, statOne))
  return out
}
