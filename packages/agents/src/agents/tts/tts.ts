import { existsSync } from "node:fs"
import type { ContentBlock, SubAgentDef, Tool } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import {
  TTS_ENGINES,
  TTS_MAX_TEXT,
  TTS_PITCH,
  TTS_RATE,
  TTS_VOLUME,
  UNSUPPORTED_PLATFORM_NOTE,
  clampPercent,
  defaultOutPath,
  escapeXml,
  filterVoices,
  formatBytes,
  formatDuration,
  formatVoiceList,
  isSupportedPlatform,
  normalizeEngine,
  runTtsScript,
  scriptFailureNote,
  validateText,
  voiceMismatchNote,
  type TtsEngine,
} from "./speech"
// 系统提示词独立 md 维护（目录形式约定：{dir}/{dir}.md）。
import systemPromptBase from "./tts.md"

/** 会话/任务级环境变量兜底默认值（前端环境变量面板可配置；工具参数优先）。 */
function engineFromEnv(env: Record<string, string>): TtsEngine {
  return normalizeEngine(env.TTS_ENGINE)
}

function voiceFromEnv(env: Record<string, string>): string | undefined {
  const v = String(env.TTS_VOICE ?? "").trim()
  return v || undefined
}

/** 产物文件名（逻辑路径或绝对路径均可：取末段，Windows 反斜杠一并规整）。 */
function baseName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() || "voice.wav"
}

