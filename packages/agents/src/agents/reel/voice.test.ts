/**
 * reel_voice 测试：WAV 实测时长、解说归一与帧号排布、SRT 时间码、生成模块，音效预设与自定义单音的
 * 合成/排布/登记，以及工具各动作的落盘与失败路径。语音合成通道经注入桩替换——用例**不依赖 Windows
 * 系统语音引擎**，也不联网（音效是纯计算，不需桩）。
 *
 * 钉住的契约：① 时长来自 WAV 头实测（不是估算、不是引擎自报）；② 帧号是字幕/音频/成片的唯一坐标；
 * ③ 字幕能力不依赖配音（durationMs 走纯字幕路径）；④ 交付字幕同名自动换版，项目资产固定名覆盖；
 * ⑤ 音效与配音互不依赖（非 Windows 也能生成音效）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTtsPlatform } from "../../core/tts/speech"
import { clearReelEnv, makeCtx } from "./test-ctx"
import {
  buildSrt,
  estimateSpeechSec,
  layoutSfxTracks,
  layoutVoiceCues,
  makeVoiceTool,
  normalizeSfxItems,
  normalizeVoiceLines,
  readWavLayout,
  renderVoiceModule,
  SFX_MAX_ITEMS,
  SFX_MODULE_PATH,
  sfxTotalFrames,
  silentWavLike,
  srtTimecode,
  stitchVoiceBed,
  VOICE_MODULE_PATH,
  VOICE_SUBTITLE_DIR,
  VOICE_WAV_DIR,
  wavDurationSec,
  type VoiceSynthRequest,
} from "./voice"

// 平台判定注入：合成/字幕/音效用例按本机内置离线引擎路径断言，平台经 setTtsPlatform 注入，
// 不随宿主平台漂移（「纯字幕路径」「音效不依赖语音引擎」用例单独覆写并在结束时还原）。
beforeAll(() => setTtsPlatform("win32"))
afterAll(() => setTtsPlatform(undefined))

/** 造一段带头部的 PCM WAV（时长 = samples / sampleRate）。 */
function makeWav(seconds: number, sampleRate = 16000, channels = 1, bits = 16): Uint8Array {
  const blockAlign = channels * (bits / 8)
  const dataBytes = Math.round(sampleRate * seconds) * blockAlign
  const buf = new Uint8Array(44 + dataBytes)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i)
  }
  const u32 = (at: number, v: number) => {
    buf[at] = v & 0xff
    buf[at + 1] = (v >>> 8) & 0xff
    buf[at + 2] = (v >>> 16) & 0xff
    buf[at + 3] = (v >>> 24) & 0xff
  }
  const u16 = (at: number, v: number) => {
    buf[at] = v & 0xff
    buf[at + 1] = (v >>> 8) & 0xff
  }
  ascii(0, "RIFF")
  u32(4, 36 + dataBytes)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  u32(16, 16)
  u16(20, 1)
  u16(22, channels)
  u32(24, sampleRate)
  u32(28, sampleRate * blockAlign)
  u16(32, blockAlign)
  u16(34, bits)
  ascii(36, "data")
  u32(40, dataBytes)
  return buf
}

/** 合成桩：按文案长度造时长（8 字 = 1 秒），产物写成真 WAV——好让工具走 WAV 实测那条路。 */
const stubSynth =
  (voice = "Stub Voice") =>
  async (_ctx: unknown, req: VoiceSynthRequest) => {
    writeFileSync(req.out, makeWav(Math.max(0.25, req.text.length / 8)))
    return { ok: true, voice, engine: "winrt" as const }
  }

interface Fixture {
  ctx: ReturnType<typeof makeCtx>["ctx"]
  home: string
  projectDir: string
}

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "reel-voice-"))
  const projectDir = join(home, "proj", "film")
  mkdirSync(join(projectDir, "src", "film"), { recursive: true })
  const { ctx } = makeCtx(home, {})
  return { ctx, home, projectDir }
}

