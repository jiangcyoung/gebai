/**
 * 工程根探测测试（`project-root.ts`）：语言标记优先、最近者胜、**工作区根细化**（Cargo workspace /
 * go.work / npm workspaces）、向上越过工作台根、通用标记兜底、回退工作台根、两级缓存（命中永久 / 未命中 TTL）。
 *
 * 全程注入假的「文件是否存在」「文件内容」与「父目录」，不碰真实磁盘（测试环境封闭、跨平台确定）。
 */
import { describe, expect, test } from "bun:test"
import { clearProjectRootCache, detectProjectRoot, isWorkspaceMarker, type DetectOptions } from "./project-root"

/** 假文件系统：只要集合里有的路径就算存在。 */
function fakeFs(files: string[]): Pick<DetectOptions, "exists"> {
  const set = new Set(files)
  return { exists: (p) => set.has(p) }
}

/** 假文件系统（带内容）：存在性 + 读取一次给全。 */
function fakeFsWithContent(files: Record<string, string>): Pick<DetectOptions, "exists" | "read"> {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p]! : null),
  }
}

/** POSIX 父目录（避免用例随宿主平台漂移）。 */
const parent = (dir: string): string => {
  const i = dir.lastIndexOf("/")
  return i <= 0 ? "/" : dir.slice(0, i)
}

/** POSIX 目录+文件名拼接：与 `parent` 配对注入，使假路径与探测代码的路径语义一致
 *  （缺它时代码默认用宿主 `path.join`，Windows 下产出反斜杠、假文件系统查不中）。 */
const posixJoin = (dir: string, name: string): string => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`)

/** 统一的 POSIX 路径语义注入（向上取父目录 + 目录/文件名拼接）。 */
const posixFs = { parentOf: parent, join: posixJoin }

describe("工程根探测", () => {
  test("Go：从文件所在目录向上找最近的 go.mod（越过工作台根也算）", () => {
    clearProjectRootCache()
    const files = ["/repo/go.mod", "/repo/pkg/a/b/c.go"]
    const info = detectProjectRoot({
      fileAbs: "/repo/pkg/a/b/c.go",
      rootAbs: "/repo/pkg/a",
      language: "go",
      ...posixFs,
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
      ...posixFs,
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
      ...posixFs,
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
      ...posixFs,
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
      ...posixFs,
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
      ...posixFs,
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
      ...posixFs,
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
    const base = { fileAbs: "/repo/x.go", rootAbs: "/fallback", language: "go", ...posixFs, exists }
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

describe("工作区根细化", () => {
  test("Cargo workspace：成员 crate 让位给工作区根（否则每个成员各起一份 rust-analyzer）", () => {
    clearProjectRootCache()
    const files = {
      "/repo/rust/Cargo.toml": "[workspace]\nmembers = [\"framework\", \"torch\"]\n",
      "/repo/rust/framework/Cargo.toml": "[package]\nname = \"framework\"\nversion = \"0.1.0\"\n",
    }
    const info = detectProjectRoot({
      fileAbs: "/repo/rust/framework/src/lib.rs",
      rootAbs: "/repo/rust/framework/src",
      language: "rust",
      ...posixFs,
      ...fakeFsWithContent(files),
    })
    expect(info).toEqual({ abs: "/repo/rust", marker: "Cargo.toml", detected: true, levels: 2 })
  })

  test("非 workspace 的独立 crate：仍用最近的 Cargo.toml（不因上面碰巧有别的标记而漂移）", () => {
    clearProjectRootCache()
    const files = {
      "/repo/other/Cargo.toml": "[package]\nname = \"other\"\n",
      "/repo/app/Cargo.toml": "[package]\nname = \"app\"\n",
    }
    const info = detectProjectRoot({
      fileAbs: "/repo/app/src/main.rs",
      rootAbs: "/fallback",
      language: "rust",
      ...posixFs,
      ...fakeFsWithContent(files),
    })
    expect(info.abs).toBe("/repo/app")
    expect(info.marker).toBe("Cargo.toml")
  })

  test("go.work：多模块 Go 仓库共享一个 gopls", () => {
    clearProjectRootCache()
    const files = {
      "/repo/go.work": "go 1.21\nuse (\n\t./moda\n\t./modb\n)\n",
      "/repo/moda/go.mod": "module example.com/a\n",
    }
    const info = detectProjectRoot({
      fileAbs: "/repo/moda/pkg/a.go",
      rootAbs: "/repo/moda",
      language: "go",
      ...posixFs,
      ...fakeFsWithContent(files),
    })
    expect(info).toEqual({ abs: "/repo", marker: "go.work", detected: true, levels: 2 })
  })

  test("npm workspaces：monorepo 子包共享一个 typescript-language-server", () => {
    clearProjectRootCache()
    const files = {
      "/repo/package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "/repo/packages/web/package.json": JSON.stringify({ name: "web" }),
    }
    const info = detectProjectRoot({
      fileAbs: "/repo/packages/web/src/a.ts",
      rootAbs: "/repo/packages/web",
      language: "typescript",
      ...posixFs,
      ...fakeFsWithContent(files),
    })
    expect(info).toEqual({ abs: "/repo", marker: "package.json", detected: true, levels: 3 })
  })

  test("没有工作区概念的语言不做细化（Python/clangd 等仍取最近标记）", () => {
    clearProjectRootCache()
    const info = detectProjectRoot({
      fileAbs: "/repo/svc/tool.py",
      rootAbs: "/repo/svc",
      language: "python",
      ...posixFs,
      ...fakeFsWithContent({ "/repo/svc/pyproject.toml": "[project]\nname = \"svc\"\n", "/repo/package.json": JSON.stringify({ workspaces: ["x"] }) }),
    })
    expect(info.abs).toBe("/repo/svc")
    expect(info.marker).toBe("pyproject.toml")
  })

  test("工作区标记判定：Cargo [workspace] / go.work / package.json workspaces", () => {
    expect(isWorkspaceMarker("/a/Cargo.toml", "[workspace]\nmembers = []\n")).toBe(true)
    expect(isWorkspaceMarker("/a/Cargo.toml", "  [workspace.package]\nversion = \"1\"\n")).toBe(true)
    expect(isWorkspaceMarker("/a/Cargo.toml", "[package]\nname = \"x\"\n")).toBe(false)
    expect(isWorkspaceMarker("/a/go.work", "go 1.21\n")).toBe(true)
    expect(isWorkspaceMarker("/a/package.json", JSON.stringify({ workspaces: ["packages/*"] }))).toBe(true)
    expect(isWorkspaceMarker("/a/package.json", JSON.stringify({ workspaces: { packages: ["x"] } }))).toBe(true)
    expect(isWorkspaceMarker("/a/package.json", JSON.stringify({ name: "x" }))).toBe(false)
    expect(isWorkspaceMarker("/a/package.json", "{ 坏 JSON")).toBe(false)
    expect(isWorkspaceMarker("/a/compile_commands.json", "[workspace]")).toBe(false)
  })
})
