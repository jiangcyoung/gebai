/**
 * 日志范围选择器的纯逻辑（`files/git-refs.ts`）：分组、顺序、过滤与「全部分支」入口。
 * 这些口径直接决定用户能看到哪些引用、搜出来的行是不是他要的，用单测钉住。
 */
import { describe, expect, test } from "bun:test"
import { ALL_REFS, buildRefGroups } from "./git-refs"
import type { GitBranchInfo, GitTagInfo } from "./api"

const branch = (name: string, over: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  name,
  remote: false,
  current: false,
  hash: "a".repeat(40),
  ...over,
})
const tag = (name: string, over: Partial<GitTagInfo> = {}): GitTagInfo => ({ name, hash: "b".repeat(40), ...over })

/** 展平成「组名: 取值」便于断言顺序。 */
const flat = (branches: GitBranchInfo[], tags: GitTagInfo[], query?: string): string[] =>
  buildRefGroups({ branches, tags, query }).flatMap((g) => g.options.map((o) => `${g.label}: ${o.value}`))

describe("buildRefGroups（分组与顺序）", () => {
  const branches = [
    branch("main", { current: true, hash: "a".repeat(40) }),
    branch("feat/a"),
    branch("origin/main", { remote: true }),
    branch("origin/feat/a", { remote: true }),
  ]
  const tags = [tag("v1.0"), tag("v1.1")]

  test("顺序固定为 范围 → 本地分支 → 远程分支 → 标签，组内保持入参顺序", () => {
    expect(flat(branches, tags)).toEqual([
      `范围: ${ALL_REFS}`,
      "本地分支: main",
      "本地分支: feat/a",
      "远程分支: origin/main",
      "远程分支: origin/feat/a",
      "标签: v1.0",
      "标签: v1.1",
    ])
  })

  test("范围行取值是空串（= git log --all 的口径）", () => {
    expect(ALL_REFS).toBe("")
    expect(buildRefGroups({ branches: [], tags: [] })[0]?.options[0]?.value).toBe("")
  })

  test("当前分支标当前分支（✓ 图标 + 「当前分支」说明）；其它分支用分支图标", () => {
    const locals = buildRefGroups({ branches, tags: [] }).find((g) => g.label === "本地分支")
    expect(locals?.options.find((o) => o.value === "main")).toMatchObject({ icon: "check", detail: "当前分支" })
    expect(locals?.options.find((o) => o.value === "feat/a")).toMatchObject({ icon: "branch", detail: undefined })
  })

  test("标签用标签图标；无分支/标签时只剩范围组", () => {
    expect(buildRefGroups({ branches: [], tags: [tag("v1.0")] }).find((g) => g.label === "标签")?.options[0]?.icon).toBe("tag")
    expect(buildRefGroups({ branches: [], tags: [] }).map((g) => g.label)).toEqual(["范围"])
  })

  test("跟踪分支的说明写上游（没有说明的行不留空 detail）", () => {
    const groups = buildRefGroups({ branches: [branch("feat/x", { upstream: "origin/feat/x" })], tags: [] })
    expect(groups.find((g) => g.label === "本地分支")?.options[0]?.detail).toBe("跟踪 origin/feat/x")
    expect(buildRefGroups({ branches: [branch("feat/y")], tags: [] }).find((g) => g.label === "本地分支")?.options[0]?.detail).toBeUndefined()
  })
})

describe("buildRefGroups（搜索过滤）", () => {
  const branches = [branch("main", { current: true, subject: "发布 1.2" }), branch("feature_branch"), branch("origin/main", { remote: true })]
  const tags = [tag("v1.0", { subject: "首个版本" })]

  test("按名称过滤，大小写不敏感，空组剔除", () => {
    expect(flat(branches, tags, "FEATURE")).toEqual([`范围: ${ALL_REFS}`, "本地分支: feature_branch"])
  })

  test("命中说明（提交信息）也算：搜提交信息能找到分支", () => {
    expect(flat(branches, tags, "首个版本")).toEqual([`范围: ${ALL_REFS}`, "标签: v1.0"])
  })

  test("「全部分支」不参与过滤：搜索时它仍在（清范围的入口不能被滤掉）", () => {
    expect(flat(branches, tags, "不存在的名字")).toEqual([`范围: ${ALL_REFS}`])
  })

  test("只输入空白 = 不过滤", () => {
    expect(flat(branches, tags, "  ").length).toBe(flat(branches, tags).length)
  })
})
