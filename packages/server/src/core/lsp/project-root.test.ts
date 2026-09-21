/**
 * 工程根探测测试（`project-root.ts`）：语言标记优先、最近者胜、向上越过工作台根、通用标记兜底、
 * 回退工作台根、两级缓存（命中永久 / 未命中 TTL）。
 *
 * 全程注入假的「文件是否存在」与「父目录」，不碰真实磁盘（测试环境封闭、跨平台确定）。
 */
import { describe, expect, test } from "bun:test"
import { clearProjectRootCache, detectProjectRoot, type DetectOptions } from "./project-root"

/** 假文件系统：只要集合里有的路径就算存在。 */
function fakeFs(files: string[]): Pick<DetectOptions, "exists"> {
  const set = new Set(files)
  return { exists: (p) => set.has(p) }
}

/** POSIX 父目录（避免用例随宿主平台漂移）。 */
const parent = (dir: string): string => {
  const i = dir.lastIndexOf("/")
  return i <= 0 ? "/" : dir.slice(0, i)
}

describe("工程根探测", () => {
  test("Go：从文件所在目录向上找最近的 go.mod（越过工作台根也算）", () => {
    clearProjectRootCache()
    const files = ["/repo/go.mod", "/repo/pkg/a/b/c.go"]
    const info = detectProjectRoot({
      fileAbs: "/repo/pkg/a/b/c.go",
      rootAbs: "/repo/pkg/a",
      language: "go",
      parentOf: parent,
      ...fakeFs(files),
    })
    expect(info).toEqual({ abs: "/repo", marker: "go.mod", detected: true, levels: 3 })
  })

  test("最近的标记优先：子模块的 go.mod 胜过仓库根的", () => {
    clearProjectRootCache()
    const info = detectProjectRoot({
      fileAbs: "/repo/mod/sub/x.go",
      rootAbs: "/repo",
      language: "go",
      parentOf: parent,
      ...fakeFs(["/repo/go.mod", "/repo/mod/go.mod"]),
    })
    expect(info.abs).toBe("/repo/mod")
    expect(info.marker).toBe("go.mod")
  })

  test("语言标记只认自己的：Python 文件不会把 package.json 当工程根", () => {
    clearProjectRootCache()
    const info = detectProjectRoot({
      fileAbs: "/repo/pkg/tool.py",
      rootAbs: "/repo/pkg",
      language: "python",
      parentOf: parent,
      ...fakeFs(["/repo/pkg/package.json"]),
    })
    expect(info.detected).toBe(false)
    expect(info.abs).toBe("/repo/pkg")
  })

  test("语言没专属标记时退到通用标记（.git）", () => {
    clearProjectRootCache()
    const info = detectProjectRoot({
      fileAbs: "/repo/conf/a.yaml",
      rootAbs: "/repo/conf",
      language: "yaml",
      parentOf: parent,
      ...fakeFs(["/repo/.git"]),
    })
    expect(info).toEqual({ abs: "/repo", marker: ".git", detected: true, levels: 1 })
  })

  test("都没有：回落到工作台根，detected=false", () => {
    clearProjectRootCache()
    const info = detectProjectRoot({
      fileAbs: "/work/a/b.lua",
      rootAbs: "/work",
      language: "lua",
      parentOf: parent,
      exists: () => false,
    })
    expect(info).toEqual({ abs: "/work", marker: "", detected: false, levels: 0 })
  })

  test("C/C++：compile_commands.json 与 CMakeLists.txt 都算工程标记（就近者胜）", () => {
    clearProjectRootCache()
    const info = detectProjectRoot({
      fileAbs: "/repo/build/src/x.cpp",
      rootAbs: "/repo/build",
      language: "cpp",
      parentOf: parent,
      ...fakeFs(["/repo/CMakeLists.txt", "/repo/build/compile_commands.json"]),
    })
    expect(info.abs).toBe("/repo/build")
    expect(info.marker).toBe("compile_commands.json")
  })

  test("最多向上 24 层（病态深目录不会把探测拖成 IO 风暴）", () => {
    clearProjectRootCache()
    const deep = `/${Array.from({ length: 40 }, (_, i) => `d${i}`).join("/")}/x.go`
    const info = detectProjectRoot({
      fileAbs: deep,
      rootAbs: "/fallback",
      language: "go",
      parentOf: parent,
      exists: () => false,
    })
    expect(info.detected).toBe(false)
    expect(info.abs).toBe("/fallback")
  })

  test("缓存：命中的工程根记住（不重复探测）；未命中的按 TTL 过期后重算", () => {
    clearProjectRootCache()
    const files = new Set<string>()
    const exists = (p: string): boolean => files.has(p)
    let now = 1000
    const base = { fileAbs: "/repo/x.go", rootAbs: "/fallback", language: "go", parentOf: parent, exists }
    expect(detectProjectRoot({ ...base, now: () => now }).detected).toBe(false)
    // 未命中被缓存：TTL 内即使 go.mod 出现也仍走缓存
    files.add("/repo/go.mod")
    expect(detectProjectRoot({ ...base, now: () => now }).detected).toBe(false)
    // 过了 TTL：重新探测到 go.mod
    now += 60_000
    expect(detectProjectRoot({ ...base, now: () => now })).toEqual({ abs: "/repo", marker: "go.mod", detected: true, levels: 0 })
    // 命中后即使磁盘上的标记消失也仍走缓存（工程根不会平白消失）
    files.clear()
    expect(detectProjectRoot({ ...base, now: () => now + 60_000 }).detected).toBe(true)
  })
})
