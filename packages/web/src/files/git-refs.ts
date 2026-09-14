/**
 * 日志范围（全部分支 / 分支 / 标签）选择的纯逻辑：把分支与标签清单分组成选择器的行，
 * 并按查询词过滤。浮层渲染与日志重载在 files/git.ts，这里只管数据形状（可单测）。
 *
 * 为什么单独成模块：范围取值要直接进 `git log` 的 `ref` / `all` 参数（与服务端同口径），
 * 「空 = 全部分支（--all）」这个约定单独一处定义，免得渲染、重载、服务端三处各写一份各自漂移。
 */
import type { GitBranchInfo, GitTagInfo } from "./api"

/** 「全部分支」的取值 = 空 ref（`git log --all`，不按引用裁剪）。 */
export const ALL_REFS = ""

export interface RefOption {
  /** 交给 git log 的 rev；ALL_REFS = 全部分支 */
  value: string
  label: string
  /** 行的次要说明（当前分支 / 上游 / 提交信息） */
  detail?: string
  /** 未选中该范围时行首显示的图标（选中由渲染方换成 ✓；当前分支的 ✓ 也走这里） */
  icon: string
}

export interface RefGroup {
  label: string
  options: RefOption[]
}

export interface RefChoiceInput {
  branches: GitBranchInfo[]
  tags: GitTagInfo[]
  /** 查询词：大小写不敏感，匹配名称、说明与取值 */
  query?: string
}

/**
 * 选择器分组：范围（全部分支）→ 本地分支 → 远程分支 → 标签。
 * 组内保持调用方给的顺序（服务端已按「当前分支 → 本地名称 → 远程名称」排好）；
 * 过滤后空组剔除，但「全部分支」恒在首行——清范围的入口不能因为搜索词被滤掉。
 */
export function buildRefGroups(input: RefChoiceInput): RefGroup[] {
  const q = (input.query ?? "").trim().toLowerCase()
  const hit = (o: RefOption): boolean =>
    !q || o.label.toLowerCase().includes(q) || (o.detail ?? "").toLowerCase().includes(q) || o.value.toLowerCase().includes(q)

  const locals: RefOption[] = []
  const remotes: RefOption[] = []
  for (const b of input.branches) {
    const option: RefOption = {
      value: b.name,
      label: b.name,
      detail: b.current ? "当前分支" : b.upstream ? `跟踪 ${b.upstream}` : b.subject,
      icon: b.current ? "check" : "branch",
    }
    ;(b.remote ? remotes : locals).push(option)
  }
  const tags: RefOption[] = input.tags.map((t) => ({ value: t.name, label: t.name, detail: t.subject, icon: "tag" }))

  const groups: RefGroup[] = [
    { label: "范围", options: [{ value: ALL_REFS, label: "全部分支", detail: "--all（不按引用裁剪）", icon: "git" }] },
  ]
  for (const [label, options] of [["本地分支", locals], ["远程分支", remotes], ["标签", tags]] as const) {
    const kept = options.filter(hit)
    if (kept.length) groups.push({ label, options: kept })
  }
  return groups
}
