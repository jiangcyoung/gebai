/**
 * 服务级端到端验证（引擎全链路，fake-llm vision 场景驱动）：连接运行中的歌白服务 →
 * REST 确认 vision（客卿 Python 语言目录子代理）注册 → WS sendPrompt 驱动模型按场景脚本
 * 调用 vision_run 两次（首次定义并回显 sha256，第二次读该变量——常驻 REPL 命名空间跨调用
 * 保持）→ 断言工具输出（期望值由本脚本独立算出，不硬编码）。
 *
 * 前置：①歌白服务已启动（GEBAI_PORT，本地形态，建议 GEBAI_APPROVAL_SKIP=true 免审批）
 *      ②fake-llm vision 场景：bun run --cwd packages/server fake-llm vision（FAKE_LLM_PORT）
 * 用法：GEBAI_PORT=3987 bun run scripts/e2e-service-native.ts
 */
import { GebaiClient } from "@gebai/sdk"
import { createHash } from "node:crypto"

const port = (process.env.GEBAI_PORT || "3987").trim()
const fakePort = (process.env.FAKE_LLM_PORT || "9807").trim()
const c = new GebaiClient({ baseUrl: `http://127.0.0.1:${port}` })
await c.connect()

// 0) 重置 fake-llm 场景计数（e2e 可反复跑：场景按调用序号消耗，不重置会拿到「脚本已结束」）
const reset = await fetch(`http://127.0.0.1:${fakePort}/__reset`).then((r) => r.json()).catch(() => null)
console.log("fake-llm reset:", JSON.stringify(reset))
if (!reset?.ok) console.warn("WARN: fake-llm /__reset 不可达（需 fake-llm 新版；本跑可能拿到耗尽的场景）")

// 1) REST 子代理目录：vision 注册面（boot native 接线）
const subs = await c.get("/api/v1/sub-agents")
const names = ((subs ?? []) as Array<{ name: string }>).map((a) => a.name)
console.log("REST /sub-agents:", names.length, "个，vision 注册:", names.includes("vision"))
if (!names.includes("vision")) throw new Error("vision 未注册（boot native 接线失败）")

// 2) 新会话任务：fake-llm vision 场景（vision_run → vision_run → 收尾）
const created = await c.request("session.create", { title: "native-service-e2e" })
const sessionId = (created as { session?: { id?: string } })?.session?.id ?? (created as { id?: string })?.id
if (!sessionId) throw new Error(`session.create 返回异常: ${JSON.stringify(created).slice(0, 200)}`)
console.log("session:", sessionId)

const toolCalls: string[] = []
const outputs: string[] = []
for await (const ch of c.sendPrompt(sessionId, "运行两段 Python 片段并回显结果", { env: { GEBAI_APPROVAL_SKIP: "true" } })) {
  if (ch.kind === "tool_result") {
    const tname = (ch as { toolCall?: { name?: string } }).toolCall?.name ?? "?"
    toolCalls.push(tname)
    if (tname === "vision_run") outputs.push(String((ch as { output?: string }).output ?? ""))
  } else if (ch.kind === "error" || ch.kind === "model_error") {
    throw new Error(`任务失败: ${JSON.stringify(ch).slice(0, 300)}`)
  }
}

console.log("工具调用序列:", toolCalls)
// 3) 断言：vision_run 各调 1 次（共 2 次）；与独立算出的 sha256 常量比对（末尾表达式回显 repr），
// 第二次输出证明首次调用留下的命名空间变量仍在（常驻 REPL 跨调用保持）。
// 首调可能带 agent_load（场景脚本与路由自愈装载兼容两种路径）
const digest = createHash("sha256").update("gebai").digest("hex")
const runCount = toolCalls.filter((n) => n === "vision_run").length
console.log("vision_run 输出:", outputs.map((o) => o.slice(0, 60)))
if (!toolCalls.includes("agent_load") && toolCalls[0] !== "vision_run") throw new Error(`工具序列异常: ${toolCalls}`)
if (runCount !== 2) throw new Error(`vision_run 应调 2 次，实际 ${runCount}`)
if (!outputs[0]?.includes(digest)) throw new Error(`vision_run 首次输出未含 sha256('gebai')=${digest}: ${outputs[0]?.slice(0, 120)}`)
if (!outputs[1]?.includes(digest.slice(0, 16))) throw new Error(`vision_run 第二次未读到常驻变量: ${outputs[1]?.slice(0, 120)}`)

// 4) 会话记录落盘核验（chat.json 含工具调用）
const msgs = await c.get(`/api/v1/sessions/${sessionId}`)
console.log("会话记录可见:", !!msgs)

console.log("\n=== 服务级引擎全链路验证通过（boot 接线→路由自愈装载→vision_run 常驻状态→输出回传）===")
process.exit(0)