describe("WAV 解析：时长实测与静音生成", () => {
  test("从头部实测时长（PCM 16bit 单声道 / 立体声）", () => {
    expect(wavDurationSec(makeWav(1.5))).toBeCloseTo(1.5, 3)
    expect(wavDurationSec(makeWav(0.25, 24000, 2))).toBeCloseTo(0.25, 3)
  })

  test("非 WAV / 残缺内容返回 null（不猜、不当 0 秒）", () => {
    expect(wavDurationSec(new Uint8Array(0))).toBeNull()
    expect(wavDurationSec(new Uint8Array(100))).toBeNull()
    const truncated = makeWav(1).slice(0, 20)
    expect(wavDurationSec(truncated)).toBeNull()
  })

  test("data 段长度字段不可信（流式写 0）时按实际字节算", () => {
    const wav = makeWav(1)
    const u32At = (at: number, v: number) => {
      wav[at] = v & 0xff
      wav[at + 1] = (v >>> 8) & 0xff
      wav[at + 2] = (v >>> 16) & 0xff
      wav[at + 3] = (v >>> 24) & 0xff
    }
    u32At(40, 0)
    expect(wavDurationSec(wav)).toBeCloseTo(1, 3)
  })

  test("静音段沿用源文件格式（采样率/声道/位深）", () => {
    const layout = readWavLayout(makeWav(1, 22050, 2))!
    const silence = silentWavLike(layout, 22050) // 1 秒
    expect(wavDurationSec(silence)).toBeCloseTo(1, 3)
    const back = readWavLayout(silence)!
    expect(back.sampleRate).toBe(22050)
    expect(back.channels).toBe(2)
    expect(back.blockAlign).toBe(4)
  })

  test("整段预览轨按帧排布补静音；格式不一致时放弃（不硬拼失真音频）", () => {
    const a = makeWav(1)
    const b = makeWav(0.5)
    // 30fps：第 0 帧起 1s（30 帧）→ 第 60 帧起 0.5s（15 帧）→ 总长应到 75 帧 = 2.5s
    const bed = stitchVoiceBed(
      [
        { bytes: a, from: 0, duration: 30 },
        { bytes: b, from: 60, duration: 15 },
      ],
      30,
    )!
    expect(bed).not.toBeNull()
    expect(wavDurationSec(bed)).toBeCloseTo(2.5, 2)
    // 采样率不同 → 拼接会把两段听成变速，必须拒绝
    expect(stitchVoiceBed([{ bytes: a, from: 0, duration: 30 }, { bytes: makeWav(0.5, 8000), from: 30, duration: 15 }], 30)).toBeNull()
    // 锚点把顺序打乱 → 拼接会串位，同样拒绝
    expect(stitchVoiceBed([{ bytes: a, from: 60, duration: 30 }, { bytes: b, from: 0, duration: 15 }], 30)).toBeNull()
  })
})

