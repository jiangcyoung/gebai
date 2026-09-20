/**
 * LSP 会话测试：用**假服务器进程**（不起真实语言服务器）验 initialize 握手、文档同步、
 * 请求关联、服务器反向请求兜底应答、诊断上行、进程退出与 dispose 收尾。
 */
import { describe, expect, test } from "bun:test"
import { FrameReader, encodeFrame } from "./protocol"
import { LspSession, normalizeSyncKind, pathToFileUri, uriKey, type LspSessionEvent, type LspSpawner } from "./session"
import type { LspServerPick } from "./registry"

const SERVER: LspServerPick = { language: "rust", id: "rust-analyzer", command: "/usr/bin/rust-analyzer", args: [] }

interface Wire {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

/** 假语言服务器：解析会话写来的帧并按方法应答；`received` 记收到的报文、`sent` 记发出的报文。 */
function fakeServer(opts: { sync?: 0 | 1 | 2; onRequest?: (msg: Wire, emit: (msg: unknown) => void) => boolean } = {}) {
  const received: Wire[] = []
  const sent: unknown[] = []
  const reader = new FrameReader()
  let emit: (msg: unknown) => void = () => {}
  let rawOut: (text: string) => void = () => {}
  let exitFn: (code: number | null) => void = () => {}
  let killed = 0
  const spawner: LspSpawner = (input) => {
    exitFn = input.onExit
    rawOut = input.onStdout
    emit = (msg) => {
      sent.push(msg)
      input.onStdout(encodeFrame(msg).toString("utf8"))
    }
    return {
      pid: 4321,
      write: (data) => {
        for (const body of reader.push(data)) {
          const msg = JSON.parse(body) as Wire
          received.push(msg)
          if (msg.method === "initialize") {
            emit({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: { change: opts.sync ?? 1 } } } })
            continue
          }
          if (msg.method === "shutdown") {
            emit({ jsonrpc: "2.0", id: msg.id, result: null })
            continue
          }
          opts.onRequest?.(msg, emit)
        }
      },
      kill: () => {
        killed += 1
      },
    }
  }
  return {
    spawner,
    received,
    sent,
    killCount: () => killed,
    emit: (msg: unknown) => emit(msg),
    /** 模拟服务器进程自行退出。 */
    exit: (code: number | null) => exitFn(code),
    /** 直接向会话喂原始 stdout 文本（脏输出 / 半截帧用）。 */
    raw: (text: string) => rawOut(text),
  }
}

/** 起一个会话（默认 1s 请求超时，测试里按需缩短）。 */
async function startSession(fake: ReturnType<typeof fakeServer>, events: LspSessionEvent[] = []): Promise<LspSession> {
  const session = new LspSession({
    rootAbs: process.platform === "win32" ? "C:\\work\\proj" : "/work/proj",
    server: SERVER,
    spawner: fake.spawner,
    onEvent: (e) => events.push(e),
  })
  await session.start()
  return session
}

const DOC = {
  docId: "d1",
  absPath: process.platform === "win32" ? "C:\\work\\proj\\src\\main.rs" : "/work/proj/src/main.rs",
  language: "rust",
  text: "fn main() {}",
  version: 1,
}

describe("LSP 会话：握手与能力", () => {
  test("initialize 带 rootUri / workspaceFolders，随后发 initialized 通知", async () => {
    const fake = fakeServer({ sync: 2 })
    const session = await startSession(fake)
    const init = fake.received.find((m) => m.method === "initialize")
    expect(init?.params?.["rootUri"]).toBe(pathToFileUri(session.rootAbs))
    expect((init?.params?.["workspaceFolders"] as Array<{ uri: string }>)[0]?.uri).toBe(pathToFileUri(session.rootAbs))
    expect(init?.params?.["processId"]).toBe(process.pid)
    // 能力声明里**不**声明 workspace.workspaceFolders：实测 pyright 声明后会挂起分析准备（补全/悬停/定义全不应答）
    const caps = init?.params?.["capabilities"] as { workspace?: Record<string, unknown> } | undefined
    expect(caps?.workspace?.workspaceFolders).toBeUndefined()
    expect(fake.received.some((m) => m.method === "initialized")).toBe(true)
    expect(session.sync).toBe(2)
    expect(session.alive).toBe(true)
    session.dispose()
  })

  test("textDocumentSync 归一化：数字 / 对象 / 缺失", () => {
    expect(normalizeSyncKind(2)).toBe(2)
    expect(normalizeSyncKind({ change: 0 })).toBe(0)
    expect(normalizeSyncKind({ openClose: true })).toBe(1)
    expect(normalizeSyncKind(undefined)).toBe(1)
  })

  test("pathToFileUri：Windows 盘符、空格与反斜杠", () => {
    expect(pathToFileUri("C:\\work a\\src\\main.rs")).toBe("file:///C:/work%20a/src/main.rs")
    expect(pathToFileUri("/work/src/a.ts")).toBe("file:///work/src/a.ts")
  })
})

