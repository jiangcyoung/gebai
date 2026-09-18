/**
 * 同源判定：REST 的 CORS 中间件与 WS 升级两处共用（**口径必须一致**，错位会造成难排查的配置陷阱）。
 *
 * - 无 Origin：非浏览器客户端（原生/CLI/服务端调用）不受同源策略约束 → 放行；
 * - 服务模式：有令牌鉴权（跨源也需先登录）→ 放行；
 * - 显式配置 `GEBAI_CORS_ORIGINS`（不含 `*`）：视为有意开放的跨源白名单 → 放行
 *   （白名单具体命中与否由 REST 侧 CORS 响应头约束，WS 不重复判定）；
 * - 其余（本地/桌面免登录形态 + 缺省 `*`）：要求 Origin 与请求 Host 同源，否则拒绝。
 *
 * **反向代理**：缺省只比对请求 Host。代理改写了 Host 时（nginx `proxy_pass` 缺省把 Host 设为
 * upstream 主机），由调用方在信任代理头（`GEBAI_TRUST_PROXY`）时传入 `forwardedHost`
 * （`X-Forwarded-Host` 首值）——该值同样可作为被接受的同源主机；不信任代理头时不传，
 * 规则与原先完全一致（伪造转发头需要自定义请求头，浏览器会先发预检，预检自身不带该头，
 * 因此跨源伪造仍被本函数拦下）。
 */
export function originAllowed(opts: {
  origin: string | null
  host: string | null
  /** 转发主机（X-Forwarded-Host，仅信任代理头时传入）；空 = 不额外接受任何主机。 */
  forwardedHost?: string | null
  auth: string
  corsOrigins?: string[] | null
}): { ok: boolean; reason?: "cross-origin" | "invalid-origin" } {
  const origin = opts.origin
  if (!origin) return { ok: true }
  const cors = (opts.corsOrigins ?? []).length ? opts.corsOrigins! : ["*"]
  if (opts.auth === "server" || !cors.includes("*")) return { ok: true }
  let host: string
  try {
    host = new URL(origin).host.toLowerCase()
  } catch {
    return { ok: false, reason: "invalid-origin" }
  }
  const accepted = [opts.host ?? "", ...forwardedHost(opts.forwardedHost)].map((h) => h.toLowerCase())
  return accepted.includes(host) ? { ok: true } : { ok: false, reason: "cross-origin" }
}

/** X-Forwarded-Host 的首个有效值（网关可能追加多段）。 */
function forwardedHost(raw?: string | null): string[] {
  const first = raw?.split(",")[0]?.trim()
  return first ? [first] : []
}
