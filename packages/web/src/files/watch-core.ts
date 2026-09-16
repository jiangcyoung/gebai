/**
 * 工作台变更监听 · 纯逻辑（可单测）：目录清单归一、目录集指纹、失败退避。
 *
 * 为什么把这些从 `watch.ts` 里拿出来：它们错了都不会报错——目录漏归一（`/src` 与 `src` 被当成
 * 两个目录）只是让后端多挂一个用不上的 watcher；指纹不对则表现为「展开了新目录却半天不刷新」；
 * 退避不对是「断线后疯狂重连」。这些都能被单测钉住，而 DOM/网络那部分不能。
 */

/** 单次上报给后端的目录数上限（与服务端 MAX_WATCH_DIRS 同口径：目录树展开很多层时只报最近的）。 */
export const WATCH_DIR_CAP = 64

/**
 * 归一目录清单：去重复、去首尾斜杠、丢掉空串之外的非法项（绝对路径 / `..` 逃逸），并夹到上限。
 *
 * 保留空串是有意的：它代表**根本身**（根目录下的条目变化同样要刷新，而根目录不在 expanded 集合里）。
 */
export function normalizeWatchDirs(input: readonly string[], cap = WATCH_DIR_CAP): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const p = String(raw ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
    // 归一后仍含 `..` 段（`a/../b`）或看起来是盘符/协议的项：直接丢，避免把无效路径送到服务端
    if (p.split("/").some((seg) => seg === "..") || /^[a-zA-Z]:/.test(p) || p.includes("://")) continue
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
    if (out.length >= cap) break
  }
  return out
}

/**
 * 目录集指纹：变了就该重连长轮询（把新的监视目录带上）。
 * 用 `\n` 分隔（目录名里不含换行），顺序敏感——顺序来自调用方（最近展开优先），变化同样是一次重连。
 */
export function watchKey(dirs: readonly string[]): string {
  return dirs.join("\n")
}

/**
 * 目录清单 → 线上参数（逗号分隔）。
 *
 * 根目录内部用空串表示，而空串在逗号分隔里会被当成「没这一项」丢掉（`",src"` 的前导空段）——
 * 用 `.` 当根目录的线上记号（与 `git rev-parse` 一类工具的写法一致）。不这么做时**根目录永远不会被监听**，
 * 症状是「在根目录下新建的文件不会自动冒出来」，很难怀疑到这里（实测踩过）。
 */
export function wireDirs(dirs: readonly string[]): string {
  return dirs.map((d) => (d === "" ? "." : d)).join(",")
}

/** 目录集是否「实质变化」：只在指纹不同时重连，避免同一集合被反复重连（展开/收起同一个目录）。 */
export function watchKeyChanged(prev: string, next: string): boolean {
  return prev !== next
}

/**
 * 失败退避：2s 起，翻倍递增到 30s 上限（连续失败 5 次后稳定在 30s）。
 * 不指数爆炸也不贴身重试：服务端重启/网络抖动时几秒内自愈，长时间不可用时不刷请求。
 */
export function backoffMs(failures: number, opts: { base?: number; max?: number } = {}): number {
  const base = opts.base ?? 2_000
  const max = opts.max ?? 30_000
  if (failures <= 0) return 0
  return Math.min(max, base * 2 ** Math.min(failures - 1, 4))
}

/**
 * 变化路径 → 需要重取的目录集合。
 *
 * 一条变更既可能是「目录里多了一个条目」（变化路径 = 新条目），也可能是「文件内容变了」——
 * 两者对目录树的影响都落在它的**父目录**上；路径本身若是个目录（新建目录），它的子项缓存也已失效。
 * 因此每个变化路径贡献「父目录」与「自己」两项。
 */
export function dirsToRefresh(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of paths) {
    const p = String(raw ?? "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
    if (!p) continue
    out.add(p)
    const idx = p.lastIndexOf("/")
    out.add(idx > 0 ? p.slice(0, idx) : "")
  }
  return [...out]
}
