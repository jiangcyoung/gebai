/**
 * 变更列表树视图的纯逻辑（`files/changes-tree.ts`）：建树、排序、计数、折叠后拍平。
 * 这些口径错起来不会报错（只是顺序乱、计数不对、折叠了还漏子行），用单测钉住。
 */
import { describe, expect, test } from "bun:test"
import { buildChangeTree, treeRows, type TreeRow } from "./changes-tree"
import type { GitChange } from "./api"

const ch = (path: string, over: Partial<GitChange> = {}): GitChange => ({
  path,
  index: " ",
  worktree: "M",
  kind: "modified",
  renamed: false,
  staged: false,
  unstaged: true,
  untracked: false,
  conflicted: false,
  ...over,
})

/** 把行压成「缩进 名字」便于断言结构与顺序。 */
const shape = (rows: Array<TreeRow<GitChange>>): string[] =>
  rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "dir" ? `${r.name}/` : r.name}`)

describe("buildChangeTree / treeRows", () => {
  test("按目录收拢：同一目录的多个文件挂在一个目录节点下", () => {
    const root = buildChangeTree([ch("packages/web/src/a.ts"), ch("packages/web/src/b.ts"), ch("README.md")])
    expect(shape(treeRows(root))).toEqual([
      "packages/",
      "  web/",
      "    src/",
      "      a.ts",
      "      b.ts",
      "README.md",
    ])
  })

  test("排序：目录在前、文件在后，各自按名称自然顺序（a2 在 a10 前）", () => {
    const root = buildChangeTree([ch("z.ts"), ch("a10.ts"), ch("a2.ts"), ch("src/x.ts"), ch("docs/y.ts")])
    expect(shape(treeRows(root))).toEqual([
      "docs/",
      "  y.ts",
      "src/",
      "  x.ts",
      "a2.ts",
      "a10.ts",
      "z.ts",
    ])
  })

  test("目录计数是**全部**后代文件数（不只直接子级）", () => {
    const root = buildChangeTree([ch("a/b/c1.ts"), ch("a/b/c2.ts"), ch("a/d.ts"), ch("e.ts")])
    const countAt = (p: string): number | null => {
      const dir = treeRows(root).find((r) => r.kind === "dir" && r.path === p)
      return dir && dir.kind === "dir" ? dir.fileCount : null
    }
    expect(countAt("a")).toBe(3)
    expect(countAt("a/b")).toBe(2)
    expect(countAt("e.ts")).toBe(null)
  })

  test("折叠：目录行保留、子行整段跳过（含更深的分支）", () => {
    const root = buildChangeTree([ch("a/b/c.ts"), ch("a/d.ts"), ch("z.ts")])
    expect(shape(treeRows(root, (p) => p === "a"))).toEqual(["a/", "z.ts"])
    expect(shape(treeRows(root, (p) => p === "a/b"))).toEqual(["a/", "  b/", "  d.ts", "z.ts"])
  })

  test("同名目录复用，不重复建节点；文件行保留原路径（stage/diff 的入参）", () => {
    const root = buildChangeTree([ch("a/x.ts"), ch("a/y.ts")])
    const dirs = treeRows(root).filter((r) => r.kind === "dir")
    expect(dirs.map((d) => d.path)).toEqual(["a"])
    const files = treeRows(root).filter((r) => r.kind === "file")
    expect(files.map((f) => f.path)).toEqual(["a/x.ts", "a/y.ts"])
    expect(files.map((f) => f.name)).toEqual(["x.ts", "y.ts"])
  })

  test("空路径条目被丢弃（没有可展示的名字，硬塞只会多出无名行）", () => {
    expect(shape(treeRows(buildChangeTree([ch(""), ch("/"), ch("a.ts")])))).toEqual(["a.ts"])
  })

  test("深度与文件所在层级一致（根下文件 depth 0，一层目录内的文件 depth 1）", () => {
    const rows = treeRows(buildChangeTree([ch("x.ts"), ch("d/y.ts"), ch("d/e/z.ts")]))
    expect(rows.map((r) => [r.kind, r.depth, r.name])).toEqual([
      ["dir", 0, "d"],
      ["dir", 1, "e"],
      ["file", 2, "z.ts"],
      ["file", 1, "y.ts"],
      ["file", 0, "x.ts"],
    ])
  })
})
