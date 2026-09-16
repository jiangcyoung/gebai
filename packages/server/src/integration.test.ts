import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer, type ServerHandle } from "./index"
import { GebaiClient } from "@gebai/sdk"
import { sessionPath } from "./core/base/paths"

const home = mkdtempSync(join(tmpdir(), "gebai-http-"))
let handle: ServerHandle

beforeAll(async () => {
  process.env.GEBAI_HOME = home
  process.env.GEBAI_MODE = "local"
  process.env.GEBAI_SANDBOX = "off"
  handle = await startServer({ gebaiHome: home, auth: "local", sandbox: "off", binaryMode: false, preloadSubAgents: [], port: 0 })
})

afterAll(() => {
  handle.gc?.stop()
  handle.server.stop(true)
  delete process.env.GEBAI_HOME
  rmSync(home, { recursive: true, force: true })
})

function base() {
  return `http://127.0.0.1:${handle.server.port}`
}

describe("REST API", () => {
  test("health", async () => {
    const res = await fetch(`${base()}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  test("tools list includes global tools; sub-agent tools are lazily loaded", async () => {
    const res = await fetch(`${base()}/api/v1/tools`)
    const tools = (await res.json()) as Array<{ name: string; group: string }>
    expect(tools.some((t) => t.name === "read")).toBe(true)
    // 按需装载：默认不预装载子 Agent，其命名空间工具不出现在工具列表中
    expect(tools.some((t) => t.name === "code_read")).toBe(false)
  })

  test("sub-agents listed", async () => {
    const res = await fetch(`${base()}/api/v1/sub-agents`)
    const agents = (await res.json()) as Array<{ name: string }>
    expect(agents.some((a) => a.name === "code")).toBe(true)
  })

  test("session create/list/delete", async () => {
    const created = await (await fetch(`${base()}/api/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "smoke" }) })).json() as { id: string }
    expect(created.id).toBeTruthy()
    const list = await (await fetch(`${base()}/api/v1/sessions`)).json() as Array<{ id: string }>
    expect(list.some((s) => s.id === created.id)).toBe(true)
    const del = await fetch(`${base()}/api/v1/sessions/${created.id}`, { method: "DELETE" })
    expect(del.status).toBe(200)
  })

  test("session patch pinned（置顶/取消，列表归一返回）", async () => {
    const created = await (await fetch(`${base()}/api/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "pin" }) })).json() as { id: string }
    const res = await fetch(`${base()}/api/v1/sessions/${created.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }) })
    expect(res.status).toBe(200)
    const list = await (await fetch(`${base()}/api/v1/sessions`)).json() as Array<{ id: string; pinned?: boolean }>
    expect(list.find((s) => s.id === created.id)?.pinned).toBe(true)
    await fetch(`${base()}/api/v1/sessions/${created.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: false }) })
    const list2 = await (await fetch(`${base()}/api/v1/sessions`)).json() as Array<{ id: string; pinned?: boolean }>
    expect(list2.find((s) => s.id === created.id)?.pinned).toBe(false)
    await fetch(`${base()}/api/v1/sessions/${created.id}`, { method: "DELETE" })
  })

  test("files/content serves binary files intact (PNG bytes + image/png)", async () => {
    const created = await (await fetch(`${base()}/api/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "img" }) })).json() as { id: string }
    // 1x1 红色 PNG：验证二进制不被 text() 解码损坏（曾导致前端 <img> 无法显示）
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
    const dir = join(sessionPath(home, "admin", created.id), "tmp")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "pw_test.png"), png)
    const res = await fetch(`${base()}/api/v1/sessions/${created.id}/files/content?path=tmp/pw_test.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/png")
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(png.length)
    // PNG 魔数 89 50 4E 47 必须原样保留（text() 会将其替换为 EF BF BD）
    expect(Buffer.from(body.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a")
  })

  test("files/content 覆写同路径后不得脏读旧内容（no-cache + ETag 条件请求）", async () => {
    // 回归背景：产物 URL 只由路径决定，同名文件重写后 URL 不变。
    // 若不带 Cache-Control，浏览器按 Last-Modified 启发式缓存 → 重渲后的新内容看不到
    // （实际踩过：重渲同名静帧送审时用户看到的还是上一版）。
    const created = (await (await fetch(`${base()}/api/v1/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cache" }),
    })).json()) as { id: string }
    const dir = join(sessionPath(home, "admin", created.id), "tmp")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "same-name.txt")
    const url = `${base()}/api/v1/sessions/${created.id}/files/content?path=tmp/same-name.txt`

    writeFileSync(file, "第一版")
    const first = await fetch(url)
    expect(first.status).toBe(200)
    expect(await first.text()).toBe("第一版")
    // 必须显式禁止「新鲜期内直接复用」
    expect(first.headers.get("cache-control")).toBe("no-cache")
    const etag = first.headers.get("etag")
    expect(etag).toBeTruthy()

    // 内容未变 + 带上 ETag → 304（省流量，但不脏读）
    const revalidated = await fetch(url, { headers: { "if-none-match": etag! } })
    expect(revalidated.status).toBe(304)

    // 覆写同路径（mtime 前进，ETag 必变）→ 旧 ETag 不得再返回 304
    await new Promise((r) => setTimeout(r, 1100))
    writeFileSync(file, "第二版")
    const stale = await fetch(url, { headers: { "if-none-match": etag! } })
    expect(stale.status).toBe(200)
    expect(await stale.text()).toBe("第二版")
    expect(stale.headers.get("etag")).not.toBe(etag)
  })

  test("files/preview：会话相对路径以 tmp/ 为根，绝对路径（本地模式）放行，download=1 附件形式", async () => {
    const created = await (await fetch(`${base()}/api/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "pv" }) })).json() as { id: string }
    const dir = join(sessionPath(home, "admin", created.id), "tmp")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
    // 相对路径（tmp/ 前缀可省）
    const rel = await fetch(`${base()}/api/v1/sessions/${created.id}/files/preview?path=${encodeURIComponent("tmp/a.ts")}`)
    expect(rel.status).toBe(200)
    expect(await rel.text()).toContain("export const a = 1")
    // 绝对路径（本地模式操作者本人，与文件工具能力对齐——read 本地绝对路径场景）
    const abs = await fetch(`${base()}/api/v1/sessions/${created.id}/files/preview?path=${encodeURIComponent(join(dir, "a.ts"))}`)
    expect(abs.status).toBe(200)
    expect(await abs.text()).toContain("export const a = 1")
    // download=1 → Content-Disposition 附件（文件卡/chip 下载入口）
    const dl = await fetch(`${base()}/api/v1/sessions/${created.id}/files/preview?path=${encodeURIComponent("tmp/a.ts")}&download=1`)
    expect(dl.status).toBe(200)
    expect(dl.headers.get("content-disposition")).toContain("attachment")
    // 不存在的文件 → 404
    const miss = await fetch(`${base()}/api/v1/sessions/${created.id}/files/preview?path=tmp/nope.ts`)
    expect(miss.status).toBe(404)
  })

  test("files/preview render=office：docx 返回阅读视图 HTML（text/html），非 office 类型 422", async () => {
    const created = await (await fetch(`${base()}/api/v1/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "off" }) })).json() as { id: string }
    const dir = join(sessionPath(home, "admin", created.id), "tmp")
    mkdirSync(dir, { recursive: true })
    const { Document, Packer, Paragraph, HeadingLevel } = await import("docx")
    const doc = new Document({
      sections: [{ children: [new Paragraph({ text: "集成阅读视图标题", heading: HeadingLevel.HEADING_1 }), new Paragraph("正文段落")] }],
    })
    writeFileSync(join(dir, "r.docx"), await Packer.toBuffer(doc))
    writeFileSync(join(dir, "t.txt"), "plain")
    const res = await fetch(`${base()}/api/v1/sessions/${created.id}/files/preview?path=${encodeURIComponent("tmp/r.docx")}&render=office`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain("<h1>")
    expect(html).toContain("集成阅读视图标题")
    expect(html).toContain("正文段落")
    expect(html).toContain("阅读视图")
    // 非 office 扩展名：文件存在但无阅读视图形态 → 422（前端回退二进制占位）
    const bad = await fetch(`${base()}/api/v1/sessions/${created.id}/files/preview?path=${encodeURIComponent("tmp/t.txt")}&render=office`)
    expect(bad.status).toBe(422)
  })

  test("serves built web UI at / when present", async () => {
    const res = await fetch(`${base()}/`)
    if (res.status === 200) {
      const html = await res.text()
      expect(html).toContain("<html")
      // 服务端注入全局默认 UI 风格（GEBAI_UI_STYLE → __GEBAI_UI_STYLE__，白名单校验）
      expect(html).toContain("__GEBAI_UI_STYLE__=")
      expect(html).toMatch(/__GEBAI_UI_STYLE__="(acrylic|classic|aether|dark|modern|minimal|cyberpunk|aurora|synthwave|matrix|tokyo-night|cny)"/)
    } else {
      // web build not present in this environment; acceptable
      expect([404, 200]).toContain(res.status)
    }
  })

  test("websocket connects and handles a request via SDK", async () => {
    const client = new GebaiClient({ baseUrl: base() })
    await client.connect()
    const sessions = await client.listSessions()
    expect(Array.isArray(sessions)).toBe(true)
  })
})