describe("解说词归一与帧号排布", () => {
  test("字符串按行拆；空行跳过", () => {
    const { lines, problem } = normalizeVoiceLines("第一句\n\n  第二句  \n")
    expect(problem).toBeUndefined()
    expect(lines.map((l) => l.text)).toEqual(["第一句", "第二句"])
  })

  test("对象项：错误带条号（便于一次改对）", () => {
    expect(normalizeVoiceLines([{ text: "" }]).problem).toContain("第 1 条解说词为空")
    expect(normalizeVoiceLines(["ok", 42]).problem).toContain("第 2 条不是文本或对象")
    expect(normalizeVoiceLines([{ text: "x", at: -1 }]).problem).toContain("at 不是非负数")
    expect(normalizeVoiceLines([{ text: "x", durationMs: 0 }]).problem).toContain("durationMs 须大于 0")
    expect(normalizeVoiceLines(undefined).problem).toContain("未给出解说词")
  })

  test("顺序排布：句间隙按帧换算，语音段与纯字幕段混排", () => {
    const cues = layoutVoiceCues(
      [
        { text: "A", durationSec: 1 },
        { text: "B", durationMs: 500 },
        { text: "C", durationSec: 2, gapMs: 0 },
      ],
      { fps: 30, gapMs: 300 },
    )
    expect(cues.map((c) => [c.from, c.duration])).toEqual([
      [0, 30],
      [39, 15],
      [63, 60],
    ])
    expect(cues[1]!.gapMs).toBe(300)
    expect(cues[2]!.gapMs).toBe(0)
  })

  test("at 钉帧：起点由锚点决定（对齐镜头），并成为后续条目的新基准", () => {
    const cues = layoutVoiceCues(
      [
        { text: "A", durationSec: 1, at: 100 },
        { text: "B", durationSec: 0.5 },
      ],
      { fps: 30, gapMs: 0 },
    )
    expect(cues[0]!.from).toBe(100)
    expect(cues[1]!.from).toBe(130)
  })

  test("时长至少 1 帧（0 帧字幕看不见）", () => {
    const cues = layoutVoiceCues([{ text: "x", durationSec: 0.001 }], { fps: 30 })
    expect(cues[0]!.duration).toBe(1)
  })

  test("估算：中文按字数、语速按比例缩放，标注为估值", () => {
    const base = estimateSpeechSec("一套视觉语言，贯穿全部模块", 0)
    expect(base).toBeGreaterThan(2.5)
    expect(base).toBeLessThan(3.8)
    expect(estimateSpeechSec("一套视觉语言，贯穿全部模块", 100)).toBeCloseTo(base / 2, 1)
    expect(estimateSpeechSec("Hello world, this is a test.", 0)).toBeGreaterThan(1.5)
  })
})

describe("字幕：时间码、SRT 与生成模块", () => {
  test("帧 → SRT 时间码（由帧换算，与成片同帧）", () => {
    expect(srtTimecode(0, 30)).toBe("00:00:00,000")
    expect(srtTimecode(45, 30)).toBe("00:00:01,500")
    expect(srtTimecode(30 * 3661, 30)).toBe("01:01:01,000")
  })

  test("SRT：序号 + 时间码 + 文案，条目间空行；空表不产出假字幕", () => {
    const srt = buildSrt(
      [
        { from: 0, duration: 30, text: "第一句" },
        { from: 39, duration: 15, text: "第二句" },
      ],
      30,
    )
    expect(srt).toBe("1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,300 --> 00:00:01,800\n第二句\n")
    expect(buildSrt([], 30)).toBe("")
  })

  test("生成模块：配音表与字幕表同窗，文案按 JSON 转义，无随机/时间源", () => {
    const cues = layoutVoiceCues(
      [
        { text: '带"引号"的一句', durationSec: 1, src: "audio/voice/narration-01.wav" },
        { text: "纯字幕段", durationMs: 500 },
      ],
      { fps: 30 },
    )
    const text = renderVoiceModule(cues, { fps: 30, gain: 0.9, voice: "Huihui", engine: "winrt" })
    expect(text).toContain('export const VOICEOVER: Array<{ from: number; duration: number; src: string; volume: number; text: string }> = [')
    expect(text).toContain('{ from: 0, duration: 30, src: "audio/voice/narration-01.wav", volume: 0.9, text: "带\\"引号\\"的一句" },')
    expect(text).toContain('export const SUBTITLES: Array<{ from: number; duration: number; text: string }> = [')
    expect(text).toContain('{ from: 39, duration: 15, text: "纯字幕段" },')
    expect(text).toContain("segments: 2, totalFrames: 54")
    expect(text).not.toContain("Date.now(")
    expect(text).not.toContain("Math.random(")
  })
})