export const speakTool: Tool = {
  name: "speak",
  safeMode: false,
  description:
    `把文本合成为音频文件（本机离线语音引擎：Windows 系统语音 WinRT OneCore 优先、SAPI5 回退——不联网、不耗配额、无需安装）。产物为 WAV，附在结果里可直接在聊天内播放，也可用 read/show 交付。参数：text 待合成文本（必填，上限 ${TTS_MAX_TEXT} 字符）；voice 音色名（可写「慧慧」这类短名或完整名，缺省中文女声，不确定有哪些音色先用 tts_voices 查看，未匹配到会回落默认音色并在结果里说明）；rate 语速百分比（${TTS_RATE.min}~${TTS_RATE.max}，负慢正快，默认 0）；pitch 音调百分比（${TTS_PITCH.min}~${TTS_PITCH.max}，负低正高）；volume 音量百分比（${TTS_VOLUME.min}~${TTS_VOLUME.max}）；out 产物路径（缺省 tmp/tts/voice-<时间戳>.wav，重复合成同一路径会覆盖）；engine 引擎 auto/winrt/sapi（默认 auto）。`,
  parameters: schema(
    {
      text: { type: "string", description: `要合成的文本（中英混排均可；上限 ${TTS_MAX_TEXT} 字符，超长请拆成多段分别合成，不要截断内容）` },
      voice: { type: "string", description: "音色名：支持完整名（Microsoft Huihui）或关键词（慧慧 / Kangkang）；缺省本机中文女声" },
      rate: { type: "number", description: `语速百分比 ${TTS_RATE.min}~${TTS_RATE.max}（负慢正快，默认 0）` },
      pitch: { type: "number", description: `音调百分比 ${TTS_PITCH.min}~${TTS_PITCH.max}（负低正高，默认 0）` },
      volume: { type: "number", description: `音量百分比 ${TTS_VOLUME.min}~${TTS_VOLUME.max}（默认 0）` },
      out: { type: "string", description: "产物音频路径（相对会话工作目录；缺省 tmp/tts/voice-<时间戳>.wav）" },
      engine: { type: "string", enum: [...TTS_ENGINES], description: "语音引擎：auto（默认，WinRT 优先 SAPI 回退）/ winrt / sapi" },
    },
    ["text"],
  ),
  outputSchema: schema(
    {
      path: { type: "string", description: "产物路径（相对会话工作目录）" },
      engine: { type: "string", description: "实际使用的引擎：winrt / sapi" },
      voice: { type: "string", description: "实际使用的音色名" },
      bytes: { type: "number", description: "产物字节数" },
      durationSec: { type: "number", description: "音频时长（秒）" },
    },
    ["path", "engine", "voice"],
  ),
  async execute(args, ctx) {
    if (!isSupportedPlatform()) return { output: UNSUPPORTED_PLATFORM_NOTE }
    const problem = validateText(args.text)
    if (problem) return { output: problem }
    const text = String(args.text)
    const engine = normalizeEngine(args.engine, engineFromEnv(ctx.env))
    const voice = String(args.voice ?? "").trim() || voiceFromEnv(ctx.env)
    const rate = clampPercent(args.rate, TTS_RATE)
    const pitch = clampPercent(args.pitch, TTS_PITCH)
    const volume = clampPercent(args.volume, TTS_VOLUME)
    const outRel = String(args.out ?? "").trim() || defaultOutPath(Date.now())
    const outAbs = ctx.resolvePath(outRel)
    // 覆盖提示按「写入前是否已存在」判定（合成后才查会永远为真）
    const existed = args.out ? existsSync(outAbs) : false

    const run = await runTtsScript(ctx, {
      mode: "synth",
      engine,
      text: escapeXml(text),
      voice,
      rate,
      pitch,
      volume,
      out: outAbs,
    })
    if (!run.result?.ok) return { output: scriptFailureNote(run, engine) }

    const result = run.result
    const bytes = result.bytes ?? 0
    const duration = result.durationSec ?? 0
    const blocks: ContentBlock[] = [{ type: "file", path: outRel, name: baseName(outRel), mime: "audio/wav" }]
    const notes: string[] = []
    const mismatch = voiceMismatchNote(result.requested, result.voice)
    if (mismatch) notes.push(mismatch)
    if (existed) notes.push("目标路径已有同名文件，本次已覆盖。")
    if (rate <= -60 || rate >= 120) notes.push("语速偏离自然语速较多，试听确认可懂度。")

    const output = [
      `已合成语音：${outRel}`,
      `音色 ${result.voice}（${result.lang ?? "未知语言"}），引擎 ${result.engine}，时长 ${formatDuration(duration)}，大小 ${formatBytes(bytes)}`,
      notes.length ? `注意：${notes.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join("\n")
    return {
      output,
      data: { path: outRel, engine: result.engine, voice: result.voice, bytes, durationSec: duration },
      blocks,
    }
  },
}

export const voicesTool: Tool = {
  name: "voices",
  safeMode: false,
  description:
    "列出本机可用的离线语音音色（Windows 系统语音；可选 find 按音色名或语言关键词过滤，如「慧慧」「zh」「Kangkang」）。合成（tts_speak）的 voice 参数取这里的名称或其一词即可。",
  parameters: schema({
    find: { type: "string", description: "关键词过滤：匹配音色名或语言（不区分大小写），如 慧慧 / zh / english" },
    limit: { type: "number", description: "最多返回条数（默认 50）" },
  }),
  outputSchema: schema({
    engine: { type: "string", description: "实际使用的引擎：winrt / sapi" },
    voices: {
      type: "array",
      items: schema(
        { name: { type: "string" }, lang: { type: "string" }, gender: { type: "string" } },
        ["name", "lang"],
      ),
    },
  }),
  async execute(args, ctx) {
    if (!isSupportedPlatform()) return { output: UNSUPPORTED_PLATFORM_NOTE }
    const engine = engineFromEnv(ctx.env)
    const run = await runTtsScript(ctx, { mode: "voices", engine })
    if (!run.result?.ok) return { output: scriptFailureNote(run, engine) }
    const all = run.result.voices ?? []
    const limit = Math.max(1, Math.min(200, Math.round(Number(args.limit) || 50)))
    const matched = filterVoices(all, args.find ? String(args.find) : undefined)
    if (!matched.length) {
      return {
        output: `没有匹配「${String(args.find ?? "")}」的音色。本机共 ${all.length} 个可用音色：\n${formatVoiceList(all.slice(0, limit))}`,
      }
    }
    const shown = matched.slice(0, limit)
    const tail = matched.length > shown.length ? `\n…（共 ${matched.length} 个匹配，已列出前 ${shown.length} 个）` : ""
    return {
      output: `本机可用音色（引擎 ${run.result.engine}，共 ${all.length} 个${args.find ? `，匹配 ${matched.length} 个` : ""}）：\n${formatVoiceList(shown)}${tail}`,
      data: { engine: run.result.engine, voices: shown },
    }
  },
}

export const name = "tts"
export const description =
  "语音合成（文本转语音）：把文本合成为可播放的音频文件，本机离线完成（Windows 系统语音 WinRT OneCore 优先、SAPI5 回退——不联网、不耗配额、无需安装），支持音色选择与语速/音调/音量调节；产物 WAV 直接在聊天内播放。输入：待合成文本（可选音色与语速等参数）；输出：音频文件路径、时长与大小。"
export const systemPrompt = systemPromptBase

export const tools = { speak: speakTool, voices: voicesTool }
export const preload = false

export const envVars = [
  { name: "TTS_VOICE", description: "默认音色名（tts_speak 未传 voice 时使用；可写完整名或关键词，如 慧慧）" },
  { name: "TTS_ENGINE", description: "默认语音引擎：auto（WinRT 优先 SAPI 回退）/ winrt / sapi" },
]

export const def: SubAgentDef = { name, description, systemPrompt, tools, preload, envVars }
