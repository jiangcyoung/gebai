/**
 * LSP 服务层测试（会话池）：**复用键取工程根而非工作台根**、应答里的 `uri`/`projectRoot`/`projectMarker`、
 * docId 归属与请求转发、空闲回收与并发上限。
 *
 * 用假 spawner（不起真实服务器）：这里验的是「池与归属」，进程内的协议细节由 `session.test.ts` 覆盖。
 */
import { describe, expect, test } from "bun:test"
import { FrameReader, encodeFrame } from "./protocol"
import { LspService, rewriteDocUris, withDocumentUri } from "./service"
import { clearProjectRootCache } from "./project-root"
import type { LspProc, LspSpawnInput, LspSpawner } from "./session"

/** 假服务器：只应答 initialize（能力里给 documentSymbol 与 completion），其余请求回 null。 */
function fakeSpawner(): { spawner: LspSpawner; spawned: LspSpawnInput[]; ready: () => Promise<void> } {
  const spawned: LspSpawnInput[] = []
  const pendingReady: Array<() => void> = []
  const spawner: LspSpawner = (input) => {
    spawned.push(input)
    const reader = new FrameReader()
    const proc: LspProc = {
      pid: 1000 + spawned.length,
      write: (data) => {
        for (const body of reader.push(data)) {
          const msg = JSON.parse(body) as { id?: number; method?: string }
          if (msg.method === "initialize") {
            input.onStdout(
              encodeFrame({
                jsonrpc: "2.0",
                id: msg.id,
                result: { capabilities: { textDocumentSync: 1, documentSymbolProvider: true, completionProvider: {} } },
              }).toString("utf8"),
            )
            pendingReady.shift()?.()
          } else if (msg.method === "shutdown") {
            input.onStdout(encodeFrame({ jsonrpc: "2.0", id: msg.id, result: null }).toString("utf8"))
          } else if (msg.id !== undefined) {
            input.onStdout(encodeFrame({ jsonrpc: "2.0", id: msg.id, result: null }).toString("utf8"))
          }
        }
      },
      kill: () => {},
    }
    return proc
  }
  return {
    spawner,
    spawned,
    ready: () => new Promise<void>((resolve) => pendingReady.push(resolve)),
  }
}

const OPEN_BASE = {
  user: "u1",
  rootId: "proj:demo",
  rootAbs: "/repo/pkg/inner",
  language: "go",
  text: "package main\n",
  version: 1,
}

/** 只认这些工程标记路径存在。 */
const markers = (files: string[]) => {
  const set = new Set(files)
  return (p: string) => set.has(p)
}

