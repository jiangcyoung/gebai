/**
 * 音效工具（sfx / effect / mix）：音效合成、音频效果、混音与拼接。
 *
 * 与语音工具（speak/voices）共用会话产物目录 `tmp/tts/`，但**不依赖系统语音引擎**——纯 PCM 计算，
 * 任何平台可用（语音工具受 Windows 系统语音限制，音效工具不受）。
 */
import type { ContentBlock, Tool, ToolContext } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import { TTS_OUT_DIR, formatBytes, formatDuration } from "../../core/tts/speech"
import {
  SFX_WAVES,
  TEMPO_MAX_OUTPUT_SECONDS,
  applyEffects,
  audioDuration,
  baseFileName,
  clampNumber,
  concatAudios,
  decodeWav,
  encodeWav,
  formatPresetList,
  isEmptyEffectSpec,
  listSfxPresets,
  mixTracks,
  normalizeSampleRate,
  normalizeWave,
  safeNamePart,
  synthesizeLayers,
  synthesizePreset,
  tempoLimitNote,
  toSampleRate,
  type AudioBuffer,
  type EffectSpec,
} from "../../core/tts/audio"

/** 单个输入音频的时长上限（秒）：纯 TS 处理会整段驻留内存，超长明确拒绝而非拖垮进程。 */
const MAX_INPUT_SECONDS = 1800
/** 单个输入文件的字节上限。 */
const MAX_INPUT_BYTES = 200 * 1024 * 1024
/** 混音轨数上限。 */
const MAX_TRACKS = 16

function fileBlock(rel: string): ContentBlock {
  return { type: "file", path: rel, name: baseFileName(rel), mime: "audio/wav" }
}

/** 参数取值：空串/null 视为未给（与"给了 0"区分），非法数字视为未给。 */
function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = typeof value === "number" ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : undefined
}

/** 读取并解码 WAV：返回错误说明或音频。 */
async function readAudio(ctx: ToolContext, rel: string): Promise<{ ok: true; audio: AudioBuffer } | { ok: false; error: string }> {
  let bytes: Uint8Array
  try {
    bytes = await ctx.readBinaryFile(ctx.resolvePath(rel))
  } catch {
    return { ok: false, error: `读不到音频文件：${rel}（路径相对会话工作目录）` }
  }
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    return { ok: false, error: `${rel} 过大（${formatBytes(bytes.byteLength)}，上限 ${formatBytes(MAX_INPUT_BYTES)}）。` }
  }
  const audio = decodeWav(bytes)
  if (!audio) {
    return {
      ok: false,
      error: `${rel} 不是可解析的 WAV（仅支持未压缩 PCM 8/16/24/32 位与 IEEE float 32/64 位；MP3、AAC 等压缩格式请先转成 WAV）。`,
    }
  }
  if (audioDuration(audio) > MAX_INPUT_SECONDS) {
    return { ok: false, error: `${rel} 时长 ${formatDuration(audioDuration(audio))} 超过上限 ${formatDuration(MAX_INPUT_SECONDS)}。` }
  }
  return { ok: true, audio }
}

