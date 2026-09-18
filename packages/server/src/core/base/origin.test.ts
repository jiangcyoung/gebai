/**
 * 同源判定（`originAllowed`）用例：REST CORS 中间件与 WS 升级共用同一函数，故两侧口径由本文件锁定
 * ——纯函数用例 + REST 中间件的真实请求用例（WS 侧由同一函数驱动，行为等价）。
 */
import { describe, expect, test } from "bun:test"
import { originAllowed } from "./origin"
import { createApp, SERVICE_USER, type AppDeps } from "../../app"
import type { ServerConfig } from "./config"

const local = { auth: "local" }
const server = { auth: "server" }

describe("originAllowed：同源判定（豁免面）", () => {
  test("无 Origin：非浏览器客户端放行（原生/CLI/服务端调用不受同源策略约束）", () => {
    expect(originAllowed({ origin: null, host: "127.0.0.1:3000", ...local }).ok).toBe(true)
  })

  test("本地模式 + 缺省 *：要求 Origin 与 Host 同源", () => {
    expect(originAllowed({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", ...local }).ok).toBe(true)
    const bad = originAllowed({ origin: "http://evil.example.com", host: "127.0.0.1:3000", ...local })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe("cross-origin")
  })

  test("畸形 Origin：拒绝并标记 invalid-origin", () => {
    const bad = originAllowed({ origin: "not a url", host: "127.0.0.1:3000", ...local })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe("invalid-origin")
  })

  test("显式配 GEBAI_CORS_ORIGINS（不含 *）＝有意开放白名单：跨源放行", () => {
    const r = originAllowed({ origin: "http://app.example.com", host: "127.0.0.1:3000", ...local, corsOrigins: ["http://app.example.com"] })
    expect(r.ok).toBe(true)
  })

  test("服务模式：有令牌鉴权，跨源放行（异域前端可连 WS）", () => {
    const r = originAllowed({ origin: "http://app.example.com", host: "10.0.0.5:3000", ...server })
    expect(r.ok).toBe(true)
  })

  test("白名单含 * 时仍按同源拦截（* 不构成有意开放）", () => {
    const bad = originAllowed({ origin: "http://evil.example.com", host: "127.0.0.1:3000", ...local, corsOrigins: ["*"] })
    expect(bad.ok).toBe(false)
  })
})

describe("originAllowed：反向代理改写 Host（X-Forwarded-Host）", () => {
  test("传入转发主机时按它认主（Host 为 upstream 的形态）", () => {
    const r = originAllowed({ origin: "http://gateway.example.com", host: "127.0.0.1:3000", forwardedHost: "gateway.example.com", ...local })
    expect(r.ok).toBe(true)
  })

  test("未传转发主机（不信任代理头）＝仍按请求 Host 拦下", () => {
    const bad = originAllowed({ origin: "http://gateway.example.com", host: "127.0.0.1:3000", forwardedHost: null, ...local })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toBe("cross-origin")
  })

  test("多段 X-Forwarded-Host 取首值；大小写不影响比对", () => {
    expect(originAllowed({ origin: "http://gateway.example.com", host: "127.0.0.1:3000", forwardedHost: "gateway.example.com, inner:8080", ...local }).ok).toBe(true)
    expect(originAllowed({ origin: "http://Gateway.Example.com", host: "127.0.0.1:3000", forwardedHost: null, ...local }).ok).toBe(false)
    expect(originAllowed({ origin: "http://Gateway.Example.com", host: "gateway.example.com", forwardedHost: null, ...local }).ok).toBe(true)
  })

  test("转发主机不能放行任意来源（只认列出的主机）", () => {
    const bad = originAllowed({ origin: "http://evil.example.com", host: "127.0.0.1:3000", forwardedHost: "gateway.example.com", ...local })
    expect(bad.ok).toBe(false)
  })
})

describe("REST CORS 中间件：与 originAllowed 同口径（含反代场景）", () => {
  function makeDeps(overrides: Partial<ServerConfig> = {}): AppDeps {
    const config = { auth: "local", binaryMode: false, devReload: false, corsOrigins: ["*"], trustProxy: false, ...overrides } as unknown as ServerConfig
    return { config, auth: { defaultUser: () => SERVICE_USER } } as unknown as AppDeps
  }

  /** 模拟「反代改写 Host」的请求：Host 为 upstream，浏览器 Origin 为网关地址。 */
  const crossViaProxy = (extra: Record<string, string> = {}) =>
    new Request("http://127.0.0.1:3000/api/health", {
      headers: { origin: "http://gateway.example.com", host: "127.0.0.1:3000", ...extra },
    })

  test("缺省（不信任代理头）：跨源请求 403", async () => {
    const res = await createApp(makeDeps()).request(crossViaProxy())
    expect(res.status).toBe(403)
  })

  test("信任代理头 + 转发主机与 Origin 同主：放行", async () => {
    const res = await createApp(makeDeps({ trustProxy: true })).request(crossViaProxy({ "x-forwarded-host": "gateway.example.com" }))
    expect(res.status).toBe(200)
  })

  test("信任代理头但转发主机与 Origin 不同主：仍拒（不因信任代理头而放开跨源）", async () => {
    const res = await createApp(makeDeps({ trustProxy: true })).request(crossViaProxy({ "x-forwarded-host": "other.example.com" }))
    expect(res.status).toBe(403)
  })

  test("同源请求（Origin 与 Host 一致）放行；服务模式跨源由令牌鉴权约束、不在本层拦", async () => {
    const same = new Request("http://127.0.0.1:3000/api/health", { headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" } })
    expect((await createApp(makeDeps()).request(same)).status).toBe(200)
    expect((await createApp(makeDeps({ auth: "server" })).request(crossViaProxy())).status).not.toBe(403)
  })
})