describe("LSP 服务：工程根与会话池", () => {
  test("工程根向上探测：会话 cwd/rootUri 用工程根，应答带回 projectRoot 与 uri", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({
      which: () => "/usr/bin/gopls",
      spawner: fake.spawner,
      projectMarkerExists: markers(["/repo/go.mod"]),
    })
    const res = await svc.open({ ...OPEN_BASE, path: "cmd/main.go", absPath: "/repo/pkg/inner/cmd/main.go" })
    expect(res.available).toBe(true)
    if (!res.available) return
    expect(res.projectRoot).toBe("/repo")
    expect(res.projectMarker).toBe("go.mod")
    expect(res.uri).toBe("file:///repo/pkg/inner/cmd/main.go")
    // 进程 cwd 用工程根（不是工作台根）；rootUri / workspaceFolders 也由会话层按它生成
    expect(fake.spawned[0]?.cwd).toBe("/repo")
    // 工作台根照旧回给前端（它据此把 file uri 折算回根内相对路径）
    expect(res.root).toEqual({ id: "proj:demo", abs: "/repo/pkg/inner" })
    svc.dispose()
  })

  test("同一工程的两个工作台根共用同一个服务器进程（复用键 = 工程根）", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({
      which: () => "/usr/bin/gopls",
      spawner: fake.spawner,
      projectMarkerExists: markers(["/repo/go.mod"]),
    })
    const first = await svc.open({ ...OPEN_BASE, path: "cmd/main.go", absPath: "/repo/pkg/inner/cmd/main.go" })
    // 另一个根（同工程、另一个目录）打开文件：不应再拉进程
    const second = await svc.open({
      ...OPEN_BASE,
      rootId: "sess:abc",
      rootAbs: "/repo/other",
      path: "other/x.go",
      absPath: "/repo/other/x.go",
    })
    expect(first.available && second.available).toBe(true)
    if (!first.available || !second.available) return
    expect(fake.spawned).toHaveLength(1)
    expect(first.session).toBe(second.session)
    expect(second.created).toBe(false)
    expect(svc.list()).toHaveLength(1)
    expect(svc.list()[0]?.docs).toBe(2)
    svc.dispose()
  })

  test("不同工程各自起进程（不误共享）", async () => {    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({
      which: () => "/usr/bin/gopls",
      spawner: fake.spawner,
      projectMarkerExists: markers(["/repo/go.mod", "/repo/mod2/go.mod"]),
    })
    const a = await svc.open({ ...OPEN_BASE, path: "a.go", absPath: "/repo/a.go" })
    const b = await svc.open({ ...OPEN_BASE, path: "b.go", absPath: "/repo/mod2/b.go" })
    expect(a.available && b.available).toBe(true)
    expect(fake.spawned).toHaveLength(2)
    expect(fake.spawned.map((s) => s.cwd).sort()).toEqual(["/repo", "/repo/mod2"])
    svc.dispose()
  })

  test("无工程标记：回落到工作台根（行为与从前一致）", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({ which: () => "/usr/bin/gopls", spawner: fake.spawner, projectMarkerExists: () => false })
    const res = await svc.open({ ...OPEN_BASE, path: "a.go", absPath: "/repo/pkg/inner/a.go" })
    expect(res.available).toBe(true)
    if (!res.available) return
    expect(res.projectRoot).toBe("/repo/pkg/inner")
    expect(res.projectMarker).toBe("")
    expect(fake.spawned[0]?.cwd).toBe("/repo/pkg/inner")
    svc.dispose()
  })

  test("请求转发：未打开的 docId 显式报错；已打开的走对应会话", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({ which: () => "/usr/bin/gopls", spawner: fake.spawner, projectMarkerExists: () => false })
    const res = await svc.open({ ...OPEN_BASE, path: "a.go", absPath: "/repo/a.go" })
    if (!res.available) throw new Error("应当可用")
    await expect(svc.request("u1", "不存在", "textDocument/hover", {})).rejects.toThrow("未打开")
    // 另一个用户拿不到别人的文档（前端拿不到 docId，但服务端仍须按用户校验）
    await expect(svc.request("u2", res.docId, "textDocument/hover", {})).rejects.toThrow("未打开")
    expect(await svc.request("u1", res.docId, "textDocument/hover", {})).toBeNull()
    svc.dispose()
  })

  test("并发上限：无文档的空闲会话先被回收，仍满则明确拒绝", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({
      which: () => "/usr/bin/gopls",
      spawner: fake.spawner,
      // 四个工程各有自己的 go.mod（工程根不同 → 各自一个会话）
      projectMarkerExists: markers(["/r1/go.mod", "/r2/go.mod", "/r3/go.mod", "/r4/go.mod"]),
      maxSessions: 2,
    })
    const a = await svc.open({ ...OPEN_BASE, rootAbs: "/r1", path: "a.go", absPath: "/r1/a.go" })
    const b = await svc.open({ ...OPEN_BASE, rootAbs: "/r2", path: "b.go", absPath: "/r2/b.go" })
    if (!a.available || !b.available) throw new Error("前两个应当可用")
    // 关掉第一个文档 → 它的会话成为空闲会话；再开第三个（新工程）应回收空闲会话而不是拒绝
    svc.close("u1", a.docId)
    const c = await svc.open({ ...OPEN_BASE, rootAbs: "/r3", path: "c.go", absPath: "/r3/c.go" })
    expect(c.available).toBe(true)
    // 回收的是空闲会话（/r1），保留的是两个有文档的会话
    expect(svc.list().map((s) => s.root).sort()).toEqual(["/r2", "/r3"])
    // 上限已满且两个会话都有打开文档 → 第四个被拒（reason 说明上限）
    const d = await svc.open({ ...OPEN_BASE, rootAbs: "/r4", path: "d.go", absPath: "/r4/d.go" })
    expect(d.available).toBe(false)
    if (!d.available) expect(d.reason).toContain("上限")
    svc.dispose()
  })
})