describe("reel_voice 工具：build / estimate / srt 与失败路径", () => {
  test("build：逐句合成、实测时长、写数据模块/JSON/SRT/预览轨", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const res = await tool.execute({ action: "build", project: projectDir, name: "narration", lines: ["一二三四五六七八", { text: "第二句", durationMs: 500 }] }, ctx)
      const data = res.data as Record<string, unknown>

      // 8 字 → 1 秒（桩），第二句 500ms；默认句间隙 300ms = 9 帧
      expect((data.cues as Array<Record<string, unknown>>)[0]!.durationSec).toBe(1)
      expect(data.totalFrames).toBe(54)
      expect(data.totalSec).toBeCloseTo(1.8, 3)

      // 项目资产：WAV 固定名（成片按它取音）、数据模块固定名
      const wav = join(projectDir, VOICE_WAV_DIR, "narration-01.wav")
      expect(existsSync(wav)).toBe(true)
      expect(wavDurationSec(new Uint8Array(readFileSync(wav)))!).toBeCloseTo(1, 3)
      expect(existsSync(join(projectDir, VOICE_WAV_DIR, "narration-02.wav"))).toBe(false) // 纯字幕段不合成

      const module = readFileSync(join(projectDir, VOICE_MODULE_PATH), "utf8")
      expect(module).toContain('src: "audio/voice/narration-01.wav"')
      expect(module).toContain('text: "第二句"')
      expect(module).toContain("segments: 2, totalFrames: 54")

      // 交付字幕与分段数据
      const srtPath = String(data.srt)
      expect(srtPath.endsWith("narration.srt")).toBe(true)
      expect(readFileSync(srtPath, "utf8")).toBe(
        "1\n00:00:00,000 --> 00:00:01,000\n一二三四五六七八\n\n2\n00:00:01,300 --> 00:00:01,800\n第二句\n",
      )
      const json = JSON.parse(readFileSync(String(data.json), "utf8")) as { fps: number; cues: unknown[] }
      expect(json.fps).toBe(30)
      expect(json.cues.length).toBe(2)

      // 整段预览轨：只覆盖到最后一句语音（尾部留白不补），段间静音按帧补齐——渲染前就能听
      const bed = String(data.bed)
      expect(wavDurationSec(new Uint8Array(readFileSync(bed)))!).toBeCloseTo(1, 2)
      expect((res.blocks ?? []).length).toBe(2)
      expect(res.output).toContain("本机离线语音引擎，未联网")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("重复 build：项目资产覆盖（成片始终取同一路径），交付字幕换新版本", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const args = { action: "build", project: projectDir, name: "narration", lines: ["一二三四五六七八"] }
      const first = await tool.execute(args, ctx)
      const second = await tool.execute(args, ctx)
      expect(String((first.data as Record<string, unknown>).srt).endsWith("narration.srt")).toBe(true)
      expect(String((second.data as Record<string, unknown>).srt).endsWith("narration-v2.srt")).toBe(true)
      expect(existsSync(join(projectDir, VOICE_WAV_DIR, "narration-01.wav"))).toBe(true)
      expect((second.output as string)).toContain("另存为")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("estimate：只估算、不落盘（分镜前定镜头窗口用）", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const res = await tool.execute({ action: "estimate", project: projectDir, lines: ["一二三四五六七八"] }, ctx)
      const data = res.data as Record<string, unknown>
      expect(data.estimated).toBe(true)
      expect((data.cues as Array<{ duration: number }>)[0]!.duration).toBeGreaterThan(0)
      expect(existsSync(join(projectDir, VOICE_MODULE_PATH))).toBe(false)
      expect(existsSync(join(projectDir, VOICE_SUBTITLE_DIR))).toBe(false)
      expect(res.output).toContain("±20%")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("srt：由分段数据重出字幕（改文案后免重合成）", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      await tool.execute({ action: "build", project: projectDir, name: "narration", lines: ["一二三四五六七八"] }, ctx)
      // 改文案：只动分段数据，不重合成
      const jsonPath = join(projectDir, VOICE_SUBTITLE_DIR, "narration.json")
      const json = JSON.parse(readFileSync(jsonPath, "utf8")) as { cues: Array<{ text: string }> }
      json.cues[0]!.text = "改过的文案"
      writeFileSync(jsonPath, JSON.stringify(json))
      const res = await tool.execute({ action: "srt", project: projectDir, name: "narration" }, ctx)
      const srt = String((res.data as Record<string, unknown>).srt)
      expect(srt.endsWith("narration-v2.srt")).toBe(true)
      expect(readFileSync(srt, "utf8")).toContain("改过的文案")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("纯字幕路径：不需要语音引擎（无配音的平台照出字幕）", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    setTtsPlatform("linux")
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const ok = await tool.execute(
        { action: "build", project: projectDir, lines: [{ text: "只有字幕", at: 60, durationMs: 1200 }] },
        ctx,
      )
      const data = ok.data as Record<string, unknown>
      expect(data.totalFrames).toBe(60 + 36)
      const module = readFileSync(join(projectDir, VOICE_MODULE_PATH), "utf8")
      expect(module).toContain("export const VOICEOVER: Array<{ from: number; duration: number; src: string; volume: number; text: string }> = [\n]")
      expect(module).toContain('{ from: 60, duration: 36, text: "只有字幕" },')
      expect(existsSync(String(data.bed))).toBe(false)
      expect(ok.output).toContain("成片将无声")

      // 有语音段时明确拒绝：不静默降级，给出可执行的补救
      const denied = await tool.execute({ action: "build", project: projectDir, lines: ["要配音的一句"] }, ctx)
      expect(denied.output).toContain("语音合成不可用")
      expect(denied.output).toContain("durationMs")

      const voices = await tool.execute({ action: "voices" }, ctx)
      expect(voices.output).toContain("语音合成不可用")
    } finally {
      setTtsPlatform("win32")
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("失败路径：工程未就绪 / 产物名越界 / 文案过长 / 合成失败 / 未知动作", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const empty = join(home, "empty-proj")
      mkdirSync(empty, { recursive: true })
      expect((await tool.execute({ action: "build", project: empty, lines: ["x"] }, ctx)).output).toContain("工程目录未就绪")
      expect((await tool.execute({ action: "build", project: projectDir, name: "../evil", lines: ["x"] }, ctx)).output).toContain("产物名非法")
      expect((await tool.execute({ action: "build", project: projectDir, lines: ["x".repeat(4001)] }, ctx)).output).toContain("过长")

      const failing = makeVoiceTool({ synth: async () => ({ ok: false, note: "引擎缺失" }) })
      const failed = await failing.execute({ action: "build", project: projectDir, lines: ["x"] }, ctx)
      expect(failed.output).toContain("第 1 条配音合成失败：引擎缺失")

      expect((await tool.execute({ action: "nope", project: projectDir }, ctx)).output).toContain("未知动作")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("合成失败带上已完成的进度（不把半成品当成完成）", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      let call = 0
      const flaky = makeVoiceTool({
        synth: async (c, req) => {
          call += 1
          if (call === 2) return { ok: false, note: "第二条崩了" }
          return stubSynth()(c, req)
        },
      })
      const res = await flaky.execute({ action: "build", project: projectDir, lines: ["第一句", "第二句", "第三句"] }, ctx)
      expect(res.output).toContain("第 2 条配音合成失败：第二条崩了")
      expect(res.output).toContain("已合成的 1 条 WAV 保留在")
      expect(existsSync(join(projectDir, VOICE_MODULE_PATH))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("音效：条目归一与排布", () => {
  test("字符串即预设名；空项跳过", () => {
    const { items, problem } = normalizeSfxItems(["riser", "  ", "impact"])
    expect(problem).toBeUndefined()
    expect(items.map((i) => i.preset)).toEqual(["riser", "impact"])
  })

  test("对象项：错误带条号（便于一次改对）", () => {
    expect(normalizeSfxItems([]).problem).toContain("未给出音效")
    expect(normalizeSfxItems([{ at: 30 }]).problem).toContain("既没有 preset 也没有自定义参数")
    expect(normalizeSfxItems([{ preset: "riser", wave: "sine" }]).problem).toContain("两者二选一")
    expect(normalizeSfxItems(["riser", { at: -1 }]).problem).toContain("第 2 条")
    expect(normalizeSfxItems(Array.from({ length: SFX_MAX_ITEMS + 1 }, () => "ding")).problem).toContain("条数过多")
  })

  test("自定义单音：wave/freq/freqTo/duration/decay 与层内增益", () => {
    const { items } = normalizeSfxItems([{ wave: "sine", freq: 200, freqTo: 1200, duration: 1.2, decay: 2, gain: 0.4, volume: 0.6, note: "落位" }])
    expect(items[0]!.tone).toEqual({ wave: "sine", freq: 200, freqTo: 1200, duration: 1.2, decay: 2, attack: undefined, release: undefined, gain: 0.4 })
    expect(items[0]!.volume).toBe(0.6)
    expect(items[0]!.note).toBe("落位")
  })

  test("排布：at 钉帧、缺省接上一段且无空隙（音效贴着动作）", () => {
    const tracks = layoutSfxTracks(
      [
        { at: 100, durationSec: 1.2 },
        { durationSec: 0.5 },
        { at: 300, durationSec: 0.4 },
      ],
      { fps: 30 },
    )
    expect(tracks[0]).toEqual({ from: 100, duration: 36 })
    expect(tracks[1]).toEqual({ from: 136, duration: 15 })
    expect(tracks[2]).toEqual({ from: 300, duration: 12 })
  })

  test("排布：窗口按音频时长向上取整（不向下取——窗口短于音频会截断声音）", () => {
    expect(layoutSfxTracks([{ durationSec: 1.2 }], { fps: 30 })[0]).toEqual({ from: 0, duration: 36 })
    expect(layoutSfxTracks([{ durationSec: 1.201 }], { fps: 30 })[0]!.duration).toBe(37)
    expect(layoutSfxTracks([{ durationSec: 0.001 }], { fps: 30 })[0]!.duration).toBe(1)
  })

  test("总长取最大结束帧（at 乱序给时不能取最后一条——收尾组常常写在前面）", () => {
    expect(sfxTotalFrames([{ from: 560, duration: 36 }, { from: 150, duration: 21 }])).toBe(596)
    expect(sfxTotalFrames([{ from: 560, duration: 36 }, { from: 620, duration: 21 }, { from: 626, duration: 19 }])).toBe(645)
    expect(sfxTotalFrames([])).toBe(0)
  })
})

describe("reel_voice 工具：action=sfx", () => {
  test("预设三件套：生成 WAV、写钉帧表、音频附回结果", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const res = await tool.execute(
        {
          action: "sfx",
          project: projectDir,
          name: "hit",
          sfx: [{ preset: "riser", at: 600, note: "收束前起势" }, { preset: "impact", at: 660, volume: 0.8 }, "sparkle"],
        },
        ctx,
      )
      const data = res.data as Record<string, unknown>
      const tracks = data.tracks as Array<Record<string, unknown>>
      expect(tracks.length).toBe(3)
      expect(tracks[0]!.from).toBe(600)
      expect(tracks[1]!.from).toBe(660)
      expect(tracks[1]!.volume).toBe(0.8)
      // 第三条未给 at：接在 impact 之后（窗口 = 音频帧数）
      expect(tracks[2]!.from).toBe(660 + Number(tracks[1]!.duration))
      expect(tracks.map((t) => t.preset)).toEqual(["riser", "impact", "sparkle"])

      // 三个 WAV 都是可解析的真音频（非空、时长与登记一致）
      for (let i = 1; i <= 3; i++) {
        const wav = join(projectDir, "public", "audio", "sfx", `hit-0${i}.wav`)
        expect(existsSync(wav)).toBe(true)
        const sec = wavDurationSec(new Uint8Array(readFileSync(wav)))!
        expect(sec).toBeGreaterThan(0.2)
        expect(Math.ceil(sec * 30)).toBe(Number(tracks[i - 1]!.duration))
      }

      const module = readFileSync(join(projectDir, SFX_MODULE_PATH), "utf8")
      expect(module).toContain("export const SFX_TRACKS: Array<{ from: number; duration: number; src: string; volume: number; note?: string }> = [")
      expect(module).toContain('{ from: 600, duration: 36, src: "audio/sfx/hit-01.wav", volume: 1, note: "收束前起势" },')
      expect(module).toContain('{ from: 660, duration: 21, src: "audio/sfx/hit-02.wav", volume: 0.8 },')
      expect(module).not.toContain("Math.random(")
      expect((res.blocks ?? []).length).toBe(3)
      expect(res.output).toContain("纯本地波形合成，未联网")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("自定义单音与连响：也能落盘并登记", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const res = await tool.execute(
        {
          action: "sfx",
          project: projectDir,
          name: "tone",
          sfx: [{ wave: "sine", freq: 220, freqTo: 1760, duration: 1.2, attack: 0.95 }, { preset: "click", repeat: 3, repeatGapMs: 200, at: 90 }],
        },
        ctx,
      )
      const data = res.data as Record<string, unknown>
      const tracks = data.tracks as Array<Record<string, unknown>>
      expect(tracks[0]!.preset).toBe("tone")
      expect(tracks[0]!.durationSec).toBeCloseTo(1.2, 2)
      // 连响三段：总长明显长于单次
      expect(Number(tracks[1]!.durationSec)).toBeGreaterThan(0.2)
      const wav = join(projectDir, "public", "audio", "sfx", "tone-02.wav")
      expect(wavDurationSec(new Uint8Array(readFileSync(wav)))!).toBeCloseTo(Number(tracks[1]!.durationSec), 2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("不带 sfx 数组 → 列出预设清单与收尾句式提示", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const res = await tool.execute({ action: "sfx", project: projectDir }, ctx)
      expect(res.output).toContain("riser")
      expect(res.output).toContain("impact")
      expect(res.output).toContain("sparkle")
      expect(res.output).toContain("riser（上升）→ impact（冲击）→ sparkle（闪光）")
      expect(existsSync(join(projectDir, SFX_MODULE_PATH))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("失败路径：未知预设 / 工程未就绪 / 窗口短于音频的告警", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const unknown = await tool.execute({ action: "sfx", project: projectDir, sfx: ["不存在音效"] }, ctx)
      expect(unknown.output).toContain("第 1 条：没有找到音效预设")
      expect(unknown.output).toContain("ding")

      const empty = join(home, "empty-proj")
      mkdirSync(empty, { recursive: true })
      expect((await tool.execute({ action: "sfx", project: empty, sfx: ["ding"] }, ctx)).output).toContain("工程目录未就绪")

      // 窗口短于音频：如实告警（不静默交付半声）
      const clipped = await tool.execute(
        { action: "sfx", project: projectDir, name: "clip", sfx: [{ preset: "impact", windowFrames: 3 }] },
        ctx,
      )
      expect(clipped.output).toContain("短于音频本身")
      expect((clipped.data as Record<string, unknown>).totalFrames).toBe(3)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("音效不依赖语音引擎（非 Windows 也可生成）", async () => {
    clearReelEnv()
    const { ctx, home, projectDir } = makeFixture()
    setTtsPlatform("linux")
    try {
      const tool = makeVoiceTool({ synth: stubSynth() })
      const res = await tool.execute({ action: "sfx", project: projectDir, sfx: ["riser", "impact", "sparkle"] }, ctx)
      expect((res.data as Record<string, unknown>).tracks).toHaveLength(3)
      expect(res.output).not.toContain("语音合成不可用")
    } finally {
      setTtsPlatform("win32")
      rmSync(home, { recursive: true, force: true })
    }
  })
})
