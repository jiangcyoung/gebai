/**
 * 文件工作台 · 语言服务器（LSP）域路由（DESIGN「文件工作台·语言服务器」）。
 *
 * 只提供**清单查询**：LSP 的交互（打开文档 / 补全 / 悬停 / 跳转 / 诊断推送）走 WS 双向通道
 * （`ws-handlers/lsp.ts`）——补全与悬停是高频小请求，REST 往返会明显拖慢输入体验；
 * 而「本机有哪些服务器」是页面启动时拉一次的低频只读数据，放 REST 更简单。
 *
 * 端点契约：
 *   GET /api/v1/lsp/servers → { enabled, reason?, sandboxed, servers, missing, errors }
 *
 * 闸门：文件工作台关闭 → 404；沙箱非豁免用户 → 403（语言服务器是常驻子进程，多用户部署不开放）；
 * `GEBAI_LSP=false` 或服务未注入 → 200 + `enabled:false`（前端静默，不注册任何 LSP 能力）。
 */

import type { Context } from "hono"
import type { RouteCtx } from "./context"
import { requireFsEnabled } from "./fs-shared"

/** LSP 未启用（GEBAI_LSP=false 或服务未注入）。 */
const LSP_OFF = "语言服务器未启用（GEBAI_LSP=false）"
/** 沙箱非豁免用户：不开放 LSP（等同拉起常驻子进程）。 */
const SANDBOX_DENIED = "沙箱模式下不开放语言服务器：请使用本地模式或沙箱豁免用户"

export function registerLspRoutes(rc: RouteCtx): void {
  const { app, d } = rc

  app.get("/api/v1/lsp/servers", async (c: Context) => {
    const off = requireFsEnabled(c, d)
    if (off) return off
    const user = await rc.userOf(c)
    const sandboxed = d.sandbox.enforcedFor(user.id)
    if (sandboxed) return c.json({ error: SANDBOX_DENIED }, 403)
    const enabled = d.config.lspEnabled !== false && !!d.lsp
    if (!enabled) {
      return c.json({ enabled: false, reason: LSP_OFF, sandboxed, servers: [], missing: [], errors: [] })
    }
    const info = d.lsp!.servers()
    return c.json({ enabled: true, sandboxed, servers: info.servers, missing: info.missing, errors: info.errors })
  })
}
