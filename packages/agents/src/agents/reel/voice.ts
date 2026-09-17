/**
 * reel_voice：**本地离线配音与字幕**（零联网、零云服务、零安装）。
 *
 * 能力边界：
 * - 配音走本机系统语音引擎（`core/tts`：Windows WinRT OneCore 优先、SAPI5 回退），逐句合成 WAV 到
 *   `<工程>/public/audio/voice/`，**时长由 WAV 头实测**（不信估算）——解说长度因此是确定的：
 *   分镜可以先按它排镜头窗口，渲出的声音、烧入的字幕与交付的 SRT 共用同一份帧号，必然同帧。
 * - 字幕与配音同源，三条出口共用一份帧号：① 烧入成片（`src/film/voice.generated.ts` 的 `SUBTITLES`
 *   → `Film.tsx` 的 `Subtitle` 原语）；② 交付字幕文件 `out/subtitles/<name>.srt`；
 *   ③ 分段数据 `<name>.json`（改文案后可免重合成重出字幕，见 action=srt）。
 * - 字幕**不依赖配音**：某条给 `durationMs` 即纯字幕段（无系统语音引擎的平台、或不想配音的段落照用），
 *   也可逐条覆盖 `voice` 做多角色配音。
 *
 * 与 timeline 的分工：`timeline.CAPTIONS` 是手写的画内解说条（无声段落用），本工具产出的字幕表挂在
 * `voice.generated.ts`——**同一句话不要两处都写**（叠字）。
 *
 * 帧号是唯一坐标（`from/duration` @ `fps`，默认 30 与 `timeline.FPS` 一致）：SRT 时间码由帧换算得出，
 * 因此字幕文件与成片永不走样。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { ContentBlock, Tool, ToolContext, ToolResult } from "@gebai/sdk"
import { artifactBlocks, previewLogicalPath, schema } from "@gebai/sdk/node"
import {
  TTS_ENGINES,
  TTS_MAX_TEXT,
  TTS_PITCH,
  TTS_RATE,
  TTS_VOLUME,
  UNSUPPORTED_PLATFORM_NOTE,
  clampPercent,
  concatWav,
  escapeXml,
  filterVoices,
  formatVoiceList,
  isSupportedPlatform,
  normalizeEngine,
  runTtsScript,
  scriptFailureNote,
  type TtsDeps,
  type TtsEngine,
} from "../../core/tts/speech"
import {
  SFX_MAX_SECONDS,
  SFX_SAMPLE_RATE,
  SFX_WAVES,
  audioDuration,
  clampNumber,
  concatAudios,
  encodeWav,
  formatPresetList,
  normalizeSampleRate,
  normalizeWave,
  synthesizeLayers,
  synthesizePreset,
  type AudioBuffer,
  type ToneSpec,
} from "../../core/tts/audio"
import { resolveOutputPath, resolveProjectDir, uniqueOutputPath } from "./paths"

/** 配音 WAV 落点（相对工程目录，Remotion 的 public 根下）。 */
export const VOICE_WAV_DIR = "public/audio/voice"
/** 音效 WAV 落点（相对工程目录）。 */
export const SFX_WAV_DIR = "public/audio/sfx"
/** 生成的音效数据模块（Film.tsx 直接 import）。 */
export const SFX_MODULE_PATH = "src/film/sfx.generated.ts"
/** 生成的配音/字幕数据模块（Film.tsx 直接 import）。 */
export const VOICE_MODULE_PATH = "src/film/voice.generated.ts"
/** 字幕与分段数据落点（相对工程目录的产物目录）。 */
export const VOICE_SUBTITLE_DIR = "out/subtitles"
/** 整段旁白预览音轨落点。 */
export const VOICE_BED_DIR = "out/audio"
/** 缺省帧率（与内置模板 timeline.FPS 一致）。 */
export const VOICE_DEFAULT_FPS = 30
/** 缺省句间隙（毫秒）：句与句之间留一拍，字幕不粘连。 */
export const VOICE_DEFAULT_GAP_MS = 300
/** 单次生产的句数上限。 */
export const VOICE_MAX_LINES = 200
/** 单次生产的音效条数上限。 */
export const SFX_MAX_ITEMS = 40
/** 结果里直接附带试听的音效条数上限（超出只差差路径）。 */
export const SFX_PREVIEW_BLOCKS = 8
/** 中文语速常数（字/秒 @语速 0）——只用于分镜前的估时，实际时长以合成实测为准。 */
export const SPEECH_CJK_PER_SEC = 4.6
/** 西文语速常数（词/秒 @语速 0）。 */
export const SPEECH_WORD_PER_SEC = 2.9
/** 句末停顿（秒）。 */
export const PAUSE_LONG_SEC = 0.32
/** 句中停顿（秒）。 */
export const PAUSE_SHORT_SEC = 0.14

/* ────────────────────────────── WAV：时长与静音 ────────────────────────────── */

/** WAV 关键结构：data 段之前的全部头部字节 + 格式字段 + data 段位置（拼接静音时用）。 */
export interface WavLayout {
  /** `0 → dataOffset` 的头部字节（含 RIFF/WAVE/fmt 等全部前置块）。 */
  header: Uint8Array
  dataOffset: number
  dataSize: number
  /** data 段长度字段偏移（造静音时改写）。 */
  dataSizeAt: number
  /** RIFF 长度字段偏移（恒为 4）。 */
  riffSizeAt: number
  sampleRate: number
  channels: number
  bits: number
  blockAlign: number
}

const u32At = (buf: Uint8Array, at: number): number =>
  ((buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> 0)

const tagAt = (buf: Uint8Array, at: number): string =>
  String.fromCharCode(buf[at] ?? 0, buf[at + 1] ?? 0, buf[at + 2] ?? 0, buf[at + 3] ?? 0)

function writeU32(buf: Uint8Array, at: number, value: number): void {
  buf[at] = value & 0xff
  buf[at + 1] = (value >>> 8) & 0xff
  buf[at + 2] = (value >>> 16) & 0xff
  buf[at + 3] = (value >>> 24) & 0xff
}

/**
 * 解析 WAV 布局：非 WAV / 缺 fmt / 缺 data 一律返回 null（不猜、不按 0 静默处理）。
 * 流式 WAV 会把 data 段长度写成 0 或 0xFFFFFFFF——越界即按实际剩余字节数算（时长宁可实测，不估）。
 */
export function readWavLayout(buf: Uint8Array): WavLayout | null {
  if (buf.byteLength < 44) return null
  if (tagAt(buf, 0) !== "RIFF" || tagAt(buf, 8) !== "WAVE") return null
  let pos = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let blockAlign = 0
  while (pos + 8 <= buf.byteLength) {
    const id = tagAt(buf, pos)
    const size = u32At(buf, pos + 4)
    const body = pos + 8
    if (id === "fmt " && size >= 16 && body + 16 <= buf.byteLength) {
      channels = buf[body + 2] | (buf[body + 3] << 8)
      sampleRate = u32At(buf, body + 4)
      blockAlign = buf[body + 12] | (buf[body + 13] << 8)
      bits = buf[body + 14] | (buf[body + 15] << 8)
    } else if (id === "data") {
      const available = buf.byteLength - body
      const dataSize = size > 0 && size <= available ? size : available
      if (!sampleRate || !blockAlign || !dataSize) return null
      return {
        header: buf.slice(0, body),
        dataOffset: body,
        dataSize,
        dataSizeAt: pos + 4,
        riffSizeAt: 4,
        sampleRate,
        channels,
        bits,
        blockAlign,
      }
    }
    if (size > buf.byteLength) return null
    pos = body + size + (size % 2)
  }
  return null
}

/** WAV 时长（秒）= data 字节数 ÷ 每秒字节数；解析失败返回 null（调用方据此报错而不是当成 0 秒）。 */
export function wavDurationSec(buf: Uint8Array): number | null {
  const layout = readWavLayout(buf)
  if (!layout) return null
  const bytesPerSec = layout.sampleRate * layout.blockAlign
  if (!(bytesPerSec > 0)) return null
  return layout.dataSize / bytesPerSec
}

/** 以既有 WAV 的头部造一段同格式静音（拼整段旁白用）：格式由源文件决定，不另猜参数。 */
export function silentWavLike(template: WavLayout, samples: number): Uint8Array {
  const dataBytes = Math.max(0, Math.round(samples)) * template.blockAlign
  const out = new Uint8Array(template.dataOffset + dataBytes)
  out.set(template.header, 0)
  writeU32(out, template.riffSizeAt, out.byteLength - 8)
  writeU32(out, template.dataSizeAt, dataBytes)
  return out
}

/**
 * 整段旁白预览轨：按帧排布拼成一条（语音段之间补等长静音），供用户在渲染前直接听。
 * 各段格式不一致（多引擎/多音色混用）时返回 null——不硬拼出一条失真音频。
 */
export function stitchVoiceBed(parts: Array<{ bytes: Uint8Array; from: number; duration: number }>, fps: number): Uint8Array | null {
  if (!parts.length || !(fps > 0)) return null
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]!.from < parts[i - 1]!.from) return null // 锚点把顺序打乱：拼接会串位
  }
  const first = readWavLayout(parts[0]!.bytes)
  if (!first) return null
  const chunks: Uint8Array[] = []
  let cursor = 0
  for (const part of parts) {
    const gapFrames = part.from - cursor
    if (gapFrames > 0) chunks.push(silentWavLike(first, (gapFrames / fps) * first.sampleRate))
    chunks.push(part.bytes)
    cursor = part.from + part.duration
  }
  return concatWav(chunks)
}

