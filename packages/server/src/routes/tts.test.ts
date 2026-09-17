/**
 * 朗读路由用例：注入假合成服务（不真起 PowerShell），覆盖 REST 响应契约——
 * 成功返回 audio/wav 与状态头、参数错误返回 JSON 错误、可用性探测。
 */
import { afterAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { TtsService } from "../core/support/tts"
import type { RouteCtx } from "./context"
import { registerTtsRoutes, setTtsServiceForTest } from "./tts"

function makeApp(service: TtsService): Hono {
  const app = new Hono()
  registerTtsRoutes({ app, d: {} as never, userOf: () => ({ id: "default", role: "admin" }) as never, requireAdmin: () => null } as unknown as RouteCtx)
  setTtsServiceForTest(service)
  return app
}

const okService: TtsService = {
  synthesize: async () => ({ ok: true, wav: new Uint8Array([82, 73, 70, 70]), durationSec: 3.5, engine: "winrt", voice: "Microsoft Huihui", cached: false }),
  cacheStatus: () => ({ entries: 2, bytes: 1024 }),
}
const errService: TtsService = {
  synthesize: async () => ({ ok: false, error: "待合成文本为空（text 参数）。", status: 400 }),
  cacheStatus: () => ({ entries: 0, bytes: 0 }),
}

describe("POST /api/v1/tts", () => {
  test("成功：audio/wav 与时长/引擎/缓存头", async () => {
    const app = makeApp(okService)
    const res = await app.request("/api/v1/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("audio/wav")
    expect(res.headers.get("content-length")).toBe("4")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-gebai-tts")).toContain("engine=winrt")
    expect(res.headers.get("x-gebai-tts")).toContain("duration=3.5")
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(4)
  })

  test("合成失败：按状态码返回 JSON 错误", async () => {
    const app = makeApp(errService)
    const res = await app.request("/api/v1/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("待合成文本为空")
  })

  test("非法 JSON 请求体：400（不落到合成服务）", async () => {
    const app = makeApp(okService)
    const res = await app.request("/api/v1/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain("JSON")
  })

  test("请求体为 JSON 标量：400", async () => {
    const app = makeApp(okService)
    const res = await app.request("/api/v1/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: '"text"' })
    expect(res.status).toBe(400)
  })
})

describe("GET /api/v1/tts/status", () => {
  test("返回引擎可用性与缓存现状", async () => {
    const app = makeApp(okService)
    const res = await app.request("/api/v1/tts/status")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { available: boolean; cache: { entries: number; bytes: number } }
    expect(typeof body.available).toBe("boolean")
    expect(body.cache).toEqual({ entries: 2, bytes: 1024 })
  })
})

afterAll(() => setTtsServiceForTest())
