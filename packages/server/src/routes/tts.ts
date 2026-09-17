/**
 * 语音朗读路由（DESIGN「语音合成」）：把助手回复文本合成为 WAV 流，Web 端「朗读」按钮消费。
 * 合成内核与缓存见 core/support/tts（与 tts 子Agent 共用 @gebai/agents 的引擎实现）。
 */
import { isSupportedPlatform } from "@gebai/agents"
import { createTtsService, type TtsRequest, type TtsService } from "../core/support/tts"
import type { RouteCtx } from "./context"

const defaultService = createTtsService()
/** 进程级单例：缓存与并发闸门随进程存活（合成无外部配置依赖，不经 AppDeps 注入）。 */
let service = defaultService

/** 替换服务实例（用例注入假执行通道驱动；传空还原默认实例）。 */
export function setTtsServiceForTest(next?: TtsService): void {
  service = next ?? defaultService
}

export function registerTtsRoutes(rc: RouteCtx): void {
  const { app } = rc

  // 可用性探测：前端据此决定是否渲染朗读按钮（引擎不可用的平台上不显示死按钮）
  app.get("/api/v1/tts/status", (c) => c.json({ available: isSupportedPlatform(), cache: service.cacheStatus() }))

  app.post("/api/v1/tts", async (c) => {
    let body: TtsRequest | null = null
    try {
      body = await c.req.json<TtsRequest>()
    } catch {
      body = null
    }
    if (!body || typeof body !== "object") return c.json({ error: "请求体须为 JSON 对象（text 必填）" }, 400)
    const result = await service.synthesize(body)
    if (!result.ok) return c.json({ error: result.error }, result.status)
    return new Response(result.wav, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(result.wav.byteLength),
        // 朗读音频按内容哈希缓存于进程内，但客户端不必留存副本（文本改了 URL 不变，缓存会给出旧音频）
        "Cache-Control": "no-store",
        "X-Gebai-Tts": `engine=${result.engine};duration=${result.durationSec};cached=${result.cached ? 1 : 0}`,
      },
    })
  })
}