/** `out/subtitles/<name>.json` 的形状（action=srt 的输入：只需帧号与文案，其余字段忽略）。 */
export interface SegmentsJson {
  fps?: number
  cues?: Array<{ from?: number; duration?: number; text?: string }>
}

/* ────────────────────────────── 解说词 → 帧号排布 ────────────────────────────── */

/** 一条解说词（归一后的入参）。 */
export interface VoiceLineSpec {
  text: string
  /** 该条音色（缺省用全局音色）——多角色配音用。 */
  voice?: string
  /** 绝对起始帧：给定即钉在该帧（对齐镜头），不再跟随上一条。 */
  at?: number
  /** 该条结束到下一句的空隙（毫秒，覆盖全局 gapMs）。 */
  gapMs?: number
  /** 显式时长（毫秒）：给定时**不合成音频**，只出字幕（纯字幕段）。 */
  durationMs?: number
}

/** 一条排布好的配音/字幕记录（帧号坐标系与 timeline 一致）。 */
export interface VoiceCue {
  index: number
  text: string
  /** public 下的音频相对路径（纯字幕段无此字段）。 */
  src?: string
  voice?: string
  from: number
  duration: number
  /** 实测（或显式给出的）语音时长（秒）。 */
  durationSec: number
  gapMs: number
}

const finiteNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : undefined
}

/**
 * 入参归一：接受字符串（按行拆）或字符串/对象数组。
 * 校验失败返回 problem（带条号，便于模型一次改对）；不抛错——工具失败要让调用方看见原因。
 */
export function normalizeVoiceLines(raw: unknown): { lines: VoiceLineSpec[]; problem?: string } {
  let items: unknown[]
  if (typeof raw === "string") {
    items = raw.split(/\r?\n/)
  } else if (Array.isArray(raw)) {
    items = raw
  } else {
    return { lines: [], problem: "未给出解说词：传 lines（字符串按行拆分，或对象数组 { text, voice?, at?, durationMs?, gapMs? }）。" }
  }
  if (items.length > VOICE_MAX_LINES) {
    return { lines: [], problem: `解说词条数过多（${items.length} 条，上限 ${VOICE_MAX_LINES}）——一支片子不会这么多句，请拆成多次生成。` }
  }
  const lines: VoiceLineSpec[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const at = i + 1
    if (typeof item === "string") {
      const text = item.trim()
      if (!text) continue // 空行跳过（多数派：解说词是逐行给的）
      lines.push({ text })
      continue
    }
    if (!item || typeof item !== "object") {
      return { lines: [], problem: `第 ${at} 条不是文本或对象（可用：字符串，或 { text, voice?, at?, durationMs?, gapMs? }）。` }
    }
    const o = item as Record<string, unknown>
    const text = String(o.text ?? "").trim()
    if (!text) return { lines: [], problem: `第 ${at} 条解说词为空（text）。` }
    const spec: VoiceLineSpec = { text }
    const voice = String(o.voice ?? "").trim()
    if (voice) spec.voice = voice
    for (const key of ["at", "durationMs", "gapMs"] as const) {
      const n = finiteNumber(o[key])
      if (o[key] !== undefined && o[key] !== null && o[key] !== "" && (n === undefined || n < 0)) {
        return { lines: [], problem: `第 ${at} 条的 ${key} 不是非负数（${String(o[key])}）。` }
      }
      if (n !== undefined) spec[key] = n
    }
    if (spec.durationMs !== undefined && !(spec.durationMs > 0)) {
      return { lines: [], problem: `第 ${at} 条的 durationMs 须大于 0（要静音留白请用 gapMs）。` }
    }
    lines.push(spec)
  }
  if (!lines.length) return { lines: [], problem: "未给出解说词：lines 里没有有效条目。" }
  return { lines }
}

/**
 * 语速估算（秒）：中文字数 + 西文词数按常数折算，标点计停顿，语速参数按比例缩放。
 * 只用于分镜前估时（标注 ±20%）；真实时长一律以 action=build 的 WAV 实测为准。
 */
