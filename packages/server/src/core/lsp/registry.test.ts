/** LSP 注册表测试：内置表探测、GEBAI_LSP_SERVERS 覆盖（字符串/对象/数组/null）、opt-in 语言的启用条件。 */
import { describe, expect, test } from "bun:test"
import { resolveRegistry, serverDefs, serverForLanguage, type LspServerPick } from "./registry"

/** 假探测表：只有列出的命令算「装了」。 */
const probeWith = (installed: Record<string, string>) => (cmd: string) => installed[cmd] ?? null

const LANGS = (picks: LspServerPick[]) => picks.map((p) => p.language).sort()

describe("LSP 注册表：内置表与探测", () => {
  test("装了哪些就报哪些，未装的进 missing", () => {
    const reg = resolveRegistry({
      which: probeWith({ gopls: "/usr/bin/gopls", clangd: "/usr/bin/clangd" }),
    })
    expect(LANGS(reg.picks)).toEqual(["c", "cpp", "go", "objective-c"])
    expect(serverForLanguage(reg, "go")?.command).toBe("/usr/bin/gopls")
    expect(serverForLanguage(reg, "rust")).toBeUndefined()
    expect(reg.missing.map((m) => m.language)).toContain("rust")
    expect(reg.errors).toEqual([])
  })

  test("一个服务器服务多语言时共用同一份探测结果（clangd → c/cpp/objective-c）", () => {
    const reg = resolveRegistry({ which: probeWith({ clangd: "/usr/bin/clangd" }) })
    expect(serverForLanguage(reg, "c")?.id).toBe("clangd")
    expect(serverForLanguage(reg, "cpp")?.command).toBe("/usr/bin/clangd")
  })

  test("同语言多候选取首个命中（pyright 优先于 pylsp）", () => {
    const onlyPylsp = resolveRegistry({ which: probeWith({ pylsp: "/usr/bin/pylsp" }) })
    expect(serverForLanguage(onlyPylsp, "python")?.id).toBe("pylsp")
    const both = resolveRegistry({ which: probeWith({ pylsp: "/usr/bin/pylsp", "pyright-langserver": "/usr/bin/pyright-langserver" }) })
    expect(serverForLanguage(both, "python")?.id).toBe("pyright")
    expect(serverForLanguage(both, "python")?.args).toEqual(["--stdio"])
  })

  test("Monaco 已覆盖的语言默认不启用（opt-in），显式配置才起外部服务器", () => {
    const which = probeWith({ "typescript-language-server": "/usr/bin/tls", "vscode-json-language-server": "/usr/bin/jsonls" })
    const def = resolveRegistry({ which })
    expect(LANGS(def.picks)).toEqual([])
    const optIn = resolveRegistry({ overrides: { json: { command: "vscode-json-language-server", args: ["--stdio"] } }, which })
    expect(serverForLanguage(optIn, "json")?.command).toBe("/usr/bin/jsonls")
    expect(serverForLanguage(optIn, "typescript")).toBeUndefined()
  })
})

describe("LSP 注册表：GEBAI_LSP_SERVERS 覆盖", () => {
  test("字符串值 = 命令；对象值 = command + args + id", () => {
    const reg = resolveRegistry({
      overrides: { go: "/opt/go/bin/gopls", rust: { command: "rust-analyzer", args: ["--log-file", "ra.log"], id: "ra" } },
      which: probeWith({ "/opt/go/bin/gopls": "/opt/go/bin/gopls", "rust-analyzer": "/usr/bin/rust-analyzer" }),
    })
    expect(serverForLanguage(reg, "go")?.command).toBe("/opt/go/bin/gopls")
    expect(serverForLanguage(reg, "rust")?.id).toBe("ra")
    expect(serverForLanguage(reg, "rust")?.args).toEqual(["--log-file", "ra.log"])
  })

  test("数组值 = 多候选按序探测；覆盖**替换**该语言的内置候选", () => {
    const reg = resolveRegistry({
      overrides: { python: [{ command: "mypy-ls", args: [] }, "pylsp"] },
      which: probeWith({ "pylsp": "/usr/bin/pylsp" }),
    })
    expect(serverForLanguage(reg, "python")?.id).toBe("pylsp")
    // 内置的 pyright 候选已被覆盖移除：即使装了也不会选它
    const withPyright = resolveRegistry({
      overrides: { python: [{ command: "mypy-ls", args: [] }, "pylsp"] },
      which: probeWith({ "pyright-langserver": "/usr/bin/pyright", "pylsp": "/usr/bin/pylsp" }),
    })
    expect(serverForLanguage(withPyright, "python")?.id).toBe("pylsp")
  })

  test("null / false = 关闭该语言（不再探测）", () => {
    const reg = resolveRegistry({ overrides: { go: null, rust: false }, which: probeWith({ gopls: "/usr/bin/gopls", "rust-analyzer": "/usr/bin/rust-analyzer" }) })
    expect(serverForLanguage(reg, "go")).toBeUndefined()
    expect(serverForLanguage(reg, "rust")).toBeUndefined()
    expect(reg.missing.map((m) => m.language)).not.toContain("go")
  })

  test("非法 JSON / 非法项记入 errors，不阻断其它语言", () => {
    const bad = resolveRegistry({ overrides: "{不是 JSON", which: probeWith({ gopls: "/usr/bin/gopls" }) })
    expect(bad.errors[0]).toContain("不是合法 JSON")
    expect(serverForLanguage(bad, "go")?.command).toBe("/usr/bin/gopls")

    const partial = resolveRegistry({ overrides: { go: {}, rust: { command: "rust-analyzer" } }, which: probeWith({ "rust-analyzer": "/usr/bin/rust-analyzer" }) })
    expect(partial.errors.some((e) => e.startsWith("go:"))).toBe(true)
    expect(serverForLanguage(partial, "rust")?.id).toBe("rust-analyzer")
  })

  test("语言 id 大小写归一（Monaco 语言 id 全小写）", () => {
    const reg = resolveRegistry({ overrides: { Go: "/opt/gopls" }, which: probeWith({ "/opt/gopls": "/opt/gopls" }) })
    expect(serverForLanguage(reg, "go")?.command).toBe("/opt/gopls")
  })

  test("serverDefs：覆盖项只影响对应语言，其余保留内置顺序", () => {
    const { defs } = serverDefs({ go: "/opt/gopls" })
    const goDefs = defs.filter((d) => d.languages.includes("go"))
    expect(goDefs).toHaveLength(1)
    expect(goDefs[0]?.command).toBe("/opt/gopls")
    expect(defs.some((d) => d.id === "rust-analyzer")).toBe(true)
  })
})
