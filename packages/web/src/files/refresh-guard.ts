/**
 * 自动刷新的**静默判据**：这份数据与上次渲染的是否相同（纯函数，可单测）。
 *
 * 为什么需要：工作台的自动刷新（变更监听长轮询 / 兜底轮询 / 文件系统事件）只保证「数据是新鲜的」，
 * 而各面板原先的做法是**拿到数据就重绘**——于是工作区没变化时，一次心跳也会把活动栏、变更列表、
 * Git 工具窗整列重建一遍：滚动位置回跳、hover 消失、分组折叠态复位、正在输入的提交信息丢焦点。
 * 正确的语义是「**没有变化就不要碰 DOM**」：渲染前先算一次数据指纹，与上次渲染时相同就直接返回。
 *
 * 为什么指纹抽在这里：各渲染器的输入散在几十个变量里（加载态、错误串、过滤条件、当前选中……），
 * 漏一个的后果是「界面停在旧数据上」——这类错误肉眼很难复现，抽成纯函数就能用单测钉住。
 */

/** 片段分隔符（控制字符，不会出现在路径 / 分支名 / 提交信息里）。 */
const SEP = "\u0001"
/** 空值记号（与空串区分：`null` 与 `""` 语义不同，不该算同一份数据）。 */
const NIL = "\u0000"

/**
 * 片段归一：**带类型前缀**，免得 `true` 与 `"1"`、`3` 与 `"3"` 这类跨类型值指纹相同。
 * 同一位置的字段类型是固定的，实际不会跨类型碰撞；前缀只是让判定不依赖这个前提。
 */
function part(v: unknown): string {
  if (v === null || v === undefined) return NIL
  if (typeof v === "string") return `s${v}`
  if (typeof v === "number") return `n${v}`
  if (typeof v === "boolean") return `b${v ? 1 : 0}`
  if (Array.isArray(v)) return `a[${v.map(part).join(SEP)}]`
  return `j${JSON.stringify(v)}`
}

/** 由若干片段拼一个指纹（顺序敏感——渲染顺序本身也是数据的一部分）。 */
export function fingerprint(parts: readonly unknown[]): string {
  return parts.map(part).join(SEP)
}

/** 变更条目里参与渲染的字段（`GitChange` 的结构子集）。 */
export interface ChangeLike {
  path: string
  kind?: string
  staged?: boolean
  unstaged?: boolean
  untracked?: boolean
  conflicted?: boolean
}

/**
 * 变更清单指纹：路径 + 各类状态位。
 * 顺序敏感（清单顺序就是 git 给出的顺序，也是列表的渲染顺序）；
 * 只比 flags 不比 kind 之外的东西——`kind` 变了标记（M/A/D/R）就变，必须比。
 */
export function changesFingerprint(changes: readonly ChangeLike[]): string {
  return fingerprint(changes.map((c) => [c.path, c.kind ?? "", !!c.staged, !!c.unstaged, !!c.untracked, !!c.conflicted]))
}

/** 提交条目里参与渲染的字段（`GitCommitInfo` 的结构子集）。 */
export interface CommitLike {
  hash: string
  short?: string
  subject?: string
  author?: string
  refs?: readonly string[]
}

/**
 * 日志列表指纹。除提交本身，还必须含：
 * - **refs**：打标签 / 建分支 / 切 HEAD 不产生新提交（hash 全同），但行上的引用芯片已经变了；
 * - **过滤条件**（`queryKey`）：条件变了结果集必然变，前缀相同不能当作未变；
 * - **加载/错误态**：底部「加载中… / 加载更多」与错误条都由它们决定；
 * - **远程名**（`remoteNames`）：引用芯片的配色靠「这个引用是不是远程」判定。
 *
 * 不含相对时间（`timeAgo`）：那是随时钟漂移的展示值，把它算进指纹等于永远判定为「变了」，
 * 静默就白做了。代价是相对时间只在数据真的变化时刷新一次——对提交时间（多为天/月粒度）无影响。
 */
export function logFingerprint(
  commits: readonly CommitLike[],
  opts: { queryKey: string; loading: boolean; error: string; hasMore: boolean; remoteNames: readonly string[] },
): string {
  return fingerprint([
    opts.queryKey,
    opts.loading,
    opts.error,
    opts.hasMore,
    [...opts.remoteNames],
    commits.map((c) => [c.hash, c.short ?? "", c.subject ?? "", c.author ?? "", [...(c.refs ?? [])]]),
  ])
}

/**
 * 通用清单指纹：给「分支 / 标签 / 储存 / 远程」这类列表用（字段由调用方按渲染实际取值给出）。
 * 提供它只是为了统一「列表 → 指纹」的写法，语义完全由调用方给的字段决定。
 */
export function listFingerprint<T>(items: readonly T[], fields: (item: T) => readonly unknown[]): string {
  return fingerprint(items.map(fields))
}