export function estimateSpeechSec(text: string, rate = 0): number {
  const source = String(text ?? "")
  const cjk = (source.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/g) ?? []).length
  const words = (source.match(/[A-Za-z0-9][A-Za-z0-9'’._-]*/g) ?? []).length
  const longPauses = (source.match(/[。！？!?；;：:…]/g) ?? []).length
  const shortPauses = (source.match(/[，、,]/g) ?? []).length
  const raw = cjk / SPEECH_CJK_PER_SEC + words / SPEECH_WORD_PER_SEC + longPauses * PAUSE_LONG_SEC + shortPauses * PAUSE_SHORT_SEC
  const speed = Math.max(0.01, 1 + clampPercent(rate, TTS_RATE) / 100)
  return Math.round((raw / speed) * 10) / 10
}

/**
 * 排布：逐条算出起始帧与时长帧。
 * - `at` 给定即钉在该帧（对齐镜头），否则紧接上一条结束 + 该条 gapMs；
 * - 时长：语音段由实测秒数换算、纯字幕段由 durationMs 换算，都至少 1 帧（0 帧字幕看不见）。
 */
export function layoutVoiceCues(
  items: Array<VoiceLineSpec & { src?: string; durationSec?: number }>,
  opts: { fps?: number; startFrame?: number; gapMs?: number } = {},
): VoiceCue[] {
  const fps = opts.fps && opts.fps > 0 ? opts.fps : VOICE_DEFAULT_FPS
  const gapMs = opts.gapMs !== undefined && opts.gapMs >= 0 ? opts.gapMs : VOICE_DEFAULT_GAP_MS
  let cursor = opts.startFrame !== undefined && opts.startFrame >= 0 ? Math.round(opts.startFrame) : 0
  const cues: VoiceCue[] = []
  items.forEach((item, i) => {
    const sec = item.durationSec !== undefined && item.durationSec !== null
      ? item.durationSec
      : item.durationMs !== undefined
        ? item.durationMs / 1000
        : 0
    const duration = Math.max(1, Math.round(sec * fps))
    const from = item.at !== undefined ? Math.max(0, Math.round(item.at)) : cursor
    const itemGapMs = item.gapMs !== undefined ? item.gapMs : gapMs
    cues.push({
      index: i + 1,
      text: item.text,
      ...(item.src ? { src: item.src } : {}),
      ...(item.voice ? { voice: item.voice } : {}),
      from,
      duration,
      durationSec: duration / fps,
      gapMs: itemGapMs,
    })
    cursor = from + duration + Math.round((itemGapMs * fps) / 1000)
  })
  return cues
}

/* ────────────────────────────── 字幕与数据模块 ────────────────────────────── */

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** 帧 → SRT 时间码 `HH:MM:SS,mmm`（由帧换算，保证与成片同帧）。 */
export function srtTimecode(frame: number, fps: number): string {
  const totalMs = Math.max(0, Math.round((Math.max(0, frame) / (fps > 0 ? fps : VOICE_DEFAULT_FPS)) * 1000))
  return `${pad2(Math.floor(totalMs / 3600000))}:${pad2(Math.floor(totalMs / 60000) % 60)}:${pad2(Math.floor(totalMs / 1000) % 60)},${String(totalMs % 1000).padStart(3, "0")}`
}

/** 生成 SRT 字幕文件内容（空表返回空串——不产出一个只有 BOM 的假字幕）。 */
export function buildSrt(cues: Array<{ from: number; duration: number; text: string }>, fps: number): string {
  if (!cues.length) return ""
  return cues
    .map((c, i) => `${i + 1}\n${srtTimecode(c.from, fps)} --> ${srtTimecode(c.from + Math.max(1, c.duration), fps)}\n${c.text}\n`)
    .join("\n")
}

/** 生成 `voice.generated.ts`（配音音频钉帧表 + 字幕表）：确定性输出，不含时间戳（重复生成内容一致）。 */
export function renderVoiceModule(
  cues: VoiceCue[],
  meta: { fps: number; gain: number; voice?: string; engine?: string },
): string {
  const voiced = cues.filter((c) => c.src)
  const last = cues[cues.length - 1]
  const totalFrames = last ? last.from + last.duration : 0
  const totalSec = Math.round((totalFrames / meta.fps) * 100) / 100
  const head = [
    "/**",
    " * 配音与字幕表 —— 由 reel_voice 生成（本机离线语音引擎，零联网）；手改会在下次生成时被覆盖。",
    " *",
    ` * from/duration 单位为帧（@${meta.fps}fps，与 timeline.FPS 同一坐标系）；SUBTITLES 与 VOICEOVER 逐句同窗，`,
    " * 交付字幕文件 out/subtitles/*.srt 由同一份帧号换算得出（改文案后 action=srt 可免重合成重出）。",
    ` * 音色 ${meta.voice ?? "未指定"} · 引擎 ${meta.engine ?? "未指定"} · ${cues.length} 句 / 共 ${totalFrames} 帧（≈${totalSec}s）。`,
    " */",
  ]
  const metaLine = `export const VOICE_META = { fps: ${meta.fps}, gain: ${meta.gain}, voice: ${JSON.stringify(meta.voice ?? "")}, engine: ${JSON.stringify(meta.engine ?? "")}, segments: ${cues.length}, totalFrames: ${totalFrames}, totalSec: ${totalSec} }`
  const voLines = voiced.map(
    (c) => `  { from: ${c.from}, duration: ${c.duration}, src: ${JSON.stringify(c.src)}, volume: ${meta.gain}, text: ${JSON.stringify(c.text)} },`,
  )
  const subLines = cues.map((c) => `  { from: ${c.from}, duration: ${c.duration}, text: ${JSON.stringify(c.text)} },`)
  return [
    ...head,
    "",
    metaLine,
    "",
    "/** 配音音频钉帧表（Film.tsx 逐条挂 <Audio src={staticFile(src)}>；纯字幕段不在表里）。 */",
    `export const VOICEOVER: Array<{ from: number; duration: number; src: string; volume: number; text: string }> = [`,
    ...voLines,
    "]",
    "",
    "/** 字幕表（配音字幕，与配音逐句同窗）。 */",
    "export const SUBTITLES: Array<{ from: number; duration: number; text: string }> = [",
    ...subLines,
    "]",
    "",
  ].join("\n")
}

/* ────────────────────────────── 音效：条目、排布、数据模块 ────────────────────────────── */

/** 音效条目（归一后）：预设与自定义波形二选一。 */
export interface SfxItemSpec {
  /** 预设名（与 tone 二选一）。 */
  preset?: string
  /** 自定义单音配方（与 preset 二选一）。 */
  tone?: ToneSpec
  /** 绝对起始帧：给定即钉在该帧（贴在画面动作上），否则接上一段。 */
  at?: number
  /** 该段结束到下一段的空隙（毫秒，缺省 0——音效本该贴着动作）。 */
  gapMs?: number
  /** 成片里的播放音量（倍数 0~2，缺省 1）。 */
  volume?: number
  /** 播放窗口帧数（覆盖按音频时长算出的窗口；只影响成片播放窗，不改音频文件）。 */
  windowFrames?: number
  /** 连响次数（1~20，缺省 1）。 */
  repeat?: number
  /** 连响间隔（毫秒，缺省 120）。 */
  repeatGapMs?: number
  /** 备注（写进生成表的 note，指明对应画面动作）。 */
  note?: string
}

const TONE_KEYS = ["wave", "freq", "freqTo", "duration", "decay", "attack", "release", "gain"] as const

/**
 * 音效入参归一：接受预设名字符串或对象数组。
 * 校验失败返回 problem（带条号并附可用预设），不抛错——工具失败要让调用方看见原因。
 */
export function normalizeSfxItems(raw: unknown): { items: SfxItemSpec[]; problem?: string } {
  if (!Array.isArray(raw) || !raw.length) {
    return { items: [], problem: `未给出音效：传 sfx 数组（预设名字符串，或 { preset } / { wave, freq, duration… } 对象）。\n可用预设：\n${formatPresetList()}` }
  }
  if (raw.length > SFX_MAX_ITEMS) {
    return { items: [], problem: `音效条数过多（${raw.length} 条，上限 ${SFX_MAX_ITEMS}）：一支片子的音效不会这么多，请拆成多次生成。` }
  }
  const items: SfxItemSpec[] = []
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i]
    const at = i + 1
    if (typeof entry === "string") {
      const name = entry.trim()
      if (!name) continue // 空项跳过（多数派：音效按名逐条给）
      items.push({ preset: name })
      continue
    }
    if (!entry || typeof entry !== "object") {
      return { items: [], problem: `第 ${at} 条不是预设名或对象（可用："riser" 这样的字符串，或 { preset } / { wave, freq, duration… }）。\n可用预设：\n${formatPresetList()}` }
    }
    const o = entry as Record<string, unknown>
    const spec: SfxItemSpec = {}
    const preset = String(o.preset ?? "").trim()
    if (preset) spec.preset = preset
    const hasTone = TONE_KEYS.some((k) => o[k] !== undefined && o[k] !== null && o[k] !== "")
    if (spec.preset && hasTone) {
      return { items: [], problem: `第 ${at} 条同时给了 preset 与自定义波形参数：两者二选一（preset 是一个完整音效配方，叠自定义层会让意图不明）。` }
    }
    if (!spec.preset && !hasTone) {
      return { items: [], problem: `第 ${at} 条既没有 preset 也没有自定义参数（wave/freq/duration 至少给一个）。\n可用预设：\n${formatPresetList()}` }
    }
    if (hasTone) {
      if (o.duration !== undefined && clampNumber(o.duration, 0.01, SFX_MAX_SECONDS, 0.3) === SFX_MAX_SECONDS) {
        return { items: [], problem: `第 ${at} 条时长达到上限（${SFX_MAX_SECONDS} 秒）：音效不应这么长，若确实需要请在 tts 子Agent 用 tts_sfx + tts_mix 自行拼好后放进 public/audio/。` }
      }
      spec.tone = {
        wave: normalizeWave(o.wave),
        freq: finiteNumber(o.freq),
        freqTo: finiteNumber(o.freqTo),
        duration: finiteNumber(o.duration),
        decay: finiteNumber(o.decay),
        attack: finiteNumber(o.attack),
        release: finiteNumber(o.release),
        gain: finiteNumber(o.gain),
      }
    }
    for (const key of ["at", "gapMs", "windowFrames"] as const) {
      const n = finiteNumber(o[key])
      if (o[key] !== undefined && o[key] !== null && o[key] !== "" && (n === undefined || n < 0)) {
        return { items: [], problem: `第 ${at} 条的 ${key} 不是非负数（${String(o[key])}）。` }
      }
      if (n !== undefined) spec[key] = n
    }
    const volume = finiteNumber(o.volume)
    if (volume !== undefined) spec.volume = clampNumber(volume, 0, 2, 1)
    const repeat = finiteNumber(o.repeat)
    if (repeat !== undefined) spec.repeat = Math.round(clampNumber(repeat, 1, 20, 1))
    const repeatGapMs = finiteNumber(o.repeatGapMs)
    if (repeatGapMs !== undefined) spec.repeatGapMs = clampNumber(repeatGapMs, 0, 10000, 120)
    const note = String(o.note ?? "").trim()
    if (note) spec.note = note
    items.push(spec)
  }
  if (!items.length) return { items: [], problem: "未给出音效：sfx 里没有有效条目。" }
  return { items }
}