/** 编码落盘（16bit PCM 单声道 WAV）：返回字节数或错误说明。 */
async function writeWav(ctx: ToolContext, rel: string, audio: AudioBuffer): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
  if (!ctx.writeBinaryFile) return { ok: false, error: "当前运行环境不支持二进制文件写入，无法落盘音频产物。" }
  const bytes = encodeWav(audio)
  try {
    await ctx.writeBinaryFile(ctx.resolvePath(rel), bytes)
  } catch (err) {
    return { ok: false, error: `写入产物失败：${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, bytes: bytes.byteLength }
}

export const sfxTool: Tool = {
  name: "sfx",
  safeMode: false,
  description:
    `合成音效（纯本地计算：波形 × 频率 × 包络，离线、零安装、不依赖系统语音引擎，任何平台可用）。两种用法：① preset 取预设（list=true 可列出全部：ding 叮咚 / success 成功 / error 错误 / warning 警告 / notify 通知 / alert 警报 / coin 金币 / question 疑问 / click 点击 / key 按键 / pop 弹出 / send 发送 / whoosh 转场 / riser 上升 / faller 下降 / heartbeat 心跳 / tick·tock 滴答 / laser 激光 / explosion 爆炸 / powerup 升级 / startup 开机 / shutdown 关机 / end 结束音 / sad 低沉，也可写中文关键词如「叮咚」）；② 自定义单音：给 wave（sine/square/triangle/saw/noise）+ freq（可配 freqTo 滑频）+ duration + decay 等。产物为 16bit 单声道 WAV（可直接在聊天内播放，也可作为 tts_mix 的轨与语音混合）。参数：preset 预设名；list 只列预设；wave/freq/freqTo/duration/decay/attack/release/gain 自定义音色；repeat 重复次数（配 repeatGapMs）；volume 音量百分比；sampleRate 采样率；out 产物路径。`,
  parameters: schema(
    {
      preset: { type: "string", description: "预设音效名或中文关键词（如 ding / 叮咚 / success）；list=true 时忽略" },
      list: { type: "boolean", description: "只列出全部预设音效清单（不合成）" },
      wave: { type: "string", enum: [...SFX_WAVES], description: "自定义波形（无 preset 时用）：sine 正弦 / square 方波 / triangle 三角 / saw 锯齿 / noise 噪声（noise 时 freq 为该层的低通截止）" },
      freq: { type: "number", description: "自定义：起始频率（Hz）；noise 波形时为低通截止（缺省 8000）" },
      freqTo: { type: "number", description: "自定义：结束频率（Hz）——与 freq 不同即滑频（扫频）" },
      duration: { type: "number", description: "自定义：时长（秒，0.01~60，缺省 0.3）" },
      decay: { type: "number", description: "自定义：指数衰减速率（1/秒；钟声/打击类用 3~20，0 = 不衰减）" },
      attack: { type: "number", description: "自定义：起振时长（秒，缺省 5 毫秒）" },
      release: { type: "number", description: "自定义：收尾时长（秒，缺省 20 毫秒）" },
      gain: { type: "number", description: "自定义：相对增益 0~1（缺省 0.5）" },
      repeat: { type: "number", description: "重复次数（1~20，缺省 1；如警报连响三遍）" },
      repeatGapMs: { type: "number", description: "重复间隔（毫秒，缺省 120）" },
      volume: { type: "number", description: "音量百分比 -100~100（缺省 0）" },
      sampleRate: { type: "number", description: "采样率 8000~192000（缺省 44100；要与系统语音混音时可统一为 16000）" },
      out: { type: "string", description: "产物路径（缺省 tmp/tts/sfx-<名称>-<时间戳>.wav）" },
    },
    [],
  ),
  outputSchema: schema(
    {
      path: { type: "string", description: "产物路径（相对会话工作目录）" },
      name: { type: "string", description: "预设名或 tone（自定义）" },
      durationSec: { type: "number", description: "音频时长（秒）" },
      bytes: { type: "number", description: "产物字节数" },
      sampleRate: { type: "number", description: "采样率" },
      presets: { type: "array", items: schema({ name: { type: "string" }, label: { type: "string" } }, ["name", "label"]), description: "list=true 时的预设清单" },
    },
    ["path"],
  ),
  async execute(args, ctx) {
    if (args.list === true) {
      const presets = listSfxPresets()
      return { output: `可用预设音效（${presets.length} 个）：\n${formatPresetList()}`, data: { presets } }
    }
    const sampleRate = normalizeSampleRate(args.sampleRate)
    const volumePercent = num(args.volume)
    const presetQuery = String(args.preset ?? "").trim()
    const custom = args.wave !== undefined || args.freq !== undefined || args.duration !== undefined
    let name: string
    let audio: AudioBuffer
    if (presetQuery) {
      const found = synthesizePreset(presetQuery, { sampleRate, volumePercent })
      if (!found) {
        return { output: `没有找到音效预设「${presetQuery}」。可用预设：\n${formatPresetList()}\n也可以不用预设：直接给 wave/freq/duration 自定义单音。` }
      }
      name = found.name
      audio = found.audio
    } else if (custom) {
      name = "tone"
      audio = synthesizeLayers(
        [
          {
            wave: normalizeWave(args.wave),
            freq: num(args.freq),
            freqTo: num(args.freqTo),
            duration: num(args.duration),
            decay: num(args.decay),
            attack: num(args.attack),
            release: num(args.release),
            gain: num(args.gain),
          },
        ],
        { sampleRate, volumePercent },
      )
    } else {
      return { output: `请给 preset（预设音效名，用 list=true 查看全部）或自定义参数（wave/freq/duration 至少给一个）。\n可用预设：\n${formatPresetList()}` }
    }

    const repeat = Math.round(clampNumber(args.repeat, 1, 20, 1))
    const repeatGapMs = clampNumber(args.repeatGapMs, 0, 10000, 120)
    const notes: string[] = []
    if (repeat > 1) {
      const gapSec = repeatGapMs / 1000
      audio = concatAudios(Array.from({ length: repeat }, () => ({ audio, gapSec })))
      notes.push(`已重复 ${repeat} 次（间隔 ${Math.round(repeatGapMs)} 毫秒）。`)
    }

    const rel = String(args.out ?? "").trim() || `${TTS_OUT_DIR}/sfx-${safeNamePart(name, "sfx")}-${Date.now()}.wav`
    const written = await writeWav(ctx, rel, audio)
    if (!written.ok) return { output: written.error }

    const duration = audioDuration(audio)
    const output = [
      `已生成音效：${rel}`,
      `${presetQuery ? `预设 ${name}` : "自定义单音"}，时长 ${formatDuration(duration)}，大小 ${formatBytes(written.bytes)}（${audio.sampleRate} 赫兹，16bit 单声道 WAV）`,
      notes.join(" "),
    ]
      .filter(Boolean)
      .join("\n")
    return {
      output,
      data: { path: rel, name, durationSec: duration, bytes: written.bytes, sampleRate: audio.sampleRate },
      blocks: [fileBlock(rel)],
    }
  },
}

export const effectTool: Tool = {
  name: "effect",
  safeMode: false,
  description:
    `给音频文件施加效果（纯本地计算，任何平台可用）。可用效果：tempo 变速不变调（倍率，音高保持不变——相位声码器实现，产物时长上限 ${TEMPO_MAX_OUTPUT_SECONDS} 秒）、pitch 变调（半音，时长不变、质量中等）、speed 变速（倍率，音高随时长一起变——重采样实现）、gainDb 增益、normalize 峰值归一化、fadeIn/fadeOut 淡入淡出、reverse 倒放、trimStart/trimEnd 裁剪、echo* 回声、reverb* 混响、lowpass/highpass 滤波、robot 环形调制（机器人音）。多个效果按固定顺序施加（裁剪→反转→变调→变速不变调→变速→滤波→调制→回声→混响→淡入淡出→增益→归一化），结果稳定可复现；产物为 16bit 单声道 WAV。用途：把 tts_speak 的语音调快/调慢但不变成花腔（tempo 1.3）、改成机器人音/电话音（robot 45 / lowpass 3000）、加空间感（reverbMix 0.25）、做倒放彩蛋、统一音量。参数：input 源 WAV（必填）；out 产物路径；效果参数见下。`,
  parameters: schema(
    {
      input: { type: "string", description: "源音频路径（WAV：未压缩 PCM/float；相对会话工作目录）" },
      out: { type: "string", description: "产物路径（缺省 tmp/tts/fx-<原名>-<时间戳>.wav）" },
      pitch: { type: "number", description: "变调半音数 -24~24（时长不变，OLA 实现；+12 = 升高一个八度）" },
      tempo: { type: "number", description: `变速不变调倍率 0.25~4（相位声码器：>1 变快、<1 变慢，音高保持不变；放慢时产物更长，产物时长上限 ${TEMPO_MAX_OUTPUT_SECONDS} 秒）` },
      speed: { type: "number", description: "变速倍率 0.25~4（重采样：>1 变快且音高升高，<1 变慢且音高降低）" },
      gainDb: { type: "number", description: "增益分贝 -60~24（超峰自动限制防削波）" },
      normalize: { type: "boolean", description: "峰值归一化到 -1 分贝满刻度（统一响度）" },
      fadeIn: { type: "number", description: "淡入时长（秒）" },
      fadeOut: { type: "number", description: "淡出时长（秒）" },
      reverse: { type: "boolean", description: "倒放" },
      trimStart: { type: "number", description: "裁掉开头（秒）" },
      trimEnd: { type: "number", description: "裁掉结尾（秒）" },
      echoDelayMs: { type: "number", description: "回声延迟（毫秒，缺省 220）——给了任一回声参数即启用回声" },
      echoFeedback: { type: "number", description: "回声反馈 0~0.95（缺省 0.35，越大回声次数越多）" },
      echoMix: { type: "number", description: "回声占比 0~1（缺省 0.35）" },
      reverbMix: { type: "number", description: "混响湿声占比 0~1（给了即启用混响，缺省 0.3）" },
      reverbSize: { type: "number", description: "混响空间大小 0.2~2（缺省 1，越大越空旷）" },
      lowpass: { type: "number", description: "低通截止（Hz）——如语音电话音用 3000" },
      highpass: { type: "number", description: "高通截止（Hz）——如去掉低频轰鸣用 120" },
      robot: { type: "number", description: "环形调制频率（Hz）——机器人音，常用 30~80" },
      sampleRate: { type: "number", description: "输出采样率（缺省与源一致；与其它音频混音时可统一）" },
    },
    ["input"],
  ),
  outputSchema: schema(
    {
      path: { type: "string", description: "产物路径（相对会话工作目录）" },
      source: { type: "string", description: "源音频路径" },
      applied: { type: "array", items: { type: "string" }, description: "实际生效的效果清单" },
      durationSec: { type: "number", description: "产物时长（秒）" },
      sourceDurationSec: { type: "number", description: "源音频时长（秒）" },
      bytes: { type: "number", description: "产物字节数" },
    },
    ["path", "applied"],
  ),
  async execute(args, ctx) {
    const input = String(args.input ?? "").trim()
    if (!input) return { output: "请给 input（源 WAV 路径）。" }
    const read = await readAudio(ctx, input)
    if (!read.ok) return { output: read.error }

    const echoGiven = args.echoDelayMs !== undefined || args.echoFeedback !== undefined || args.echoMix !== undefined
    const reverbGiven = args.reverbMix !== undefined || args.reverbSize !== undefined
    const spec: EffectSpec = {
      trimStart: num(args.trimStart),
      trimEnd: num(args.trimEnd),
      reverse: args.reverse === true,
      pitch: num(args.pitch),
      tempo: num(args.tempo),
      speed: num(args.speed),
      lowpass: num(args.lowpass),
      highpass: num(args.highpass),
      robot: num(args.robot),
      echo: echoGiven
        ? { delayMs: num(args.echoDelayMs), feedback: num(args.echoFeedback), mix: num(args.echoMix) }
        : undefined,
      reverb: reverbGiven ? { size: num(args.reverbSize), mix: num(args.reverbMix) } : undefined,
      fadeIn: num(args.fadeIn),
      fadeOut: num(args.fadeOut),
      gainDb: num(args.gainDb),
      normalize: args.normalize === true,
    }
    if (isEmptyEffectSpec(spec)) {
      return {
        output:
          "没有给任何效果参数。可用：tempo（变速不变调）/ pitch（变调）/ speed（变速）/ gainDb / normalize / fadeIn / fadeOut / reverse / trimStart / trimEnd / echoDelayMs(+echoFeedback/echoMix) / reverbMix(+reverbSize) / lowpass / highpass / robot。",
      }
    }

    const sourceDuration = audioDuration(read.audio)
    let startedAt = 0
    if (spec.tempo !== undefined) {
      // 上限按裁剪后的有效时长与倍率折算：先裁出短片段再做变速不变调是可行的用法
      const effective = sourceDuration - (num(args.trimStart) ?? 0) - (num(args.trimEnd) ?? 0)
      const tooLong = tempoLimitNote(Math.max(0, effective), spec.tempo)
      if (tooLong) return { output: tooLong }
      startedAt = Date.now()
    }
    const result = applyEffects(read.audio, spec)
    let audio = result.audio
    if (audio.samples.length === 0) return { output: "效果处理后音频为空——请检查 trimStart/trimEnd 是否裁掉了全部内容。" }
    const targetRate = num(args.sampleRate)
    if (targetRate !== undefined) audio = toSampleRate(audio, normalizeSampleRate(targetRate))

    const base = baseFileName(input).replace(/\.wav$/i, "")
    const rel = String(args.out ?? "").trim() || `${TTS_OUT_DIR}/fx-${safeNamePart(base, "audio")}-${Date.now()}.wav`
    const written = await writeWav(ctx, rel, audio)
    if (!written.ok) return { output: written.error }

    const duration = audioDuration(audio)
    const notes: string[] = []
    if (startedAt) notes.push(`相位声码器处理耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒。`)
    const output = [
      `已处理音频：${rel}`,
      `源 ${input}（${formatDuration(sourceDuration)}）→ 产物 ${formatDuration(duration)}，大小 ${formatBytes(written.bytes)}（${audio.sampleRate} 赫兹，16bit 单声道 WAV）`,
      `生效效果：${result.applied.join("；")}`,
      notes.join(" "),
    ]
      .filter(Boolean)
      .join("\n")
    return {
      output,
      data: {
        path: rel,
        source: input,
        applied: result.applied,
        durationSec: duration,
        sourceDurationSec: sourceDuration,
        bytes: written.bytes,
      },
      blocks: [fileBlock(rel)],
    }
  },
}

export const mixTool: Tool = {
  name: "mix",
  safeMode: false,
  description:
    `混音与拼接（纯本地计算，任何平台可用）——把多个音频合成为一个：① mode="mix"（缺省）多轨叠加，适合「开场提示音 + 语音 + 结束音」一次性成段，或给语音垫一层低音量循环背景音（轨的 loop=true + durationSec 指定总长）；② mode="sequence" 按数组顺序首尾相接（gapMs 段间静音）。各轨采样率自动统一（取最高），产物 16bit 单声道 WAV。典型用法：先 tts_speak 合成语音、tts_sfx 生成提示音，再用本工具按 delayMs 排布混成一条。参数：tracks 轨列表（path 必填 + delayMs 起始延迟 / gain 增益 / loop 循环铺底）；mode mix|sequence；gapMs 拼接间隔；durationSec 总长（混音铺底需长于语音时指定）；sampleRate 输出采样率；out 产物路径。`,
  parameters: schema(
    {
      tracks: {
        type: "array",
        description: "轨列表（1~16 条，顺序即拼接顺序）",
        items: schema(
          {
            path: { type: "string", description: "音频路径（WAV）" },
            delayMs: { type: "number", description: "起始延迟（毫秒，缺省 0）——把提示音排到语音前面就靠它" },
            gain: { type: "number", description: "线性增益 0~4（缺省 1；铺底背景音常用 0.15~0.3）" },
            loop: { type: "boolean", description: "循环铺底（垫到总长为止；总长由更长的非循环轨或 durationSec 决定）" },
          },
          ["path"],
        ),
      },
      mode: { type: "string", enum: ["mix", "sequence"], description: "mix 多轨叠加（缺省）/ sequence 顺序拼接" },
      gapMs: { type: "number", description: "sequence 模式：段间静音（毫秒，缺省 0）" },
      durationSec: { type: "number", description: "mix 模式：目标总长（秒）——循环铺底需覆盖更长时指定；不会截断非循环轨内容" },
      sampleRate: { type: "number", description: "输出采样率（缺省取各轨最高）" },
      out: { type: "string", description: "产物路径（缺省 tmp/tts/mix-<时间戳>.wav）" },
    },
    ["tracks"],
  ),
  outputSchema: schema(
    {
      path: { type: "string", description: "产物路径（相对会话工作目录）" },
      mode: { type: "string", description: "mix / sequence" },
      trackCount: { type: "number", description: "轨数" },
      durationSec: { type: "number", description: "产物时长（秒）" },
      bytes: { type: "number", description: "产物字节数" },
    },
    ["path", "mode"],
  ),
  async execute(args, ctx) {
    const rawTracks = Array.isArray(args.tracks) ? args.tracks : []
    if (!rawTracks.length) {
      return { output: "请给 tracks（至少一条轨：{ path, delayMs?, gain?, loop? }）。" }
    }
    if (rawTracks.length > MAX_TRACKS) {
      return { output: `轨数过多（${rawTracks.length}，上限 ${MAX_TRACKS}）——分段多次混音，或先用 sequence 拼出中段。` }
    }
    const parsed: Array<{ path: string; delaySec?: number; gain?: number; loop?: boolean }> = []
    for (const raw of rawTracks) {
      const track = (raw ?? {}) as Record<string, unknown>
      const path = String(track.path ?? "").trim()
      if (!path) return { output: "轨缺少 path（音频路径）。" }
      parsed.push({
        path,
        delaySec: num(track.delayMs) === undefined ? undefined : (num(track.delayMs) as number) / 1000,
        gain: num(track.gain),
        loop: track.loop === true,
      })
    }

    const audios: AudioBuffer[] = []
    for (const track of parsed) {
      const read = await readAudio(ctx, track.path)
      if (!read.ok) return { output: read.error }
      audios.push(read.audio)
    }

    const mode = String(args.mode ?? "mix").trim().toLowerCase() === "sequence" ? "sequence" : "mix"
    const sampleRate = num(args.sampleRate)
    const notes: string[] = []
    let audio: AudioBuffer
    if (mode === "sequence") {
      const gapMs = clampNumber(args.gapMs, 0, 60000, 0)
      audio = concatAudios(
        audios.map((a) => ({ audio: a, gapSec: gapMs / 1000 })),
        { sampleRate },
      )
      if (args.durationSec !== undefined || audios.some((_, i) => parsed[i].loop)) {
        notes.push("sequence 模式下 delayMs/loop/durationSec 不生效（顺序拼接只看数组顺序与 gapMs）。")
      }
    } else {
      const totalSec = num(args.durationSec)
      audio = mixTracks(
        audios.map((a, i) => ({ audio: a, delaySec: parsed[i].delaySec, gain: parsed[i].gain, loop: parsed[i].loop })),
        { totalSec, sampleRate },
      )
      const allLoop = parsed.every((t) => t.loop)
      if (allLoop && totalSec === undefined) {
        notes.push("所有轨都是循环铺底且未给 durationSec：产物只有一周期长度——要铺更长请指定 durationSec。")
      }
    }

    const rel = String(args.out ?? "").trim() || `${TTS_OUT_DIR}/mix-${Date.now()}.wav`
    const written = await writeWav(ctx, rel, audio)
    if (!written.ok) return { output: written.error }

    const duration = audioDuration(audio)
    const output = [
      `已完成${mode === "sequence" ? "拼接" : "混音"}：${rel}`,
      `${parsed.length} 轨 → 时长 ${formatDuration(duration)}，大小 ${formatBytes(written.bytes)}（${audio.sampleRate} 赫兹，16bit 单声道 WAV）`,
      notes.join(" "),
    ]
      .filter(Boolean)
      .join("\n")
    return {
      output,
      data: { path: rel, mode, trackCount: parsed.length, durationSec: duration, bytes: written.bytes },
      blocks: [fileBlock(rel)],
    }
  },
}
