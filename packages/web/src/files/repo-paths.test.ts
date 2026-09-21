/**
 * 仓库相对 ↔ 根相对（`files/repo-paths.ts`）的单测。
 *
 * 这些换算错了不会报错：多了/少了前缀只会让「打开文件」404 或让日志过滤**静默空**，
 * 根外文件（整仓库范围下的改动）更是连表达都表达不出来。故把每条规则钉住。
 */
import { describe, expect, test } from "bun:test"
import { absOfRepo, normPath, relWithin, repoPrefixOfAbs, resolveAbsPath, resolveRepoPath, rootAbsFromId, toRepoRel } from "./repo-paths"

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

describe("resolveAbsPath（工作区外/库文件绝对路径 → 用哪个根打开）", () => {
  test("已有根覆盖它：直接用那个根（最长前缀优先，同长按类型优先级）", () => {
    const roots = [
      { id: "abs:/repo", kind: "abs", path: "/repo" },
      { id: "proj:gebai", kind: "proj", path: "/repo/packages" },
    ]
    expect(resolveAbsPath({ abs: "/repo/packages/web/a.ts", roots })).toEqual({ root: "proj:gebai", rel: "web/a.ts" })
    expect(resolveAbsPath({ abs: "/repo/tools/x.go", roots })).toEqual({ root: "abs:/repo", rel: "tools/x.go" })
    // 根本身：相对路径为空串
    expect(resolveAbsPath({ abs: "/repo/packages", roots })).toEqual({ root: "proj:gebai", rel: "" })
  })

  test("库锤点：标准库头归到一个 include 根（而不是每个目录各自成根）", () => {
    const a = resolveAbsPath({ abs: "/usr/include/c++/13/string", roots: [] })
    expect(a).toEqual({
      root: "abs:/usr/include",
      rel: "c++/13/string",
      create: { id: "abs:/usr/include", kind: "abs", name: "include", path: "/usr/include", writable: true },
    })
    // 同批的 vector 复用同一个根（根清单不被逐个目录刷屏）
    const b = resolveAbsPath({ abs: "/usr/include/c++/13/vector", roots: [] })
    expect(b?.root).toBe("abs:/usr/include")
    expect(b?.rel).toBe("c++/13/vector")
  })

  test("各类库形态的锤点（node_modules / site-packages / typeshed / rust library / GOROOT src）", () => {
    const anchorOf = (abs: string): string => resolveAbsPath({ abs, roots: [] })?.root ?? ""
    expect(anchorOf("/work/app/node_modules/monaco-editor/monaco.d.ts")).toBe("abs:/work/app/node_modules")
    expect(anchorOf("/usr/lib/python3/dist-packages/pip/_internal/x.py")).toBe("abs:/usr/lib/python3/dist-packages")
    expect(anchorOf("/root/.nvm/versions/node/v22/lib/node_modules/pyright/dist/typeshed-fallback/stdlib/os/__init__.pyi")).toBe(
      "abs:/root/.nvm/versions/node/v22/lib/node_modules/pyright/dist/typeshed-fallback",
    )
    expect(anchorOf("/root/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library/core/src/num/mod.rs")).toBe(
      "abs:/root/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/lib/rustlib/src/rust/library",
    )
    expect(anchorOf("/usr/local/go/src/fmt/print.go")).toBe("abs:/usr/local/go/src")
  })

  test("没有锤点：退到文件父目录（而不是往上一路漂到根）", () => {
    const r = resolveAbsPath({ abs: "/opt/sdk/1.2.3/lib/x.ext", roots: [] })
    expect(r?.root).toBe("abs:/opt/sdk/1.2.3/lib")
    expect(r?.rel).toBe("x.ext")
    expect(r?.create?.name).toBe("lib")
  })

  test("锤点限制层数：过深时不再向上碰运气，用父目录", () => {
    const deep = `/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/src/deep.txt`
    const r = resolveAbsPath({ abs: deep, roots: [] })
    expect(r?.create?.name).toBe("src") // 12 层内仍能命中 src；仅验证不会一直漂到 /
    const deeper = `/x/${Array.from({ length: 20 }, (_, i) => `l${i}`).join("/")}/f.txt`
    const r2 = resolveAbsPath({ abs: deeper, roots: [] })
    expect(r2?.create?.name).toBe("l19")
  })

  test("Windows：盘符路径大小写不敏感，根名与盘符形态正确", () => {
    const r = resolveAbsPath({ abs: "C:\\toolchain\\include\\vector", roots: [], isWin: true })
    expect(r?.root).toBe("abs:C:/toolchain/include")
    expect(r?.rel).toBe("vector")
    expect(r?.create?.path).toBe("C:/toolchain/include")
  })

  test("非绝对路径 / 空值：返回 null（调用方给提示，不拼必然 404 的路径）", () => {
    for (const bad of ["", "   ", "src/a.ts", "a.ts", "./x"]) {
      expect(resolveAbsPath({ abs: bad, roots: [] })).toBeNull()
    }
  })

  test("writable 透传到临时根；根内的相对路径反斜杠归正", () => {
    const r = resolveAbsPath({ abs: "/usr/include/c++/13/string", roots: [], writable: false })
    expect(r?.create?.writable).toBe(false)
    expect(r?.rel).toBe("c++/13/string")
  })
})
