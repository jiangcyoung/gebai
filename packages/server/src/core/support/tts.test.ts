/**
 * 朗读合成服务与路由用例：合成执行通道全部注入假实现（不真起 PowerShell、不依赖本机语音引擎、不联网），
 * 覆盖参数校验 / 分片拼接 / 缓存与淘汰 / 失败分类 / REST 响应契约。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TtsDeps } from "@gebai/agents"
import { TTS_CHUNK_CHARS, TTS_REQUEST_MAX_TEXT, setTtsPlatform } from "@gebai/agents"
import { createTtsService } from "../support/tts"

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gebai-tts-svc-"))
  roots.push(dir)
  return dir
}
// 平台判定注入：合成/缓存/失败分类用例按本机内置离线引擎路径断言，平台经 setTtsPlatform 注入，
// 不随宿主平台漂移（「非 Windows 平台」用例单独覆写并在结束时还原）。
beforeAll(() => setTtsPlatform("win32"))
afterAll(() => {
  setTtsPlatform(undefined)
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 最小合法 PCM WAV。 */
function makeWav(samples: number, sampleRate = 16000): Uint8Array {
  const dataSize = samples * 2
  const buf = new Uint8Array(44 + dataSize)
  const dv = new DataView(buf.buffer)
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i)
  }
  str(0, "RIFF")
  dv.setUint32(4, 36 + dataSize, true)
  str(8, "WAVE")
  str(12, "fmt ")
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  str(36, "data")
  dv.setUint32(40, dataSize, true)
  return buf
}

/**
 * 假执行通道：按文本长度产出对应长度的 WAV 并写结果 JSON（模拟脚本），
 * 记录每次调用的环境变量（文本、参数）供断言。
 */
function fakeDeps(
  opts: { failWith?: string; sampleRate?: number; onSynth?: (text: string, env: Record<string, string>) => void } = {},
): { deps: (tmpDir: string) => TtsDeps; calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = []
  const deps = (tmpDir: string): TtsDeps => ({
    tmpDir,
    runCommand: async (_cmd, o) => {
      const env = (o?.env ?? {}) as Record<string, string>
      calls.push(env)
      const { readFile, writeFile, mkdir } = await import("node:fs/promises")
      const text = env.GEBAI_TTS_MODE === "synth" && env.GEBAI_TTS_TEXT ? await readFile(env.GEBAI_TTS_TEXT, "utf8") : ""
      if (env.GEBAI_TTS_MODE === "synth") opts.onSynth?.(text, env)
      if (opts.failWith) {
        await mkdir(join(env.GEBAI_TTS_RESULT, ".."), { recursive: true }).catch(() => {})
        await writeFile(env.GEBAI_TTS_RESULT, JSON.stringify({ ok: false, error: opts.failWith }), "utf8")
        return { stdout: "", stderr: "", code: 0 }
      }
      if (env.GEBAI_TTS_MODE === "synth") {
        const wav = makeWav(Math.max(1, text.length), opts.sampleRate ?? 16000)
        await writeFile(env.GEBAI_TTS_OUT, wav)
        await writeFile(
          env.GEBAI_TTS_RESULT,
          JSON.stringify({ ok: true, engine: "winrt", voice: "Microsoft Huihui", lang: "zh-CN", bytes: wav.byteLength, durationSec: text.length / 10 }),
          "utf8",
        )
      }
      return { stdout: "", stderr: "", code: 0 }
    },
    readFile: async (p) => {
      const { readFile } = await import("node:fs/promises")
      return readFile(p, "utf8")
    },
    writeFile: async (p, content) => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      await mkdir(join(p, ".."), { recursive: true })
      await writeFile(p, content, "utf8")
    },
    deleteFile: async (p) => {
      const { rm } = await import("node:fs/promises")
      await rm(p, { force: true })
    },
  })
  return { deps, calls }
}

const okService = (opts: Parameters<typeof fakeDeps>[0] = {}, cacheMaxBytes?: number) => {
  const { deps, calls } = fakeDeps(opts)
  const service = createTtsService({ deps, tmpDir: tempDir(), cacheMaxBytes })
  return { service, calls }
}

describe("朗读合成服务：参数校验", () => {
  test("空文本与缺参：400", async () => {
    const { service, calls } = okService()
    for (const req of [{ text: "" }, { text: "   " }, {} as { text: string }]) {
      const r = await service.synthesize(req)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.status).toBe(400)
        expect(r.error).toContain("待合成文本为空")
      }
    }
    expect(calls.length).toBe(0)
  })

  test("超长文本：400 且不发请求", async () => {
    const { service, calls } = okService()
    const r = await service.synthesize({ text: "啊".repeat(TTS_REQUEST_MAX_TEXT + 1) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("过长")
    expect(calls.length).toBe(0)
  })

  test("非 Windows 平台：503 且如实说明不做联网合成", async () => {
    setTtsPlatform("linux")
    try {
      const { service, calls } = okService()
      const r = await service.synthesize({ text: "你好" })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.status).toBe(503)
        expect(r.error).toContain("不做联网合成")
      }
      expect(calls.length).toBe(0)
    } finally {
      setTtsPlatform("win32")
    }
  })
})