describe("LSP 会话：文档同步", () => {
  test("didOpen 带 file uri / languageId / version / 全文", async () => {
    const fake = fakeServer()
    const session = await startSession(fake)
    session.openDocument(DOC)
    const open = fake.received.find((m) => m.method === "textDocument/didOpen")
    const td = open?.params?.["textDocument"] as { uri: string; languageId: string; version: number; text: string }
    expect(td.uri).toBe(pathToFileUri(DOC.absPath))
    expect(td.languageId).toBe("rust")
    expect(td.version).toBe(1)
    expect(td.text).toBe("fn main() {}")
    expect(session.documents).toHaveLength(1)
    session.dispose()
  })

  test("didChange 全量替换 + didSave + didClose", async () => {
    const fake = fakeServer()
    const session = await startSession(fake)
    session.openDocument(DOC)
    session.changeDocument("d1", 2, "fn main() { let x = 1; }")
    session.saveDocument("d1")
    session.closeDocument("d1")
    const change = fake.received.find((m) => m.method === "textDocument/didChange")
    expect((change?.params?.["contentChanges"] as Array<{ text: string }>)[0]?.text).toBe("fn main() { let x = 1; }")
    expect((change?.params?.["textDocument"] as { version: number }).version).toBe(2)
    expect(fake.received.some((m) => m.method === "textDocument/didSave")).toBe(true)
    expect(fake.received.some((m) => m.method === "textDocument/didClose")).toBe(true)
    expect(session.documents).toHaveLength(0)
    session.dispose()
  })

  test("服务器声明不同步（change=0）时不下发 didOpen / didChange", async () => {
    const fake = fakeServer({ sync: 0 })
    const session = await startSession(fake)
    session.openDocument(DOC)
    session.changeDocument("d1", 2, "x")
    expect(fake.received.some((m) => m.method === "textDocument/didOpen")).toBe(false)
    expect(fake.received.some((m) => m.method === "textDocument/didChange")).toBe(false)
    session.dispose()
  })

  test("未登记的 docId 变更被忽略（不误伤别的文档）", async () => {
    const fake = fakeServer()
    const session = await startSession(fake)
    session.openDocument(DOC)
    session.changeDocument("nope", 3, "x")
    expect(fake.received.filter((m) => m.method === "textDocument/didChange")).toHaveLength(0)
    session.dispose()
  })
})

describe("LSP 会话：请求与通知", () => {
  test("请求按 id 关联应答", async () => {
    const fake = fakeServer({
      onRequest: (msg, emit) => {
        if (msg.method !== "textDocument/hover") return false
        emit({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "**hi**" } } })
        return true
      },
    })
    const session = await startSession(fake)
    session.openDocument(DOC)
    const result = (await session.request("textDocument/hover", { textDocument: { uri: "d1" }, position: { line: 0, character: 0 } })) as { contents: { value: string } }
    expect(result.contents.value).toBe("**hi**")
    session.dispose()
  })

  test("服务器反向请求被兜底应答（workspace/configuration → 逐项 null）", async () => {
    const fake = fakeServer({
      onRequest: (msg, emit) => {
        if (msg.method !== "textDocument/hover") return false
        // 一次往返里既让服务器发出反向请求，也对原请求给出应答（否则用例要等到超时）
        emit({ jsonrpc: "2.0", id: 99, method: "workspace/configuration", params: { items: [{ section: "rust-analyzer" }] } })
        emit({ jsonrpc: "2.0", id: msg.id, result: null })
        return true
      },
    })
    const session = await startSession(fake)
    session.openDocument(DOC)
    await session.request("textDocument/hover", {}) // 一次往返，触发假服务器发出反向请求
    const answer = fake.received.find((m) => m.id === 99 && m.method === undefined)
    expect((answer as { result?: unknown }).result).toEqual([null])
    session.dispose()
  })

  test("请求超时（服务器不应答）显式失败，不挂死调用方", async () => {
    const fake = fakeServer()
    const session = new LspSession({
      rootAbs: process.platform === "win32" ? "C:\\work" : "/work",
      server: SERVER,
      spawner: fake.spawner,
      requestTimeoutMs: 60,
    })
    await session.start()
    session.openDocument(DOC)
    await expect(session.request("textDocument/completion", {})).rejects.toThrow("超时")
    session.dispose()
  })
})

