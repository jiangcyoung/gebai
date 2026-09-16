/**
 * 文件工作台 · **仓库相对路径 ↔ 根相对路径**的换算（纯函数，可单测）。
 *
 * 为什么单独成模块：工作台里同时存在两套路径坐标，而它们只差一个前缀，错起来**都不报错**：
 * - **Git 侧**（status/diff/log/paths、提交里的文件清单）说**仓库相对**路径（`packages/web/src/a.ts`）；
 * - **文件侧**（fs 端点、编辑器标签、资源管理器）说**根相对**路径（`src/a.ts`，根是 `proj:…`，
 *   可能指向仓库的某个子目录）。
 *
 * 二者在「根 == 仓库根」时恰好重合，子目录根（会话工作区常是项目仓库的子目录）时才分岔：
 * 少了前缀 → 找不到文件（把 `sub/a.txt` 当根内路径用，实际去找 `<根>/sub/a.txt`）；
 * 多了前缀 → 同样找不到（把 `a.txt` 当仓库路径用）。而变更面板还要显示**根之外**的改动
 * （打开「整仓库」范围时）——那条路径在根内根本无法表达，必须换一个覆盖它的根来打开。
 *
 * 所以这里只放「算」的部分（前缀、归属、换算），DOM/请求在调用方；每条规则都有单测。
 */

/** 根清单条目的最小字段面（服务端 `/api/v1/roots` 的子集）。 */
export interface PathRoot {
  id: string
  kind: string
  path: string
}

/** 路径比较用归一：反斜杠转正斜杠、去掉尾部斜杠；Windows 下大小写不敏感。 */
export function normPath(p: string, isWin = false): string {
  const s = String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
  return isWin ? s.toLowerCase() : s
}

/** 仓库相对路径 → 绝对路径（`repoRootAbs` 为空或路径本身是绝对路径时原样返回）。 */
export function absOfRepo(repoRootAbs: string, repoRel: string, isWin = false): string {
  const rel = String(repoRel ?? "").replace(/^\/+/, "")
  if (!repoRootAbs) return normPath(rel, isWin)
  const base = normPath(repoRootAbs, false)
  return rel ? `${base}/${rel}` : base
}

/**
 * `abs` 在 `absDir` 之内时的相对路径；不在其内返回 null（含 `absDir === abs` → `""`）。
 * 三个参数都应是绝对路径；**比较**用 {@link normPath}（Windows 下不敏感），
 * 但**返回值取自原串**（只按长度截取）——归一化会小写整条路径，拿它当相对路径会把文件名的大小写改掉
 * （磁盘上通常无碍，但标签标题/路径回显会变成另一个名字，且把"我传给你什么"变成了"我以为你叫什么"）。
 */
export function relWithin(absDir: string, abs: string, isWin = false): string | null {
  const dir = normPath(absDir, isWin)
  const target = normPath(abs, isWin)
  if (!dir || !target) return null
  if (target === dir) return ""
  if (!target.startsWith(`${dir}/`)) return null
  // 反斜杠→斜杠是 1:1 替换、尾斜杠只在末尾被去掉，故归一后的长度可用于原串下标
  return String(abs ?? "").slice(dir.length + 1)
}

/**
 * 当前根在仓库内的前缀（仓库相对形式）。
 *
 * 返回 `null` 与返回 `""` **不是一回事**：`""` = 根本身就是仓库根（前缀为空但确实在仓库里），
 * `null` = 根不在这个仓库里（或仓库根未知）——调用方据此决定是「根相对就是仓库相对」还是「没得换算」。
 * 早期实现把两者混在一起（都返回 `""`），于是子目录根被当成仓库根：前缀算不出来，
 * 面板按「整仓库」展示、行的路径也没人补前缀，点开就是「文件不存在」。
 */
export function repoPrefixOfAbs(rootAbs: string, repoRootAbs: string, isWin = false): string | null {
  if (!rootAbs || !repoRootAbs) return null
  return relWithin(repoRootAbs, rootAbs, isWin)
}