describe("朗读合成服务：合成与分片", () => {
  test("短文本：一次调用，返回 WAV 与时长/引擎/音色", async () => {
    const { service, calls } = okService()
    const r = await service.synthesize({ text: "你好世界" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(calls.length).toBe(1)
    expect(r.wav.byteLength).toBe(44 + 4 * 2)
    expect(r.durationSec).toBeCloseTo(0.4, 5)
    expect(r.engine).toBe("winrt")
    expect(r.voice).toBe("Microsoft Huihui")
    expect(r.cached).toBe(false)
    expect(calls[0].GEBAI_TTS_MODE).toBe("synth")
    expect(calls[0].GEBAI_TTS_RATE).toBe("+0%")
  })

  test("文本先净化 markdown 再 XML 转义落文件（脚本只做拼接）", async () => {
    let seen = ""
    const { service } = okService({ onSynth: (text) => void (seen = text) })
    // **加粗** 的星号不发音；<tag> 作为 HTML 标签丢弃；& 与换行仍须 XML 转义
    await service.synthesize({ text: "A & B **加粗** <tag>\n换行" })
    expect(seen).toBe("A &amp; B 加粗&#10;换行")
  })

  test("长文本分片合成并拼接：片数正确、总长度等于各片之和", async () => {
    const { service, calls } = okService()
    const text = "这是一句话。".repeat(600) // 3600 字 → 多片
    const r = await service.synthesize({ text })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const chunks = text.length > TTS_CHUNK_CHARS ? calls.length : 1
    expect(calls.length).toBeGreaterThan(1)
    expect(chunks).toBe(calls.length)
    // 拼接后的 data 段 = 各片字符数之和 × 2 字节
    const dataSize = new DataView(r.wav.buffer, r.wav.byteOffset).getUint32(40, true)
    expect(dataSize).toBe(text.length * 2)
    expect(r.wav.byteLength).toBe(44 + text.length * 2)
    // 每片都不超过阈值
    for (const c of calls) expect(c.GEBAI_TTS_TEXT).toBeTruthy()
  })

  test("参数越界钳制后下发", async () => {
    const { service, calls } = okService()
    await service.synthesize({ text: "参数测试", rate: 999, pitch: -999, volume: 999, voice: "Kangkang" })
    expect(calls[0].GEBAI_TTS_RATE).toBe("+200%")
    expect(calls[0].GEBAI_TTS_PITCH).toBe("-50%")
    expect(calls[0].GEBAI_TTS_VOLUME).toBe("+100%")
    expect(calls[0].GEBAI_TTS_VOICE).toBe("Kangkang")
  })

  test("引擎失败：503 并透出失败分类文案", async () => {
    const { service } = okService({ failWith: "no-engine" })
    const r = await service.synthesize({ text: "你好" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(503)
      expect(r.error).toContain("未检测到本机离线语音引擎")
    }
  })
})

describe("朗读合成服务：缓存", () => {
  test("同文本同参数重复请求命中缓存（不再调用脚本）", async () => {
    const { service, calls } = okService()
    const first = await service.synthesize({ text: "重复朗读" })
    const second = await service.synthesize({ text: "重复朗读" })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(calls.length).toBe(1)
    expect(second.cached).toBe(true)
    expect(second.wav.byteLength).toBe(first.wav.byteLength)
  })

  test("参数或文本不同则不命中缓存", async () => {
    const { service, calls } = okService()
    await service.synthesize({ text: "同一段" })
    await service.synthesize({ text: "同一段", rate: 50 })
    await service.synthesize({ text: "另一段" })
    expect(calls.length).toBe(3)
    expect(service.cacheStatus().entries).toBe(3)
  })

  test("缓存超字节上限：淘汰最旧条目（保留最新）", async () => {
    // 每条 ~1KB（500 字 × 2 字节），上限 2.5KB → 最多留 2 条
    const { service } = okService({}, 2500)
    await service.synthesize({ text: "第一段".repeat(167) })
    await service.synthesize({ text: "第二段".repeat(167) })
    await service.synthesize({ text: "第三段".repeat(167) })
    const status = service.cacheStatus()
    expect(status.entries).toBeLessThanOrEqual(2)
    expect(status.bytes).toBeLessThanOrEqual(2500)
    // 最新的仍在
    const again = await service.synthesize({ text: "第三段".repeat(167) })
    expect(again.ok && again.cached).toBe(true)
  })
})
