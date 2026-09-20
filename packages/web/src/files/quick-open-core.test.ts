import { describe, expect, test } from "bun:test"
import { fuzzyMatch, normalizePath, rankPaths } from "./quick-open-core"

const paths = [
  "packages/web/src/main.ts",
  "packages/web/src/files/main.ts",
  "packages/web/src/files/quick-open-core.ts",
  "packages/server/src/main.ts",
  "packages/main/config.ts",
  "DESIGN.md",
  "docs/keyboard-shortcuts.md",
]

const names = (items: Array<{ path: string }>): string[] => items.map((i) => i.path)

describe("模糊匹配", () => {
  test("子序列命中：缩写能打出来（敲 smain 找 src/main.ts）", () => {
    expect(fuzzyMatch("smain", "packages/web/src/main.ts")).not.toBeNull()
    expect(fuzzyMatch("qoc", "packages/web/src/files/quick-open-core.ts")).not.toBeNull()
  })

  test("不是子序列就无匹配（不做编辑距离近似——那会把不相干的文件也端上来）", () => {
    expect(fuzzyMatch("zzz", "packages/web/src/main.ts")).toBeNull()
    expect(fuzzyMatch("nmian", "packages/web/src/main.ts")).toBeNull()
  })

  test("大小写不敏感，但驼峰边界加分", () => {
    expect(fuzzyMatch("MAIN", "src/main.ts")).not.toBeNull()
    const camel = fuzzyMatch("qo", "quickOpen.ts")!
    const flat = fuzzyMatch("qo", "quickopen.ts")!
    expect(camel.score).toBeGreaterThan(flat.score)
  })

  test("命中位置可用于高亮：下标落在原串上且递增", () => {
    const m = fuzzyMatch("main", "packages/web/src/main.ts")!
    expect(m.positions.length).toBe(4)
    expect(m.positions.map((i) => "packages/web/src/main.ts"[i]).join("")).toBe("main")
    expect([...m.positions].sort((a, b) => a - b)).toEqual(m.positions)
  })

  test("空查询匹配一切但不计分（面板里由「最近打开」接管）", () => {
    expect(fuzzyMatch("", "anything.ts")).toEqual({ score: 0, positions: [] })
    expect(fuzzyMatch("   ", "anything.ts")).toEqual({ score: 0, positions: [] })
  })
})

describe("排序", () => {
  test("文件名命中优先于目录名命中（main 先给 src/main.ts 而不是 packages/main/…）", () => {
    const r = rankPaths("main", paths, { limit: 4 })
    const top = names(r)
    expect(top[0]).toBe("packages/web/src/main.ts")
    expect(top).toContain("packages/server/src/main.ts")
    // packages/main/config.ts 只匹配到目录段（config.ts 里没有 main），必须排在文件名命中之后
    expect(top.indexOf("packages/main/config.ts")).toBeGreaterThan(top.indexOf("packages/server/src/main.ts"))
  })

  test("最优对齐：smain 应命中 src/main.ts（段首 + 连续），而不是散落在 manifest 里的同名子序列", () => {
    // 贪心取最左命中会吃掉 scripts 里的 s、并把 main 拆到 manifest.json 各处——那类结果一出来，
    // 用户就知道「还得自己翻」，缩写就白敲了。
    const sample = ["scripts/resources.manifest.json", "packages/web/src/main.ts", "keqing/go/dirs/main.go"]
    expect(names(rankPaths("smain", sample, { limit: 3 }))[0]).toBe("packages/web/src/main.ts")
  })

  test("跨目录跳跃比同段内跳跃代价大：wsmain 先给 web 下的 main", () => {
    const sample = ["packages/web/src/main.ts", "packages/server/src/main.ts", "keqing/rust/hsh/src/main.rs"]
    expect(names(rankPaths("wsmain", sample, { limit: 3 }))[0]).toBe("packages/web/src/main.ts")
  })

  test("连续命中优于跳跃命中（跨段空隙要付代价）", () => {
    const r = rankPaths("main", ["src/m/a/i/n.ts", "src/main.ts"], { limit: 2 })
    expect(names(r)[0]).toBe("src/main.ts")
  })

  test("重复查询结果顺序稳定（键盘操作不能每次都换位置）", () => {
    const a = names(rankPaths("main", paths, { limit: 10 }))
    const b = names(rankPaths("main", [...paths].reverse(), { limit: 10 }))
    expect(a).toEqual(b)
  })

  test("空查询 → 最近打开（按最近程度，且不掺入其它文件）", () => {
    const recent = ["docs/keyboard-shortcuts.md", "packages/web/src/main.ts"]
    const r = rankPaths("", paths, { limit: 10, recent })
    expect(names(r)).toEqual(recent)
    expect(r.every((i) => i.recent)).toBe(true)
  })

  test("最近打开过的候选在有查询时优先（同分档位内）", () => {
    const plain = rankPaths("config", paths, { limit: 5 })
    const withRecent = rankPaths("config", paths, { limit: 5, recent: ["packages/main/config.ts"] })
    expect(names(plain)[0]).toBe("packages/main/config.ts")
    expect(withRecent[0]!.recent).toBe(true)
  })

  test("limit 生效（面板只渲染有限行）", () => {
    expect(rankPaths("s", paths, { limit: 2 })).toHaveLength(2)
  })

  test("最优对齐的命中位置仍是合法子序列（高亮靠它）", () => {
    const m = fuzzyMatch("smain", "packages/web/src/main.ts")!
    expect(m.positions.map((i) => "packages/web/src/main.ts"[i]).join("")).toBe("smain")
  })

  test("路径分隔符归一：Windows 反斜杠索引也能命中", () => {
    expect(normalizePath(".\\src\\main.ts")).toBe("./src/main.ts".replace("./", ""))
    const r = rankPaths("main", ["src\\main.ts"], { limit: 5 })
    expect(names(r)).toEqual(["src/main.ts"])
  })
})