describe("LSP 会话：生命周期收尾", () => {
  test("服务器自行退出：置 alive=false、拒绝在途请求、上行 exit 事件", async () => {
    const fake = fakeServer()
    const events: LspSessionEvent[] = []
    const session = await startSession(fake, events)
    session.openDocument(DOC)
    const inflight = session.request("textDocument/hover", {})
    fake.exit(1)
    await expect(inflight).rejects.toThrow("语言服务器已退出")
    expect(session.alive).toBe(false)
    expect(events.some((e) => e.type === "exit" && e.code === 1)).toBe(true)
  })

  test("dispose：尽力发 shutdown / exit 并杀进程", async () => {
    const fake = fakeServer()
    const session = await startSession(fake)
    session.openDocument(DOC)
    session.dispose()
    expect(fake.received.some((m) => m.method === "shutdown")).toBe(true)
    expect(fake.received.some((m) => m.method === "exit")).toBe(true)
    expect(fake.killCount()).toBe(1)
    expect(session.alive).toBe(false)
  })
})

describe("LSP 会话：诊断上行", () => {
  test("publishDiagnostics 的 file uri 换成 docId（且只推已登记文档）", async () => {
    const fake = fakeServer()
    const events: LspSessionEvent[] = []
    const session = await startSession(fake, events)
    session.openDocument(DOC)
    fake.emit({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri: pathToFileUri(DOC.absPath), diagnostics: [{ message: "m", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] },
    })
    const notify = events.find((e) => e.type === "notify") as Extract<LspSessionEvent, { type: "notify" }> | undefined
    expect(notify?.method).toBe("textDocument/publishDiagnostics")
    expect(notify?.params.uri).toBe("d1")
    // 未登记文件的诊断被丢弃（避免前端拿到不认识的 uri）
    fake.emit({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///elsewhere/x.rs", diagnostics: [] } })
    expect(events.filter((e) => e.type === "notify")).toHaveLength(1)
    session.dispose()
  })

  test("服务器用自己规范化的 uri（小写盘符 + 编码冒号）回诊断也能命中登记文档", async () => {
    const fake = fakeServer()
    const events: LspSessionEvent[] = []
    const session = await startSession(fake, events)
    session.openDocument(DOC)
    const weird = process.platform === "win32" ? "file:///c%3A/work/proj/src/main.rs" : pathToFileUri(DOC.absPath)
    fake.emit({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: weird, diagnostics: [] } })
    expect(events.filter((e) => e.type === "notify")).toHaveLength(1)
    session.dispose()
  })

  test("uriKey：盘符大小写与百分号编码归一，非 file 协议原样保留", () => {
    expect(uriKey("file:///C:/a/b.rs")).toBe(uriKey("file:///c%3A/a/b.rs"))
    expect(uriKey("file:///x/A%20B.ts")).toBe(uriKey("file:///x/A B.ts"))
    expect(uriKey("http://x/y")).toBe("http://x/y")
  })

  test("window/logMessage 进日志事件", async () => {
    const fake = fakeServer()
    const events: LspSessionEvent[] = []
    const session = await startSession(fake, events)
    fake.emit({ jsonrpc: "2.0", method: "window/logMessage", params: { message: "indexing" } })
    expect(events.some((e) => e.type === "log" && e.text.includes("indexing"))).toBe(true)
    session.dispose()
  })

  test("非 JSON 报文进 stderr 尾部，不中断会话", async () => {
    const fake = fakeServer()
    const events: LspSessionEvent[] = []
    const session = await startSession(fake, events)
    fake.raw(encodeFrame("not-json").toString("utf8"))
    expect(session.stderr).toContain("非 JSON 报文")
    expect(session.alive).toBe(true)
    session.dispose()
  })
})