describe("LSP 服务：跨到工作区外的库文件（attachTo 复用会话）", () => {
  test("库文件挂到来源文档的会话上：不新建进程、沿用工程根", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({
      which: () => "/usr/bin/gopls",
      spawner: fake.spawner,
      projectMarkerExists: markers(["/repo/go.mod"]),
    })
    const src = await svc.open({ ...OPEN_BASE, path: "a.go", absPath: "/repo/a.go" })
    if (!src.available) throw new Error("来源文档应当可用")
    // 跳到 GOROOT 标准库（工作区外，只有一条 abs: 临时根）
    const lib = await svc.open({
      ...OPEN_BASE,
      rootId: "abs:/usr/local/go/src",
      rootAbs: "/usr/local/go/src",
      path: "fmt/print.go",
      absPath: "/usr/local/go/src/fmt/print.go",
      attachTo: src.docId,
    })
    expect(lib.available).toBe(true)
    if (!lib.available) return
    // 没有新进程、同一个会话、工程根仍是来源工程（而不是 /usr/local/go/src）
    expect(fake.spawned).toHaveLength(1)
    expect(lib.session).toBe(src.session)
    expect(lib.created).toBe(false)
    expect(lib.projectRoot).toBe("/repo")
    expect(lib.projectMarker).toBe("go.mod")
    expect(lib.uri).toBe("file:///usr/local/go/src/fmt/print.go")
    expect(svc.list()).toHaveLength(1)
    expect(svc.list()[0]?.docs).toBe(2)
    // 库文件也能正常发请求（同一个会话）
    await expect(svc.request("u1", lib.docId, "textDocument/hover", { position: { line: 0, character: 0 } })).resolves.toBeNull()
    svc.dispose()
  })

  test("三道门槛：跨用户、跨服务器、会话已死都不复用（回退到正常建会话）", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({ which: () => "/usr/bin/gopls", spawner: fake.spawner, projectMarkerExists: () => false })
    const src = await svc.open({ ...OPEN_BASE, path: "a.go", absPath: "/repo/a.go" })
    if (!src.available) throw new Error("来源文档应当可用")
    expect(fake.spawned).toHaveLength(1)

    // ① 跨用户：别人的 docId 不能借
    const other = await svc.open({
      ...OPEN_BASE,
      user: "u2",
      rootId: "abs:/usr/include",
      rootAbs: "/usr/include",
      path: "fmt.go",
      absPath: "/usr/include/fmt.go",
      attachTo: src.docId,
    })
    if (!other.available) throw new Error("应当自己建会话")
    expect(other.session).not.toBe(src.session)
    expect(fake.spawned).toHaveLength(2)

    // ② 跨服务器：c 头文件（clangd）不能挂到 go 会话上
    svc.dispose()
    const fake2 = fakeSpawner()
    const multi = new LspService({
      which: (cmd) => (cmd === "gopls" ? "/usr/bin/gopls" : cmd === "clangd" ? "/usr/bin/clangd" : null),
      spawner: fake2.spawner,
      projectMarkerExists: () => false,
    })
    const g = await multi.open({ user: "u1", rootId: "abs:/repo", rootAbs: "/repo", path: "a.go", absPath: "/repo/a.go", language: "go", text: "", version: 1 })
    if (!g.available) throw new Error("go 应当可用")
    const c = await multi.open({
      user: "u1",
      rootId: "abs:/usr/include",
      rootAbs: "/usr/include",
      path: "stdlib.h",
      absPath: "/usr/include/stdlib.h",
      language: "c",
      text: "",
      version: 1,
      attachTo: g.docId,
    })
    expect(c.available).toBe(true)
    if (!c.available) return
    expect(c.session).not.toBe(g.session)
    expect(fake2.spawned).toHaveLength(2)

    // ③ 会话已死（文档已关）：不复用，自己起一个
    multi.close("u1", g.docId)
    const afterClose = await multi.open({
      user: "u1",
      rootId: "abs:/usr/include",
      rootAbs: "/usr/include",
      path: "x.h",
      absPath: "/usr/include/x.h",
      language: "c",
      text: "",
      version: 1,
      attachTo: g.docId,
    })
    expect(afterClose.available).toBe(true)
    multi.dispose()
  })

  test("attachTo 指向不存在的 docId：静默回退到正常路径（不报错）", async () => {
    clearProjectRootCache()
    const fake = fakeSpawner()
    const svc = new LspService({ which: () => "/usr/bin/gopls", spawner: fake.spawner, projectMarkerExists: () => false })
    const res = await svc.open({ ...OPEN_BASE, path: "a.go", absPath: "/repo/a.go", attachTo: "d不存在" })
    expect(res.available).toBe(true)
    expect(fake.spawned).toHaveLength(1)
    svc.dispose()
  })
})

describe("LSP 服务：请求参数归一", () => {
  test("textDocument/* 缺少 textDocument.uri 时补上 docId（缺了服务器会直接报错）", () => {
    expect(withDocumentUri("textDocument/hover", { position: { line: 0, character: 0 } }, "d1")).toEqual({
      position: { line: 0, character: 0 },
      textDocument: { uri: "d1" },
    })
    // 已有 uri 不动；同一层里的其它字段保留
    expect(withDocumentUri("textDocument/hover", { textDocument: { uri: "d1" } }, "d2")).toEqual({ textDocument: { uri: "d1" } })
    expect(withDocumentUri("textDocument/references", { textDocument: { uri: "d1", version: 3 } }, "d2")).toEqual({
      textDocument: { uri: "d1", version: 3 },
    })
    // 非 textDocument 方法不动；非对象参数安全降级
    expect(withDocumentUri("workspace/symbol", { query: "x" }, "d1")).toEqual({ query: "x" })
    expect(withDocumentUri("textDocument/documentSymbol", undefined, "d1")).toEqual({ textDocument: { uri: "d1" } })
    expect(withDocumentUri("completionItem/resolve", null, "d1")).toEqual({})
  })

  test("rewriteDocUris：只把 uri 字段上的 docId 换成真实 file uri（递归）", () => {
    const params = { textDocument: { uri: "d1" }, position: { line: 1 }, items: [{ uri: "d1" }, { uri: "other" }] }
    expect(rewriteDocUris(params, "d1", "file:///a/b.go")).toEqual({
      textDocument: { uri: "file:///a/b.go" },
      position: { line: 1 },
      items: [{ uri: "file:///a/b.go" }, { uri: "other" }],
    })
  })
})
