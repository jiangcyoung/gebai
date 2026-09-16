/**
 * 自动刷新静默判据的指纹逻辑（`files/refresh-guard.ts`）：同数据同键、异数据异键、空值不与空串同键。
 */
import { describe, expect, test } from "bun:test"
import { changesFingerprint, fingerprint, listFingerprint, logFingerprint, type ChangeLike, type CommitLike } from "./refresh-guard"

describe("fingerprint（通用指纹）", () => {
  test("同输入同键（可重复、无隐藏状态）", () => {
    expect(fingerprint(["a", 1, true])).toBe(fingerprint(["a", 1, true]))
  })

  test("顺序敏感（渲染顺序是数据的一部分）", () => {
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["b", "a"]))
  })

  test("片段数与内容都参与（截断 / 少一项都算不同）", () => {
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["a"]))
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["ab"]))
  })

  test("跨类型不碰撞：true 与 \"1\"、1 与 \"1\" 各不同键", () => {
    expect(fingerprint([true])).not.toBe(fingerprint(["1"]))
    expect(fingerprint([1])).not.toBe(fingerprint(["1"]))
  })

  test("null / undefined / 空串分得清（`没有` 与 `空` 不是一件事）", () => {
    expect(fingerprint([null])).not.toBe(fingerprint([""]))
    expect(fingerprint([null])).toBe(fingerprint([undefined]))
  })

  test("嵌套数组按内容展开（列表指纹的基础）", () => {
    expect(fingerprint([["a", "b"]])).not.toBe(fingerprint([["b", "a"]]))
    expect(fingerprint([["a"]])).toBe(fingerprint([["a"]]))
  })
})

describe("changesFingerprint（变更清单）", () => {
  const base: ChangeLike[] = [
    { path: "src/a.ts", kind: "modified", unstaged: true },
    { path: "docs/b.md", kind: "added", staged: true },
  ]

  test("同清单同键", () => {
    expect(changesFingerprint(base)).toBe(changesFingerprint(base.map((c) => ({ ...c }))))
  })

  test("任一状态位翻转都变键（暂存态是列表分组依据）", () => {
    const flipped = [{ ...base[0]!, staged: true }, base[1]!]
    expect(changesFingerprint(flipped)).not.toBe(changesFingerprint(base))
  })

  test("kind 变化（M→D）变键：行上标记随之改变", () => {
    const deleted = [{ ...base[0]!, kind: "deleted" }, base[1]!]
    expect(changesFingerprint(deleted)).not.toBe(changesFingerprint(base))
  })

  test("增删条目与顺序变化都变键", () => {
    expect(changesFingerprint([base[0]!])).not.toBe(changesFingerprint(base))
    expect(changesFingerprint([base[1]!, base[0]!])).not.toBe(changesFingerprint(base))
  })

  test("空清单有稳定键", () => {
    expect(changesFingerprint([])).toBe(changesFingerprint([]))
  })
})

describe("logFingerprint（日志列表）", () => {
  const commits: CommitLike[] = [
    { hash: "a".repeat(40), short: "aaaaaaa", subject: "feat: 甲", author: "甲", refs: ["HEAD -> main"] },
    { hash: "b".repeat(40), short: "bbbbbbb", subject: "fix: 乙", author: "乙", refs: [] },
  ]
  const opts = { queryKey: "q1", loading: false, error: "", hasMore: true, remoteNames: ["origin"] }

  test("同数据同键", () => {
    expect(logFingerprint(commits, opts)).toBe(logFingerprint(commits.map((c) => ({ ...c })), { ...opts }))
  })

  test("refs 变化算变了（切分支 / 打标签不产生新提交，但芯片必须更新）", () => {
    const moved = [{ ...commits[0]!, refs: ["HEAD -> dev"] }, commits[1]!]
    expect(logFingerprint(moved, opts)).not.toBe(logFingerprint(commits, opts))
  })

  test("过滤条件 / 加载态 / 错误 / 还有更多 都参与指纹", () => {
    expect(logFingerprint(commits, { ...opts, queryKey: "q2" })).not.toBe(logFingerprint(commits, opts))
    expect(logFingerprint(commits, { ...opts, loading: true })).not.toBe(logFingerprint(commits, opts))
    expect(logFingerprint(commits, { ...opts, error: "读取失败" })).not.toBe(logFingerprint(commits, opts))
    expect(logFingerprint(commits, { ...opts, hasMore: false })).not.toBe(logFingerprint(commits, opts))
  })

  test("远程名参与指纹（引用芯片的配色靠它判定）", () => {
    expect(logFingerprint(commits, { ...opts, remoteNames: [] })).not.toBe(logFingerprint(commits, opts))
  })

  test("提交顺序敏感（日志是「新的在上」）", () => {
    expect(logFingerprint([commits[1]!, commits[0]!], opts)).not.toBe(logFingerprint(commits, opts))
  })
})

describe("listFingerprint（分支 / 标签 / 储存 / 远程）", () => {
  const branches = [
    { name: "main", current: true, remote: false, ahead: 2, behind: 0, hash: "a".repeat(40) },
    { name: "origin/main", current: false, remote: true, ahead: 0, behind: 0, hash: "a".repeat(40) },
  ]
  const fields = (b: (typeof branches)[number]) => [b.name, b.current, b.remote, b.ahead, b.behind, b.hash]

  test("同数据同键", () => {
    expect(listFingerprint(branches, fields)).toBe(listFingerprint(branches.map((b) => ({ ...b })), fields))
  })

  test("ahead/behind 翻转 / 当前分支换人 都变键", () => {
    expect(listFingerprint([{ ...branches[0]!, ahead: 3 }, branches[1]!], fields)).not.toBe(listFingerprint(branches, fields))
    expect(listFingerprint([{ ...branches[1]!, current: true }, branches[0]!], fields)).not.toBe(listFingerprint(branches, fields))
  })

  test("空清单有稳定键", () => {
    expect(listFingerprint([], fields)).toBe(listFingerprint([], fields))
  })
})