/**
 * 根相对路径 → 仓库相对路径（`prefix` 为 `""` 时原样返回）。
 * 用于把树/编辑器那侧的路径交给 Git 侧（日志过滤、文件历史）。
 */
export function toRepoRel(prefix: string, rootRel: string): string {
  const rel = String(rootRel ?? "").replace(/^\/+/, "")
  if (!prefix) return rel
  return rel ? `${prefix}/${rel}` : prefix
}

/** 从根 id 解析绝对路径（仅 `abs:` 自带路径；其余类型（sess/proj/bind/user）必须查根清单）。 */
export function rootAbsFromId(id: string): string | null {
  const m = /^abs:(.+)$/s.exec(String(id ?? ""))
  if (!m) return null
  const p = normPath(m[1] ?? "")
  return p || null
}

/** 根类型在「同样覆盖目标」时的优先级（与 deeplink.ts 的 KIND_RANK 同口径：项目类最优先，任意目录最后）。 */
const KIND_RANK: Record<string, number> = { proj: 0, bind: 0, sess: 1, user: 2, abs: 3 }
const rankOf = (kind: string): number => KIND_RANK[kind] ?? 9

export interface ResolvedRepoPath {
  /** 打开该文件用的根 id（可能与传入的当前根不同）。 */
  root: string
  /** 该根内的相对路径。 */
  rel: string
  /** 非 null = 需要把这个临时根加入根清单（`abs:` 型；调用方负责 push 与后续复用）。 */
  create?: { id: string; kind: "abs"; name: string; path: string; writable: boolean }
}

/**
 * 仓库相对路径 → 「用哪个根、根内什么路径」才能打开它。
 *
 * 顺序：① **当前根**内 → 用它（不动根，标签/树上下文都不变）；
 * ② 根清单里**覆盖它**的根（最长前缀优先，同长按类型优先级）→ 用那个根；
 * ③ 都没有 → 以**仓库根**建一个 `abs:` 临时根（仓库根是这批路径天然的家；
 *    比「文件所在目录」更稳：同一批改动的多个文件能落在同一个根下）。
 *
 * `repoRootAbs` 未知时返回 null（调用方给明确提示，而不是拼一条必然 404 的路径）。
 */
export function resolveRepoPath(o: {
  repoRel: string
  rootId: string
  rootAbs: string
  repoRootAbs: string
  roots: readonly PathRoot[]
  isWin?: boolean
  /** 临时根的 writable（继承当前根的可写性；服务端仍会二次校验）。 */
  writable?: boolean
}): ResolvedRepoPath | null {
  const { repoRel, rootId, rootAbs, repoRootAbs, isWin = false } = o
  if (!repoRootAbs || !repoRel) return null
  const abs = absOfRepo(repoRootAbs, repoRel, isWin)
  // ① 当前根内（含根本身）：保持使用同一个根
  const inRoot = relWithin(rootAbs, abs, isWin)
  if (inRoot !== null) return { root: rootId, rel: inRoot }
  // ② 覆盖它的已有根：最长前缀优先
  let best: { root: PathRoot; rel: string; len: number } | null = null
  for (const r of o.roots) {
    const rel = relWithin(r.path, abs, isWin)
    if (rel === null) continue
    const len = normPath(r.path, isWin).length
    if (!best || len > best.len || (len === best.len && rankOf(r.kind) < rankOf(best.root.kind))) {
      best = { root: r, rel, len }
    }
  }
  if (best) return { root: best.root.id, rel: best.rel }
  // ③ 临时 abs 根：指向仓库根
  const base = normPath(repoRootAbs, false)
  return {
    root: `abs:${base}`,
    rel: String(repoRel).replace(/^\/+/, ""),
    create: { id: `abs:${base}`, kind: "abs", name: base.split("/").pop() || base, path: base, writable: o.writable !== false },
  }
}
