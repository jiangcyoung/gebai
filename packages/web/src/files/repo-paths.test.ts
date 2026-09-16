/**
 * 仓库相对 ↔ 根相对（`files/repo-paths.ts`）的单测。
 *
 * 这些换算错了不会报错：多了/少了前缀只会让「打开文件」404 或让日志过滤**静默空**，
 * 根外文件（整仓库范围下的改动）更是连表达都表达不出来。故把每条规则钉住。
 */
import { describe, expect, test } from "bun:test"
import { absOfRepo, normPath, relWithin, repoPrefixOfAbs, resolveRepoPath, rootAbsFromId, toRepoRel } from "./repo-paths"

describe("normPath / rootAbsFromId", () => {
  test("归一：反斜杠、尾斜杠；Windows 下小写", () => {
    expect(normPath("a\\b\\")).toBe("a/b")
    expect(normPath("/x/y/")).toBe("/x/y")
    expect(normPath("C:\\Repo\\Sub\\", true)).toBe("c:/repo/sub")
    expect(normPath("/Repo/Sub", false)).toBe("/Repo/Sub")
  })

  test("abs: 根 id 自带路径；其它类型解析不出", () => {
    expect(rootAbsFromId("abs:/tmp/wbug")).toBe("/tmp/wbug")
    expect(rootAbsFromId("abs:/tmp/wbug/")).toBe("/tmp/wbug")
    expect(rootAbsFromId("proj:gebai")).toBeNull()
    expect(rootAbsFromId("sess:abc")).toBeNull()
  })
})

describe("relWithin（归属判定）", () => {
  test("根内返回相对路径；本身返回空串；根外返回 null", () => {
    expect(relWithin("/repo", "/repo/a/b.txt")).toBe("a/b.txt")
    expect(relWithin("/repo", "/repo")).toBe("")
    expect(relWithin("/repo", "/repo2/a.txt")).toBeNull() // 兄弟目录：前缀相同但不是子路径
    expect(relWithin("/repo/sub", "/repo/a.txt")).toBeNull()
  })

  test("Windows 大小写不敏感由调用方声明（比较不敏感，返回值保留原大小写）", () => {
    expect(relWithin("C:\\Repo", "c:\\repo\\a.txt", true)).toBe("a.txt")
    expect(relWithin("C:\\Repo", "C:\\Repo\\MixedCase.TXT", true)).toBe("MixedCase.TXT")
    expect(relWithin("C:\\Repo", "c:\\repo\\a.txt", false)).toBeNull()
  })
})

describe("repoPrefixOfAbs（根在仓库内的前缀）", () => {
  test("子目录根给出前缀；仓库根给出空串；仓库外给出 null（三者语义不同）", () => {
    expect(repoPrefixOfAbs("/repo/packages/web", "/repo")).toBe("packages/web")
    expect(repoPrefixOfAbs("/repo", "/repo")).toBe("")
    expect(repoPrefixOfAbs("/other", "/repo")).toBeNull()
    expect(repoPrefixOfAbs("/repo", "")).toBeNull()
  })
})

describe("toRepoRel / absOfRepo", () => {
  test("根相对 → 仓库相对（前缀拼接；空相对 = 前缀本身；无前缀原样）", () => {
    expect(toRepoRel("packages/web", "src/a.ts")).toBe("packages/web/src/a.ts")
    expect(toRepoRel("packages/web", "")).toBe("packages/web")
    expect(toRepoRel("", "src/a.ts")).toBe("src/a.ts")
  })

  test("仓库相对 → 绝对", () => {
    expect(absOfRepo("/repo", "sub/a.txt")).toBe("/repo/sub/a.txt")
    expect(absOfRepo("/repo", "a.txt")).toBe("/repo/a.txt")
    expect(absOfRepo("/repo/", "/abs/x.txt")).toBe("/repo//abs/x.txt".replace("//abs", "/abs")) // 前导斜杠去掉后再拼
  })
})

describe("resolveRepoPath（仓库相对路径 → 用哪个根打开）", () => {
  const roots = [
    { id: "proj:gebai", kind: "proj", path: "/repo" },
    { id: "abs:/repo/sub", kind: "abs", path: "/repo/sub" },
  ]

  test("目标在当前根内：不换根", () => {
    const r = resolveRepoPath({ repoRel: "sub/a.txt", rootId: "abs:/repo/sub", rootAbs: "/repo/sub", repoRootAbs: "/repo", roots })
    expect(r).toEqual({ root: "abs:/repo/sub", rel: "a.txt" })
  })

  test("目标在根本身：根内相对为空串", () => {
    const r = resolveRepoPath({ repoRel: "sub", rootId: "abs:/repo/sub", rootAbs: "/repo/sub", repoRootAbs: "/repo", roots })
    expect(r).toEqual({ root: "abs:/repo/sub", rel: "" })
  })

  test("目标在根外：用清单里覆盖它的根（最长前缀优先）", () => {
    const r = resolveRepoPath({ repoRel: "other/f.txt", rootId: "abs:/repo/sub", rootAbs: "/repo/sub", repoRootAbs: "/repo", roots })
    expect(r).toEqual({ root: "proj:gebai", rel: "other/f.txt" })
  })

  test("目标在根外且清单里没有覆盖它的根：建 abs: 临时根指向仓库根", () => {
    const r = resolveRepoPath({ repoRel: "other/deep/d.txt", rootId: "abs:/repo/sub", rootAbs: "/repo/sub", repoRootAbs: "/repo", roots: [roots[1]!], writable: false })
    expect(r?.root).toBe("abs:/repo")
    expect(r?.rel).toBe("other/deep/d.txt")
    expect(r?.create).toEqual({ id: "abs:/repo", kind: "abs", name: "repo", path: "/repo", writable: false })
  })

  test("同长前缀时按类型优先级选（项目根优先于任意目录根）", () => {
    const same = [
      { id: "abs:/repo", kind: "abs", path: "/repo" },
      { id: "proj:gebai", kind: "proj", path: "/repo" },
    ]
    const r = resolveRepoPath({ repoRel: "x/a.txt", rootId: "sess:s1", rootAbs: "/tmp/s1", repoRootAbs: "/repo", roots: same })
    expect(r?.root).toBe("proj:gebai")
  })

  test("仓库根未知 / 路径为空：返回 null（调用方给明确提示，不拼必然 404 的路径）", () => {
    expect(resolveRepoPath({ repoRel: "a.txt", rootId: "r", rootAbs: "/repo", repoRootAbs: "", roots })).toBeNull()
    expect(resolveRepoPath({ repoRel: "", rootId: "r", rootAbs: "/repo", repoRootAbs: "/repo", roots })).toBeNull()
  })

  test("Windows 下大小写不敏感（同一目录不换根）", () => {
    const r = resolveRepoPath({ repoRel: "Sub/A.txt", rootId: "abs:C:/Repo/Sub", rootAbs: "C:\\Repo\\Sub", repoRootAbs: "c:/repo", roots: [], isWin: true })
    expect(r).toEqual({ root: "abs:C:/Repo/Sub", rel: "A.txt" })
  })
})