/**
 * 音效排布：`at` 给定即钉在该帧，否则接上一段（缺省无空隙——音效本就该贴在动作上）。
 * 窗口帧数：给了 `windowFrames` 用它，否则按音频时长向上取整（窗口短于音频会把声音截断，故不向下取）。
 */
export function layoutSfxTracks(
  items: Array<{ at?: number; gapMs?: number; durationSec: number; windowFrames?: number }>,
  opts: { fps?: number; startFrame?: number; gapMs?: number } = {},
): Array<{ from: number; duration: number }> {
  const fps = opts.fps && opts.fps > 0 ? opts.fps : VOICE_DEFAULT_FPS
  const gapMs = opts.gapMs !== undefined && opts.gapMs >= 0 ? opts.gapMs : 0
  let cursor = opts.startFrame !== undefined && opts.startFrame >= 0 ? Math.round(opts.startFrame) : 0
  return items.map((item) => {
    const duration = item.windowFrames !== undefined ? Math.max(1, Math.round(item.windowFrames)) : Math.max(1, Math.ceil(item.durationSec * fps))
    const from = item.at !== undefined ? Math.max(0, Math.round(item.at)) : cursor
    cursor = from + duration + Math.round(((item.gapMs ?? gapMs) * fps) / 1000)
    return { from, duration }
  })
}

/**
 * 成片总长（帧）= 各轨**结束帧的最大值**。
 *
 * 为何不取最后一条：`at` 允许乱序给（收尾组 riser→impact→sparkle 常常整组写在前面），且钉帧比
 * 顺序排布更靠后——取最后一条会把总长报小，而这个值直接喂给分镜排 TOTAL，不能估。
 */
export function sfxTotalFrames(tracks: Array<{ from: number; duration: number }>): number {
  return tracks.reduce((max, t) => Math.max(max, t.from + t.duration), 0)
}

/** 生成 `sfx.generated.ts`（音效钉帧表）：确定性输出，不含时间戳。 */
export function renderSfxModule(
  tracks: Array<{ from: number; duration: number; src: string; volume: number; note?: string }>,
  meta: { fps: number; sampleRate: number; name: string },
): string {
  const totalFrames = sfxTotalFrames(tracks)
  const lines = tracks.map(
    (t) =>
      `  { from: ${t.from}, duration: ${t.duration}, src: ${JSON.stringify(t.src)}, volume: ${t.volume}${t.note ? `, note: ${JSON.stringify(t.note)}` : ""} },`,
  )
  return [
    "/**",
    " * 音效钉帧表 —— 由 reel_voice 生成（纯本地波形合成，零联网）；手改会在下次生成时被覆盖。",
    " *",
    ` * from/duration 单位为帧（@${meta.fps}fps，与 timeline.FPS 同一坐标系）；volume 是成片里的播放音量。`,
    " * 与 timeline.SFX（手工登记的素材音效）并行生效：同一动作不要两处都写。",
    ` * 共 ${tracks.length} 条 / 到第 ${totalFrames} 帧（${meta.sampleRate} 赫兹）。`,
    " */",
    "",
    `export const SFX_META = { fps: ${meta.fps}, sampleRate: ${meta.sampleRate}, count: ${tracks.length}, totalFrames: ${totalFrames} }`,
    "",
    "/** 音效钉帧表（Film.tsx 逐条挂 <Audio src={staticFile(src)}>）。 */",
    "export const SFX_TRACKS: Array<{ from: number; duration: number; src: string; volume: number; note?: string }> = [",
    ...lines,
    "]",
    "",
  ].join("\n")
}

/* ────────────────────────────── 工具 ────────────────────────────── */

/** 逐句合成请求（产物绝对路径由调用方给出）。 */
export interface VoiceSynthRequest {
  text: string
  voice?: string
  rate: number
  pitch: number
  volume: number
  engine: TtsEngine
  out: string
}

/** 合成结果（ok=false 时 note 是给用户看的失败说明）。 */
export interface VoiceSynthOutcome {
  ok: boolean
  note?: string
  voice?: string
  engine?: string
  /** 引擎侧报出的时长（WAV 头解析不出时的兜底）。 */
  durationSec?: number
}

/** 可注入依赖：合成通道（测试桩不依赖系统语音引擎，也不需要 Windows）。 */
export interface VoiceToolDeps {
  synth?: (ctx: ToolContext, req: VoiceSynthRequest) => Promise<VoiceSynthOutcome>
}

/** 会话上下文 → 引擎执行通道（与 tts 子Agent 同口径：合成内核是基建，执行依赖经此注入）。 */
function ttsDeps(ctx: ToolContext): TtsDeps {
  return {
    runCommand: (cmd, opts) => ctx.runCommand(cmd, opts),
    readFile: ctx.readFile,
    writeFile: ctx.writeFile,
    deleteFile: ctx.deleteFile,
    tmpDir: ctx.resolvePath("tmp/tts"),
    signal: ctx.signal,
  }
}

/** 缺省合成通道：本机离线语音引擎（不联网、不耗配额）。 */
async function nativeSynth(ctx: ToolContext, req: VoiceSynthRequest): Promise<VoiceSynthOutcome> {
  const run = await runTtsScript(ttsDeps(ctx), {
    mode: "synth",
    engine: req.engine,
    text: escapeXml(req.text),
    voice: req.voice,
    rate: req.rate,
    pitch: req.pitch,
    volume: req.volume,
    out: req.out,
  })
  if (!run.result?.ok) return { ok: false, note: scriptFailureNote(run, req.engine) }
  return { ok: true, voice: run.result.voice, engine: run.result.engine, durationSec: run.result.durationSec }
}

const envGet = (ctx: ToolContext, key: string): string | undefined => {
  const value = String(ctx.env?.[key] ?? "").trim()
  return value || undefined
}

/** 产物名白名单：它进文件路径，越界字符一律拒绝而不是净化（净化会造出两个不同名指向同一文件）。 */
function safeName(raw: unknown, fallback = "narration"): string | null {
  const s = String(raw ?? "").trim()
  if (!s) return fallback
  return /^[A-Za-z0-9._-]{1,64}$/.test(s) ? s : null
}

function numberArg(raw: unknown, fallback: number, min: number, max: number): number {
  const n = finiteNumber(raw)
  if (n === undefined) return fallback
  return Math.max(min, Math.min(max, n))
}

const secText = (sec: number): string => `${(Math.round(sec * 100) / 100).toFixed(2)}s`

const pad = (n: number): string => String(n).padStart(2, "0")

/** 逐条回显（时长 / 帧窗 / 音频 / 文案）。 */
function cueLines(cues: VoiceCue[]): string[] {
  return cues.map((c) => {
    const where = c.src ? ` ${VOICE_WAV_DIR}/${c.src.split("/").pop()}` : " （纯字幕，无音频）"
    return `  ${String(c.index).padStart(2, " ")}. ${secText(c.durationSec).padStart(6, " ")}  帧 ${c.from}–${c.from + c.duration}${where}  「${c.text}」`
  })
}

export function makeVoiceTool(deps: VoiceToolDeps = {}): Tool {
  const synth = deps.synth ?? nativeSynth
  return {
    name: "voice",
    description:
      "为视频做配音、字幕与音效，全程本地：配音走本机离线语音引擎（Windows 系统语音，不联网、不耗配额），逐句合成 WAV 到工程 public/audio/voice/ **并实测时长**；字幕与配音同源（帧号唯一坐标）——烧入成片（写 src/film/voice.generated.ts，Film.tsx 的 Subtitle 原语直接渲染）+ 交付 SRT 字幕文件 + 分段 JSON。音效是纯本地波形合成（不依赖语音引擎，任何平台可用）：预设 riser/impact/sparkle/whoosh/explosion 等，也可自定义波形与滑频，写 public/audio/sfx/ 与 src/film/sfx.generated.ts。动作：build（默认，生成配音与字幕，可只听不下：整段预览音轨附在结果里）/ sfx（生成音效；不传 sfx 数组则列出全部预设）/ estimate（只估解说时长不落盘，分镜前用它定镜头窗口）/ srt（改文案改帧后由 JSON 重出字幕，不重合成）/ voices（列出本机可用离线音色）。某条给 durationMs 即纯字幕段（不合成音频）——字幕能力不依赖配音。",
    parameters: schema(
      {
        action: {
          type: "string",
          enum: ["build", "sfx", "estimate", "srt", "voices"],
          description: "build（默认）生成配音与字幕 / sfx 生成音效 / estimate 只估算解说时长（不合成、不落盘）/ srt 由 JSON 重出字幕 / voices 列出本机离线音色",
        },
        lines: {
          type: "array",
          description:
            "解说词：字符串数组按行给（最常用），或对象数组逐条控制——{ text 必填, voice 覆盖音色（多角色）, at 绝对起始帧（钉镜头）, durationMs 显式时长（纯字幕、不合成）, gapMs 该句到下一句的空隙 }。也接受一个多行字符串（按行拆）。",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string", description: "该句解说词" },
                  voice: { type: "string", description: "该句音色（覆盖全局 voice，多角色配音用）" },
                  at: { type: "number", description: "绝对起始帧（对齐镜头；缺省接上一句之后）" },
                  durationMs: { type: "number", description: "显式时长（毫秒）：给定时不合成音频，只出字幕" },
                  gapMs: { type: "number", description: "该句结束到下一句的空隙（毫秒）" },
                },
                required: ["text"],
              },
            ],
          },
        },
        project: { type: "string", description: "视频工程目录（缺省用 REEL_PROJECT）" },
        sfx: {
          type: "array",
          description:
            "action=sfx：音效数组——预设名字符串（如 \"riser\"、\"impact\"、\"whoosh\"，先不传 sfx 跑一次即列出全部预设），或对象逐条控制：{ preset } 取预设，或 { wave 波形, freq 起始频率, freqTo 结束频率（滑频）, duration 秒, decay 衰减, attack, release, gain } 自定义单音；放置字段：at 绝对起始帧（钉画面动作）、gapMs 到下一段的空隙（缺省 0）、volume 成片播放音量（0~2，缺省 1）、windowFrames 播放窗覆盖、repeat 连响次数、note 备注。收尾句式「riser→impact→sparkle」一次给三条并用 at 钉在收束帧上即可。",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  preset: { type: "string", description: "预设音效名或中文关键词（如 riser / 上升 / impact / sparkle）" },
                  wave: { type: "string", enum: [...SFX_WAVES], description: "自定义波形：sine 正弦 / square 方波 / triangle 三角 / saw 锯齿 / noise 噪声（noise 时 freq 为低通截止）" },
                  freq: { type: "number", description: "自定义：起始频率（Hz）；noise 时为低通截止" },
                  freqTo: { type: "number", description: "自定义：结束频率（Hz）——与 freq 不同即滑频" },
                  duration: { type: "number", description: `自定义：时长（秒，0.01~${SFX_MAX_SECONDS}，缺省 0.3）` },
                  decay: { type: "number", description: "自定义：指数衰减速率（1/秒；打击类用 3~20）" },
                  attack: { type: "number", description: "自定义：起振时长（秒，缺省 5 毫秒）" },
                  release: { type: "number", description: "自定义：收尾时长（秒，缺省 20 毫秒）" },
                  gain: { type: "number", description: "自定义：层内相对增益 0~1（缺省 0.5）" },
                  at: { type: "number", description: "绝对起始帧（钉画面动作；缺省接上一段）" },
                  gapMs: { type: "number", description: "到下一段的空隙（毫秒，缺省 0）" },
                  volume: { type: "number", description: "成片里的播放音量倍数 0~2（缺省 1）" },
                  windowFrames: { type: "number", description: "播放窗帧数（缺省按音频时长向上取整）" },
                  repeat: { type: "number", description: "连响次数 1~20（缺省 1）" },
                  repeatGapMs: { type: "number", description: "连响间隔（毫秒，缺省 120）" },
                  note: { type: "string", description: "备注（写进生成表，指明对应画面动作）" },
                },
              },
            ],
          },
        },
        sampleRate: { type: "number", description: `action=sfx：采样率 ${SFX_SAMPLE_RATE.min}~${SFX_SAMPLE_RATE.max}（缺省 ${SFX_SAMPLE_RATE.fallback}）` },
        name: { type: "string", description: "产物名（决定 WAV 前缀与字幕文件名，默认 narration；action=sfx 时默认 sfx；只能用字母/数字/点/下划线/连字符）" },
        voice: { type: "string", description: "音色名（缺省用 TTS_VOICE 环境变量或本机中文女声；先用 action=voices 看候选）" },
        rate: { type: "number", description: `语速百分比 ${TTS_RATE.min}~${TTS_RATE.max}（负慢正快，默认 0）` },
        pitch: { type: "number", description: `音调百分比 ${TTS_PITCH.min}~${TTS_PITCH.max}（负低正高，默认 0）` },
        volume: { type: "number", description: `合成音量百分比 ${TTS_VOLUME.min}~${TTS_VOLUME.max}（默认 0）` },
        engine: { type: "string", enum: [...TTS_ENGINES], description: "语音引擎：auto（默认，WinRT 优先 SAPI 回退）/ winrt / sapi" },
        start: { type: "number", description: "第一条的起始帧（默认 0；片头留白用它）" },
        gapMs: { type: "number", description: `句间隙毫秒（默认 ${VOICE_DEFAULT_GAP_MS}；每条可用 gapMs 覆盖）` },
        fps: { type: "number", description: `帧率（默认 ${VOICE_DEFAULT_FPS}，与 timeline.FPS 保持一致）` },
        gain: { type: "number", description: "配音在成片中的音量倍数（0~2，默认 1；写进 VOICEOVER 表的 volume）" },
        preview: { type: "boolean", description: "是否额外出整段旁白预览音轨 out/audio/<name>-voiceover.wav（默认 true，附在结果里可直接听）" },
        json: { type: "string", description: "action=srt：分段 JSON 路径（缺省 out/subtitles/<name>.json）" },
        out: { type: "string", description: "action=srt：SRT 输出路径（缺省 out/subtitles/<name>.srt；已存在自动追加 -v2）" },
        find: { type: "string", description: "action=voices：按音色名或语言过滤（如 慧慧 / zh）" },
      },
      [],
    ),
    outputSchema: schema(
      {
        action: { type: "string", description: "实际执行的动作" },
        projectDir: { type: "string", description: "工程目录" },
        name: { type: "string", description: "产物名" },
        fps: { type: "number", description: "帧率" },
        totalFrames: { type: "number", description: "最后一条的结束帧" },
        totalSec: { type: "number", description: "总时长（秒）" },
        estimated: { type: "boolean", description: "时长是否为估算（estimate 动作为 true）" },
        module: { type: "string", description: "生成的配音/字幕模块路径" },
        srt: { type: "string", description: "SRT 字幕文件路径" },
        json: { type: "string", description: "分段数据路径" },
        bed: { type: "string", description: "整段旁白预览音轨路径（未生成时缺省）" },
        sfxModule: { type: "string", description: "action=sfx：生成的音效数据模块路径" },
        tracks: {
          type: "array",
          description: "action=sfx：生成的音效钉帧表",
          items: schema(
            {
              preset: { type: "string", description: "预设名（自定义单音为 tone）" },
              src: { type: "string", description: "public 下的音频相对路径" },
              from: { type: "number", description: "起始帧" },
              duration: { type: "number", description: "播放窗帧数" },
              durationSec: { type: "number", description: "音频时长（秒）" },
              volume: { type: "number", description: "成片播放音量" },
            },
            ["src", "from", "duration"],
          ),
        },
        cues: {
          type: "array",
          items: schema(
            {
              index: { type: "number" },
              text: { type: "string" },
              src: { type: "string" },
              voice: { type: "string" },
              from: { type: "number" },
              duration: { type: "number" },
              durationSec: { type: "number" },
            },
            ["index", "text", "from", "duration"],
          ),
        },
      },
      ["action"],
    ),
    async execute(args, ctx): Promise<ToolResult> {
      const action = String(args.action ?? "build").trim() || "build"
      const fps = Math.round(numberArg(args.fps, VOICE_DEFAULT_FPS, 1, 240))
      const gapMs = Math.round(numberArg(args.gapMs, VOICE_DEFAULT_GAP_MS, 0, 10000))
      const startFrame = Math.round(numberArg(args.start, 0, 0, 1_000_000))
      const rate = clampPercent(args.rate, TTS_RATE)
      const pitch = clampPercent(args.pitch, TTS_PITCH)
      const volume = clampPercent(args.volume, TTS_VOLUME)
      const engine = normalizeEngine(args.engine, normalizeEngine(envGet(ctx, "TTS_ENGINE")))
      const globalVoice = String(args.voice ?? "").trim() || envGet(ctx, "TTS_VOICE")

      /* ── voices：列出本机离线音色 ── */
      if (action === "voices") {
        if (!isSupportedPlatform()) {
          return { output: `${UNSUPPORTED_PLATFORM_NOTE}\n（字幕不受此限制：每条给 durationMs 即纯字幕段，字幕照烧入、SRT 照出。）` }
        }
        const run = await runTtsScript(ttsDeps(ctx), { mode: "voices", engine })
        if (!run.result?.ok) return { output: scriptFailureNote(run, engine) }
        const all = run.result.voices ?? []
        const matched = filterVoices(all, args.find ? String(args.find) : undefined)
        const shown = matched.slice(0, 50)
        if (!matched.length) {
          return { output: `没有匹配「${String(args.find ?? "")}」的音色。本机共 ${all.length} 个可用音色：\n${formatVoiceList(all.slice(0, 50))}` }
        }
        const tail = matched.length > shown.length ? `\n…（共 ${matched.length} 个匹配，已列出前 ${shown.length} 个）` : ""
        return {
          output: `本机可用离线音色（引擎 ${run.result.engine}，共 ${all.length} 个${args.find ? `，匹配 ${matched.length} 个` : ""}）——reel_voice 的 voice 参数取这里的名称或其一词：\n${formatVoiceList(shown)}${tail}`,
          data: { action, voices: shown },
        }
      }

      /* ── estimate：只估时长（分镜前定镜头窗口） ── */
      if (action === "estimate") {
        const norm = normalizeVoiceLines(args.lines)
        if (norm.problem) return { output: norm.problem }
        const items = norm.lines.map((line) => ({
          ...line,
          durationSec: line.durationMs !== undefined ? line.durationMs / 1000 : estimateSpeechSec(line.text, rate),
        }))
        const cues = layoutVoiceCues(items, { fps, startFrame, gapMs })
        const last = cues[cues.length - 1]!
        const totalFrames = last.from + last.duration
        return {
          output: [
            `解说估时（语速 ${rate >= 0 ? "+" : ""}${rate}%，偏差约 ±20%——镜头窗口请按 action=build 的实测重排）：`,
            ...cueLines(cues),
            `合计 ≈ ${secText(totalFrames / fps)} / ${totalFrames} 帧 @${fps}fps（起于第 ${startFrame} 帧）`,
            "",
            "提示：本动作不合成、不落盘，只用于分镜前定镜头长度；正式生成用 action=build（实测时长会覆盖这里的估值）。",
          ].join("\n"),
          data: { action, fps, totalFrames, totalSec: Math.round((totalFrames / fps) * 100) / 100, estimated: true, cues },
        }
      }

      const name = safeName(args.name, action === "sfx" ? "sfx" : "narration")
      if (!name) return { output: "产物名非法：name 只能用字母/数字/点/下划线/连字符（它会进 WAV 与字幕文件名）。" }
      const projectDir = resolveProjectDir(ctx, args.project ? String(args.project) : undefined)

      /* ── sfx：本地合成音效并登记进生成表（不依赖语音引擎，任何平台可用） ── */
      if (action === "sfx") {
        if (args.sfx === undefined || (Array.isArray(args.sfx) && args.sfx.length === 0)) {
          return { output: `可用预设音效（直接写进 sfx 数组即可，也可给中文关键词）：\n${formatPresetList()}\n\n收尾句式：riser（上升）→ impact（冲击）→ sparkle（闪光），用 at 分别钉在收束帧上。` }
        }
        const norm = normalizeSfxItems(args.sfx)
        if (norm.problem) return { output: norm.problem }
        if (!existsSync(join(projectDir, "src", "film"))) {
          return { output: `工程目录未就绪（${projectDir} 下没有 src/film）——先 reel_project action=init 落位模板工程，再生成音效。` }
        }
        const sampleRate = normalizeSampleRate(args.sampleRate)
        const dir = join(projectDir, SFX_WAV_DIR)
        mkdirSync(dir, { recursive: true })
        const notes: string[] = []
        const generated: Array<{ preset: string; bytes: Uint8Array; durationSec: number; note?: string; volume: number; at?: number; gapMs?: number; windowFrames?: number }> = []

        for (let i = 0; i < norm.items.length; i++) {
          const item = norm.items[i]!
          let label: string
          let audio: AudioBuffer
          if (item.preset) {
            const found = synthesizePreset(item.preset, { sampleRate })
            if (!found) {
              return { output: `第 ${i + 1} 条：没有找到音效预设「${item.preset}」。\n可用预设：\n${formatPresetList()}\n也可以不用预设：直接给 wave/freq/duration 自定义单音。` }
            }
            label = found.name
            audio = found.audio
          } else {
            label = "tone"
            audio = synthesizeLayers([item.tone!], { sampleRate })
          }
          const repeat = item.repeat ?? 1
          if (repeat > 1) {
            const gapSec = (item.repeatGapMs ?? 120) / 1000
            audio = concatAudios(Array.from({ length: repeat }, () => ({ audio, gapSec })))
          }
          const outAbs = join(dir, `${name}-${pad(i + 1)}.wav`)
          const bytes = encodeWav(audio)
          if (ctx.writeBinaryFile) await ctx.writeBinaryFile(outAbs, bytes)
          else {
            mkdirSync(dir, { recursive: true })
            writeFileSync(outAbs, bytes)
          }
          generated.push({
            preset: label,
            bytes,
            durationSec: audioDuration(audio),
            note: item.note,
            volume: Math.round((item.volume ?? 1) * 100) / 100,
            at: item.at,
            gapMs: item.gapMs,
            windowFrames: item.windowFrames,
          })
        }

        const windows = layoutSfxTracks(generated, { fps, startFrame })
        const publicDir = SFX_WAV_DIR.replace(/^public\//, "")
        const tracks = generated.map((g, i) => ({
          from: windows[i]!.from,
          duration: windows[i]!.duration,
          src: `${publicDir}/${name}-${pad(i + 1)}.wav`,
          volume: g.volume,
          note: g.note,
        }))
        // 窗口短于音频会被 Sequence 截断声音：如实提示，不静默交付半声
        const clipped = generated
          .map((g, i) => (windows[i]!.duration < g.durationSec * fps - 0.5 ? i : -1))
          .filter((i) => i >= 0)
        if (clipped.length) notes.push(`第 ${clipped.map((i) => i + 1).join("、")} 条的 windowFrames 短于音频本身，成片会把声音截短——要么放宽 windowFrames，要么改小 duration。`)

        const moduleAbs = join(projectDir, SFX_MODULE_PATH)
        await ctx.writeFile(moduleAbs, renderSfxModule(tracks, { fps, sampleRate, name }))

        const lines = tracks.map((t, i) =>
          `  ${String(i + 1).padStart(2, " ")}. ${secText(generated[i]!.durationSec).padStart(6, " ")}  帧 ${t.from}–${t.from + t.duration}  ${SFX_WAV_DIR}/${name}-${pad(i + 1)}.wav  ${generated[i]!.preset}${t.note ? `（${t.note}）` : ""}`,
        )
        const totalFrames = sfxTotalFrames(tracks)
        const blocks: ContentBlock[] = []
        for (let i = 0; i < Math.min(tracks.length, SFX_PREVIEW_BLOCKS); i++) {
          blocks.push({ type: "file", path: join(dir, `${name}-${pad(i + 1)}.wav`), name: `${name}-${pad(i + 1)}.wav`, mime: "audio/wav" })
        }
        const output = [
          `音效已生成（纯本地波形合成，未联网；与语音引擎无关，非 Windows 也可用）：${projectDir}`,
          ...lines,
          `合计 ${tracks.length} 条 / 到第 ${totalFrames} 帧（${secText(totalFrames / fps)} @${fps}fps）· ${sampleRate} 赫兹 16bit 单声道 WAV`,
          "",
          "产物：",
          `  ${SFX_MODULE_PATH}（SFX_TRACKS ${tracks.length} 条——Film.tsx 已接线，渲染即生效）`,
          `  ${SFX_WAV_DIR}/（${tracks.length} 个 WAV）`,
          tracks.length > SFX_PREVIEW_BLOCKS ? `  前 ${SFX_PREVIEW_BLOCKS} 个 WAV 已附在结果里可直接听（其余请从上面目录取）` : "  音频已附在结果里可直接听",
          "",
          "下一步：",
          "  1) 与 timeline.SFX（手工登记的素材音效）并行生效——同一动作不要两处都写",
          "  2) 音量按素材峰值与本片混音给（volume 是成片播放倍数）；改参数就重跑本动作（WAV 与数据模块覆盖写）",
          ...notes.map((n) => `注意：${n}`),
        ].filter(Boolean).join("\n")
        return {
          output,
          data: {
            action,
            projectDir,
            name,
            fps,
            totalFrames,
            totalSec: Math.round((totalFrames / fps) * 100) / 100,
            sfxModule: moduleAbs,
            tracks: tracks.map((t, i) => ({ preset: generated[i]!.preset, src: t.src, from: t.from, duration: t.duration, durationSec: Math.round(generated[i]!.durationSec * 1000) / 1000, volume: t.volume })),
          },
          blocks,
        }
      }

      /* ── srt：由分段 JSON 重出字幕（改文案改帧后免重合成） ── */
      if (action === "srt") {
        const jsonPath = resolveOutputPath(projectDir, args.json, join(VOICE_SUBTITLE_DIR, `${name}.json`))
        let parsed: SegmentsJson | null = null
        try {
          parsed = JSON.parse(await ctx.readFile(jsonPath)) as SegmentsJson
        } catch (err) {
          return { output: `分段数据读取失败（${jsonPath}）：${(err as Error).message}\n先跑 action=build 生成配音与字幕，再回来重出 SRT。` }
        }
        const cues = (parsed?.cues ?? [])
          .map((c) => ({ from: Math.max(0, Math.round(Number(c.from) || 0)), duration: Math.max(1, Math.round(Number(c.duration) || 0)), text: String(c.text ?? "") }))
          .filter((c) => c.text)
        if (!cues.length) return { output: `分段数据里没有字幕条目（${jsonPath}）——请先 action=build 生成。` }
        const useFps = Math.round(numberArg(parsed?.fps, fps, 1, 240))
        const srtAbs = resolveOutputPath(projectDir, args.out, join(VOICE_SUBTITLE_DIR, `${name}.srt`))
        const target = uniqueOutputPath(srtAbs)
        await ctx.writeFile(target.path, buildSrt(cues, useFps))
        const last = cues[cues.length - 1]!
        return {
          output: [
            `字幕已重出：${relative(projectDir, target.path)}（${cues.length} 条 · 到第 ${last.from + last.duration} 帧 / ${secText((last.from + last.duration) / useFps)} @${useFps}fps）`,
            target.renamedFrom ? `同名文件已存在，本次另存为 ${relative(projectDir, target.path)}（保留历史版本）` : "",
            `来源：${relative(projectDir, jsonPath)}——改文案/改帧号后重跑本动作即可，不必重合成配音。`,
          ].filter(Boolean).join("\n"),
          data: { action, projectDir, name, fps: useFps, srt: target.path, json: jsonPath, cues: cues.length },
          blocks: artifactBlocks(previewLogicalPath(target.path, ctx)),
        }
      }

      if (action !== "build") {
        return { output: `未知动作：${action}（可用：build / sfx / estimate / srt / voices）` }
      }

      /* ── build：合成配音 + 生成字幕 ── */
      const norm = normalizeVoiceLines(args.lines)
      if (norm.problem) return { output: norm.problem }
      if (!existsSync(join(projectDir, "src", "film"))) {
        return { output: `工程目录未就绪（${projectDir} 下没有 src/film）——先 reel_project action=init 落位模板工程，再生成配音。` }
      }
      const needsSynth = norm.lines.filter((line) => line.durationMs === undefined)
      if (needsSynth.length && !isSupportedPlatform()) {
        return {
          output: `${UNSUPPORTED_PLATFORM_NOTE}\n补救：给每条解说加 durationMs（显式时长）即可走**纯字幕**路径——不合成音频，字幕照烧入、SRT 照出。`,
        }
      }

      const wavDir = join(projectDir, VOICE_WAV_DIR)
      mkdirSync(wavDir, { recursive: true })
      const notes: string[] = []
      const durations: number[] = []
      const parts: Array<{ bytes: Uint8Array; from: number; duration: number } | null> = []
      const voicesUsed = new Set<string>()
      const enginesUsed = new Set<string>()
      let audioBytes = 0

      for (let i = 0; i < norm.lines.length; i++) {
        const line = norm.lines[i]!
        if (line.durationMs !== undefined) {
          durations.push(line.durationMs / 1000)
          parts.push(null)
          continue
        }
        if (line.text.length > TTS_MAX_TEXT) {
          return { output: `第 ${i + 1} 条解说词过长（${line.text.length} 字，上限 ${TTS_MAX_TEXT}）——拆成多条分别合成，不要截断文案。` }
        }
        const outAbs = join(wavDir, `${name}-${pad(i + 1)}.wav`)
        const existed = existsSync(outAbs)
        const result = await synth(ctx, { text: line.text, voice: line.voice ?? globalVoice, rate, pitch, volume, engine, out: outAbs })
        if (!result.ok) {
          const done = i > 0 ? `已合成的 ${i} 条 WAV 保留在 ${relative(projectDir, wavDir)}。` : ""
          return { output: `第 ${i + 1} 条配音合成失败：${result.note ?? "未知原因"}${done ? ` ${done}` : ""}` }
        }
        let bytes: Uint8Array | null = null
        try {
          bytes = await ctx.readBinaryFile(outAbs)
        } catch {
          bytes = null
        }
        const measured = bytes ? wavDurationSec(bytes) : null
        const durationSec = measured ?? result.durationSec ?? null
        if (durationSec === null || !(durationSec > 0)) {
          return { output: `第 ${i + 1} 条配音时长无法确定（WAV 头解析失败且引擎未报时长）：${outAbs}——请检查系统语音引擎后重试。` }
        }
        durations.push(durationSec)
        audioBytes += bytes?.byteLength ?? 0
        if (result.voice) voicesUsed.add(result.voice)
        if (result.engine) enginesUsed.add(result.engine)
        if (existed) notes.push(`第 ${i + 1} 条同名 WAV 已覆盖（${relative(projectDir, outAbs)}）`)
        parts.push(bytes ? { bytes, from: 0, duration: 0 } : null)
      }

      const publicDir = VOICE_WAV_DIR.replace(/^public\//, "")
      const items = norm.lines.map((line, i) => ({
        ...line,
        durationSec: durations[i]!,
        ...(line.durationMs === undefined ? { src: `${publicDir}/${name}-${pad(i + 1)}.wav` } : {}),
      }))
      const cues = layoutVoiceCues(items, { fps, startFrame, gapMs })

      // 预览音轨按排好的帧号拼接（顺序被打乱时 stitchVoiceBed 自行放弃，不让产物串位）
      const gain = Math.round(numberArg(args.gain, 1, 0, 2) * 100) / 100
      const bedReady = cues.every((cue, i) => !cue.src || !!parts[i]?.bytes)
      const bedParts = bedReady
        ? cues
            .map((cue, i) => (cue.src && parts[i] ? { bytes: parts[i]!.bytes, from: cue.from, duration: cue.duration } : null))
            .filter((p): p is { bytes: Uint8Array; from: number; duration: number } => p !== null)
        : []

      // 数据模块：Film.tsx 的唯一输入（渲染与字幕都从它取）
      const moduleAbs = join(projectDir, VOICE_MODULE_PATH)
      const voiceLabel = [...voicesUsed].join(" / ") || globalVoice
      const engineLabel = [...enginesUsed].join(" / ")
      await ctx.writeFile(moduleAbs, renderVoiceModule(cues, { fps, gain, voice: voiceLabel, engine: engineLabel }))

      // 分段数据（改文案后 action=srt 的输入；机器可读，固定名覆盖）
      const jsonAbs = join(projectDir, VOICE_SUBTITLE_DIR, `${name}.json`)
      const last = cues[cues.length - 1]!
      const totalFrames = last.from + last.duration
      const totalSec = Math.round((totalFrames / fps) * 100) / 100
      await ctx.writeFile(
        jsonAbs,
        `${JSON.stringify(
          {
            name,
            fps,
            gain,
            voice: voiceLabel,
            engine: engineLabel || undefined,
            totalFrames,
            totalSec,
            cues: cues.map((c) => ({
              index: c.index,
              text: c.text,
              src: c.src,
              voice: c.voice,
              from: c.from,
              duration: c.duration,
              durationSec: Math.round(c.durationSec * 1000) / 1000,
              gapMs: c.gapMs,
            })),
          },
          null,
          2,
        )}\n`,
      )

      // 交付字幕（帧号换算，与成片严格同源；同名自动换版，历史可回看）
      const srtTarget = uniqueOutputPath(join(projectDir, VOICE_SUBTITLE_DIR, `${name}.srt`))
      await ctx.writeFile(srtTarget.path, buildSrt(cues, fps))
      if (srtTarget.renamedFrom) notes.push(`同名字幕已存在，本次另存为 ${relative(projectDir, srtTarget.path)}（历史版本保留）`)

      // 整段旁白预览轨（渲染前就能听；格式不一致时不硬拼）
      let bedAbs: string | null = null
      if (args.preview !== false && bedParts.length) {
        const bedBytes = stitchVoiceBed(bedParts, fps)
        if (bedBytes) {
          const bedTarget = uniqueOutputPath(join(projectDir, VOICE_BED_DIR, `${name}-voiceover.wav`))
          if (ctx.writeBinaryFile) await ctx.writeBinaryFile(bedTarget.path, bedBytes)
          else {
            mkdirSync(join(projectDir, VOICE_BED_DIR), { recursive: true })
            writeFileSync(bedTarget.path, bedBytes)
          }
          bedAbs = bedTarget.path
          if (bedTarget.renamedFrom) notes.push(`同名预览音轨已存在，本次另存为 ${relative(projectDir, bedTarget.path)}`)
        } else {
          notes.push("各句音频格式不一致（多引擎/多音色混用），未合并整段预览音轨——成片音轨由渲染通道混音，不受影响。")
        }
      } else if (!bedReady && args.preview !== false) {
        notes.push("有语音段的 WAV 读不回来（文件被移走或删除），未合并整段预览音轨。")
      }

      const blocks: ContentBlock[] = []
      if (bedAbs) blocks.push(...artifactBlocks(previewLogicalPath(bedAbs, ctx)))
      blocks.push(...artifactBlocks(previewLogicalPath(srtTarget.path, ctx)))

      const pending = cues.filter((c) => c.src).length === 0 ? ["本次没有任何语音段（全部给了 durationMs）：只出字幕，成片将无声。"] : []
      const output = [
        `配音与字幕已生成（本机离线语音引擎，未联网）：${projectDir}`,
        ...cueLines(cues),
        `合计 ${secText(totalSec)} / ${totalFrames} 帧 @${fps}fps · 音色 ${voiceLabel ?? "未指定"}${engineLabel ? ` · 引擎 ${engineLabel}` : ""}${audioBytes ? ` · 音频 ${(audioBytes / 1024).toFixed(0)}KB` : ""}`,
        "",
        "产物：",
        `  ${VOICE_MODULE_PATH}（VOICEOVER ${cues.filter((c) => c.src).length} 条 / SUBTITLES ${cues.length} 条——Film.tsx 已接线，字幕随成片烧入）`,
        `  ${relative(projectDir, srtTarget.path)}（交付字幕，可外挂播放器；与成片同一份帧号）`,
        `  ${relative(projectDir, jsonAbs)}（分段数据：改文案后 action=srt 免重合成重出字幕）`,
        bedAbs ? `  ${relative(projectDir, bedAbs)}（整段旁白预览，已附在结果里可直接听）` : "",
        "",
        "下一步：",
        `  1) 镜头窗口按配音实测长度重排（TOTAL 至少 ${totalFrames} 帧），再渲染成片`,
        "  2) 有配音的句子不要再写进 timeline.CAPTIONS（同一句话两处都写会叠字）",
        "  3) 音色/语速要调整就重跑本动作（WAV 与数据模块会被覆盖，字幕与预览轨另存新版本）",
        ...pending,
        ...notes.map((n) => `注意：${n}`),
      ].filter(Boolean).join("\n")

      return {
        output,
        data: {
          action,
          projectDir,
          name,
          fps,
          totalFrames,
          totalSec,
          estimated: false,
          module: moduleAbs,
          srt: srtTarget.path,
          json: jsonAbs,
          ...(bedAbs ? { bed: bedAbs } : {}),
          cues: cues.map((c) => ({ index: c.index, text: c.text, src: c.src, voice: c.voice, from: c.from, duration: c.duration, durationSec: Math.round(c.durationSec * 1000) / 1000 })),
        },
        blocks,
      }
    },
  }
}

export const voiceTool = makeVoiceTool()
