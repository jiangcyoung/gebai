/**
 * 音效合成与音频处理基建（纯 TS 计算：零第三方依赖、离线、跨平台）。
 *
 * 与 speech.ts（系统语音引擎）分属两条通道：语音必须经操作系统语音栈，而音效与后处理都是**算术**——
 * 直接生成/改写 PCM 波形，不依赖任何系统组件，故非 Windows 平台同样可用。
 *
 * 三条能力：
 * - 合成（synthesizeLayers / synthesizePreset）：波形（正弦/方波/三角/锯齿/噪声）× 频率（可滑频）×
 *   包络（起振/收尾/指数衰减）组合成音效；`SFX_PRESETS` 是预设配方库。
 * - 效果（applyEffects）：变速不变调（相位声码器，时长变而音高不变，见 vocoder.ts）、变速（重采样，音高随之变化）、
 *   变调（OLA 时间伸缩 + 重采样，时长不变）、回声、混响（四路梳状抽头）、低通/高通（RBJ biquad）、
 *   环形调制、淡入淡出、反转、增益/归一化、裁剪。
 * - 组合（mixTracks / concatAudios）：多轨混音（轨级延迟/增益/循环铺底）与顺序拼接，采样率自动统一。
 *
 * 取舍（如实标注，不粉饰）：
 * - 变调（`pitch`）用 OLA（重叠相加 + 重采样）：音质中等，快速变化处有轻微相位伪影，语音与提示音够用。
 * - 变速不变调（`tempo`）用相位声码器 + 相位锁定：语音清晰度好，但瞬态（爆破音、鼓点）仍有涂抹（固有
 *   限制），且机时远高于其它效果——长音频按分钟计，故对其设输入时长上限。
 * - 混响是四路梳状延迟的简化模型，不是脉冲响应卷积——听感有空间感，但不是真实房间。
 * - 噪声层用固定种子的伪随机序列（同参数输出可重现），该层的 `freq` 是低通截止（原始白噪声过于刺耳）。
 * - 输出统一 16bit PCM 单声道 WAV，与系统语音引擎产物同格式，可直接拼接/混音。
 */

import { tempoShiftSamples } from "./vocoder"

/** 单声道浮点音频：样本范围 [-1, 1]。 */
export interface AudioBuffer {
  sampleRate: number
  samples: Float32Array
}

/** 支持的基础波形。 */
export const SFX_WAVES = ["sine", "square", "triangle", "saw", "noise"] as const
export type Waveform = (typeof SFX_WAVES)[number]

/** 音效层配方：一次发声单元（多个层叠加成一个音效）。 */
export interface ToneSpec {
  /** 波形，缺省 sine。noise 时 freq 表示低通截止（Hz）。 */
  wave?: Waveform
  /** 起始频率（Hz）。 */
  freq?: number
  /** 结束频率（Hz）：与 freq 不同即为线性滑频（扫频）。 */
  freqTo?: number
  /** 起始时刻（秒），缺省 0。 */
  at?: number
  /** 时长（秒），缺省 0.3。 */
  duration?: number
  /** 相对增益 0~1，缺省 0.5。 */
  gain?: number
  /** 起振时长（秒），缺省取 min(5ms, 时长/4)——不为零以避免爆音。 */
  attack?: number
  /** 收尾时长（秒），缺省取 min(20ms, 时长/4)。 */
  release?: number
  /** 指数衰减速率（1/秒）：>0 时幅度按 exp(-decay·t) 衰减（钟声/打击类必备）。 */
  decay?: number
  /** 附加谐波次数（如 [2, 3] = 叠加 2×/3× 频率，强度 0.45/h），用于加厚音色。 */
  harmonics?: number[]
}

/** 预设音效配方。 */
export interface SfxPreset {
  /** 中文说明（列给模型选）。 */
  label: string
  layers: ToneSpec[]
}

/** 预设音效名（短名，工具参数取值）。 */
export type SfxPresetName = string

/** 采样率取值域（8k 与语音引擎同档，48k 为音效默认上限）。 */
export const SFX_SAMPLE_RATE = { min: 8000, max: 192000, fallback: 44100 } as const
/** 单个音效时长上限（秒）：防误传超长参数生成巨型文件。 */
export const SFX_MAX_SECONDS = 60
/** 变速不变调（相位声码器）的**输出**时长上限（秒）：处理缓冲随输出长度增长，放慢时输出膨胀更多。 */
export const TEMPO_MAX_OUTPUT_SECONDS = 600

/** 变速不变调（tempo）的时长校验（按预计输出时长）：返回拒绝说明或 null。 */
export function tempoLimitNote(inputSec: number, tempo = 1): string | null {
  if (!Number.isFinite(inputSec) || inputSec <= 0) return null
  const factor = clampNumber(tempo, 0.25, 4, 1)
  const outputSec = inputSec / factor
  if (outputSec <= TEMPO_MAX_OUTPUT_SECONDS) return null
  const maxInput = Math.floor(TEMPO_MAX_OUTPUT_SECONDS * factor)
  return `变速不变调（tempo）的产物时长上限为 ${TEMPO_MAX_OUTPUT_SECONDS} 秒（当前参数下输入最长约 ${maxInput} 秒，放慢倍率会缩短这个上限）：请先用 trimStart/trimEnd 裁出目标片段，或分段处理后用 tts_mix 拼接。`
}

/** 数值归一：空值/非数字回落 fallback，超范围钳制。 */
export function clampNumber(value: unknown, min: number, max: number, fallback = min): number {
  if (value === undefined || value === null) return fallback
  const raw = typeof value === "number" ? value : String(value).trim()
  if (raw === "") return fallback
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 采样率归一（缺省 44100，非法值回落）。 */
export function normalizeSampleRate(value: unknown, fallback = SFX_SAMPLE_RATE.fallback): number {
  return Math.round(clampNumber(value, SFX_SAMPLE_RATE.min, SFX_SAMPLE_RATE.max, fallback))
}

/** 波形归一：未识别值回落 sine。 */
export function normalizeWave(value: unknown): Waveform {
  const v = String(value ?? "").trim().toLowerCase()
  return (SFX_WAVES as readonly string[]).includes(v) ? (v as Waveform) : "sine"
}

/** 音量百分比 → 线性增益（-100 → 0，0 → 1，+100 → 2）。 */
export function percentToGain(percent: unknown): number {
  const p = clampNumber(percent, -100, 100, 0)
  return Math.max(0, 1 + p / 100)
}

/** 固定种子伪随机（mulberry32）：噪声层可重现，便于测试与复现听感。 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 周期波形取样（phase ∈ [0,1)）。 */
function waveSample(wave: Waveform, phase: number): number {
  switch (wave) {
    case "square":
      return phase < 0.5 ? 1 : -1
    case "triangle":
      return 4 * Math.abs(phase - 0.5) - 1
    case "saw":
      return 2 * phase - 1
    default:
      return Math.sin(2 * Math.PI * phase)
  }
}

/** 单个音效层的包络（起振 × 收尾 × 指数衰减）。 */
function envelopeAt(t: number, duration: number, attack: number, release: number, decay: number): number {
  let env = 1
  if (attack > 0 && t < attack) env *= t / attack
  if (release > 0 && t > duration - release) env *= Math.max(0, (duration - t) / release)
  if (decay > 0) env *= Math.exp(-decay * t)
  return env
}

/** 渲染一个层并叠加进输出缓冲（越界部分丢弃——层时长与起始时刻已归一化）。 */
function renderLayerInto(out: Float32Array, sampleRate: number, spec: ToneSpec, seed: number): void {
  const duration = clampNumber(spec.duration, 0.005, SFX_MAX_SECONDS, 0.3)
  const at = clampNumber(spec.at, 0, SFX_MAX_SECONDS, 0)
  const gain = clampNumber(spec.gain, 0, 1, 0.5)
  const attack = spec.attack === undefined ? Math.min(0.005, duration / 4) : clampNumber(spec.attack, 0, duration, 0)
  const release = spec.release === undefined ? Math.min(0.02, duration / 4) : clampNumber(spec.release, 0, duration, 0)
  const decay = clampNumber(spec.decay, 0, 200, 0)
  const wave = normalizeWave(spec.wave)
  const from = clampNumber(spec.freq, 1, 20000, wave === "noise" ? 8000 : 440)
  const to = spec.freqTo === undefined ? from : clampNumber(spec.freqTo, 1, 20000, from)
  const harmonics = (spec.harmonics ?? []).filter((h) => h > 1 && h < 16)
  const start = Math.round(at * sampleRate)
  const count = Math.max(1, Math.round(duration * sampleRate))
  const rand = makeRandom(seed)
  let phase = 0
  let lowpass = 0
  for (let i = 0; i < count; i++) {
    const idx = start + i
    if (idx >= out.length) break
    const t = i / sampleRate
    const progress = count > 1 ? i / (count - 1) : 0
    const freq = from + (to - from) * progress
    let sample: number
    if (wave === "noise") {
      // 一阶低通：截止给低频"嗡"、给高频"嘶"；一阶滤波幅度衰减明显，输出补 2 倍增益
      const alpha = 1 - Math.exp((-2 * Math.PI * Math.max(20, freq)) / sampleRate)
      lowpass += alpha * (rand() * 2 - 1 - lowpass)
      sample = lowpass * 2
    } else {
      phase += freq / sampleRate
      phase -= Math.floor(phase)
      sample = waveSample(wave, phase)
      for (const h of harmonics) sample += waveSample(wave, (phase * h) % 1) * (0.45 / h)
    }
    out[idx] += sample * gain * envelopeAt(t, duration, attack, release, decay)
  }
}

/** 峰值限制：超过 ceiling 时整体等比缩放（叠加层可能越界，削波比降幅难听得多）。 */
export function limitPeak(audio: AudioBuffer, ceiling = 0.98): AudioBuffer {
  let peak = 0
  for (let i = 0; i < audio.samples.length; i++) {
    const v = Math.abs(audio.samples[i])
    if (v > peak) peak = v
  }
  if (peak <= ceiling || peak === 0) return audio
  const k = ceiling / peak
  const samples = new Float32Array(audio.samples.length)
  for (let i = 0; i < samples.length; i++) samples[i] = audio.samples[i] * k
  return { sampleRate: audio.sampleRate, samples }
}

/** 多层叠加合成为一个音效（顺序无关；总长为各层 (at + duration) 的最大值）。 */
export function synthesizeLayers(
  layers: ToneSpec[],
  opts: { sampleRate?: number; volumePercent?: number } = {},
): AudioBuffer {
  const sampleRate = normalizeSampleRate(opts.sampleRate)
  const usable = layers.length ? layers : [{ duration: 0.3 }]
  const totalSec = Math.max(
    0.005,
    usable.reduce((max, l) => Math.max(max, (l.at ?? 0) + (l.duration ?? 0.3)), 0),
  )
  const samples = new Float32Array(Math.max(1, Math.round(Math.min(totalSec, SFX_MAX_SECONDS) * sampleRate)))
  usable.forEach((layer, i) => renderLayerInto(samples, sampleRate, layer, 0x9e3779b9 + i * 7919))
  const gain = percentToGain(opts.volumePercent)
  if (gain !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= gain
  return limitPeak({ sampleRate, samples })
}

/** 时长（秒）：样本数 / 采样率。 */
export function audioDuration(audio: AudioBuffer): number {
  return audio.samples.length / audio.sampleRate
}

/** 路径末段文件名（逻辑路径或绝对路径均可：取末段，Windows 反斜杠一并规整）。 */
export function baseFileName(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() || "audio.wav"
}

/** 名称片段清洗（产物文件名用）：只留字母数字与下划线/短横，超长截断。 */
export function safeNamePart(text: unknown, fallback: string, maxLength = 24): string {
  const cleaned = String(text ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "")
    .slice(0, maxLength)
  return cleaned || fallback
}

/** 静音（拼接间隔、铺底预留用）。 */
export function silence(seconds: number, sampleRate: number): AudioBuffer {
  const n = Math.max(0, Math.round(clampNumber(seconds, 0, SFX_MAX_SECONDS * 10, 0) * sampleRate))
  return { sampleRate, samples: new Float32Array(n) }
}

/** 预设音效配方库：提示（反馈 / 状态）、交互（操作反馈）、氛围（转场 / 铺底）、系统（开关机 / 收尾）。 */
export const SFX_PRESETS: Record<string, SfxPreset> = {
  ding: {
    label: "叮咚（双音提示）",
    layers: [
      { wave: "sine", freq: 1046, duration: 0.5, gain: 0.45, decay: 7, harmonics: [2] },
      { wave: "sine", freq: 1568, at: 0.13, duration: 0.7, gain: 0.38, decay: 5, harmonics: [2] },
    ],
  },
  success: {
    label: "成功（上行三音）",
    layers: [
      { wave: "sine", freq: 784, duration: 0.16, gain: 0.45 },
      { wave: "sine", freq: 1046, at: 0.11, duration: 0.16, gain: 0.45 },
      { wave: "sine", freq: 1318, at: 0.22, duration: 0.45, gain: 0.45, decay: 5, harmonics: [2] },
    ],
  },
  error: {
    label: "错误（下行低音）",
    layers: [
      { wave: "triangle", freq: 330, duration: 0.22, gain: 0.5 },
      { wave: "triangle", freq: 220, at: 0.18, duration: 0.5, gain: 0.5, decay: 4 },
    ],
  },
  warning: {
    label: "警告（双脉冲）",
    layers: [
      { wave: "square", freq: 660, duration: 0.16, gain: 0.28, attack: 0.01 },
      { wave: "square", freq: 660, at: 0.26, duration: 0.24, gain: 0.28, decay: 3 },
    ],
  },
  notify: {
    label: "通知（三音轻响）",
    layers: [
      { wave: "sine", freq: 880, duration: 0.12, gain: 0.42 },
      { wave: "sine", freq: 1174, at: 0.1, duration: 0.12, gain: 0.42 },
      { wave: "sine", freq: 1568, at: 0.2, duration: 0.32, gain: 0.42, decay: 6, harmonics: [2] },
    ],
  },
  alert: {
    label: "警报（高低交替）",
    layers: [
      { wave: "square", freq: 880, duration: 0.2, gain: 0.26, attack: 0.008 },
      { wave: "square", freq: 622, at: 0.2, duration: 0.2, gain: 0.26 },
      { wave: "square", freq: 880, at: 0.4, duration: 0.2, gain: 0.26 },
      { wave: "square", freq: 622, at: 0.6, duration: 0.28, gain: 0.26, decay: 2 },
    ],
  },
  coin: {
    label: "金币（游戏双音跳）",
    layers: [
      { wave: "square", freq: 988, duration: 0.07, gain: 0.26 },
      { wave: "square", freq: 1319, at: 0.07, duration: 0.34, gain: 0.26, decay: 5 },
    ],
  },
  question: {
    label: "疑问（上行二音）",
    layers: [
      { wave: "sine", freq: 620, duration: 0.16, gain: 0.45 },
      { wave: "sine", freq: 930, at: 0.14, duration: 0.36, gain: 0.42, decay: 4 },
    ],
  },
  click: {
    label: "点击（极短脉冲）",
    layers: [{ wave: "sine", freq: 1800, duration: 0.03, gain: 0.35, attack: 0.001, release: 0.028, decay: 60 }],
  },
  key: {
    label: "按键（短促咔哒）",
    layers: [
      { wave: "noise", freq: 5200, duration: 0.012, gain: 0.16, attack: 0.001, release: 0.011 },
      { wave: "sine", freq: 2400, duration: 0.02, gain: 0.22, decay: 90 },
    ],
  },
  pop: {
    label: "弹出（滑频啵）",
    layers: [{ wave: "sine", freq: 420, freqTo: 1500, duration: 0.07, gain: 0.45, decay: 18 }],
  },
  send: {
    label: "发送（短促 whoosh）",
    layers: [{ wave: "noise", freq: 6000, freqTo: 1200, duration: 0.28, gain: 0.3, attack: 0.06, release: 0.2 }],
  },
  whoosh: {
    label: "转场（扫动风声）",
    layers: [
      { wave: "noise", freq: 300, freqTo: 2600, duration: 0.7, gain: 0.34, attack: 0.3, release: 0.38 },
      { wave: "sine", freq: 180, freqTo: 900, duration: 0.7, gain: 0.12, attack: 0.32, release: 0.34 },
    ],
  },
  riser: {
    label: "上升（渐强上滑）",
    layers: [{ wave: "sine", freq: 220, freqTo: 1760, duration: 1.2, gain: 0.32, attack: 0.95, release: 0.24 }],
  },
  faller: {
    label: "下降（下滑渐弱）",
    layers: [{ wave: "sine", freq: 1760, freqTo: 220, duration: 1.2, gain: 0.32, attack: 0.03, release: 0.9 }],
  },
  heartbeat: {
    label: "心跳（双低频拍）",
    layers: [
      { wave: "sine", freq: 62, duration: 0.16, gain: 0.62, decay: 22 },
      { wave: "sine", freq: 52, at: 0.26, duration: 0.22, gain: 0.5, decay: 16 },
      { wave: "sine", freq: 62, at: 0.86, duration: 0.16, gain: 0.62, decay: 22 },
      { wave: "sine", freq: 52, at: 1.12, duration: 0.22, gain: 0.5, decay: 16 },
    ],
  },
  tick: {
    label: "滴答（倒计时，高）",
    layers: [{ wave: "sine", freq: 2200, duration: 0.04, gain: 0.3, decay: 70 }],
  },
  tock: {
    label: "滴答（倒计时，低）",
    layers: [{ wave: "sine", freq: 1400, duration: 0.05, gain: 0.32, decay: 60 }],
  },
  laser: {
    label: "激光（急速下滑）",
    layers: [{ wave: "square", freq: 1900, freqTo: 180, duration: 0.32, gain: 0.24, decay: 5 }],
  },
  explosion: {
    label: "爆炸（噪声轰鸣）",
    layers: [
      { wave: "noise", freq: 2600, freqTo: 240, duration: 0.9, gain: 0.5, attack: 0.004, release: 0.85, decay: 3.2 },
      { wave: "sine", freq: 70, freqTo: 34, duration: 0.8, gain: 0.5, decay: 3.6 },
    ],
  },
  powerup: {
    label: "升级（上行琶音）",
    layers: [
      { wave: "square", freq: 523, duration: 0.06, gain: 0.22 },
      { wave: "square", freq: 659, at: 0.06, duration: 0.06, gain: 0.22 },
      { wave: "square", freq: 784, at: 0.12, duration: 0.06, gain: 0.22 },
      { wave: "square", freq: 1046, at: 0.18, duration: 0.34, gain: 0.24, decay: 5 },
    ],
  },
  startup: {
    label: "开机（上行和弦）",
    layers: [
      { wave: "sine", freq: 523, duration: 0.9, gain: 0.3, decay: 2.4, harmonics: [2] },
      { wave: "sine", freq: 659, at: 0.12, duration: 0.85, gain: 0.28, decay: 2.4 },
      { wave: "sine", freq: 784, at: 0.24, duration: 0.8, gain: 0.28, decay: 2.4 },
      { wave: "sine", freq: 1046, at: 0.36, duration: 0.75, gain: 0.26, decay: 2.4 },
    ],
  },
  shutdown: {
    label: "关机（下行和弦）",
    layers: [
      { wave: "sine", freq: 1046, duration: 0.35, gain: 0.26, decay: 3 },
      { wave: "sine", freq: 784, at: 0.22, duration: 0.4, gain: 0.28, decay: 3 },
      { wave: "sine", freq: 523, at: 0.44, duration: 0.85, gain: 0.32, decay: 2.2 },
    ],
  },
  end: {
    label: "结束音（和弦收尾）",
    layers: [
      { wave: "sine", freq: 523, duration: 1.1, gain: 0.3, decay: 3, harmonics: [2] },
      { wave: "sine", freq: 659, duration: 1.1, gain: 0.26, decay: 3 },
      { wave: "sine", freq: 784, duration: 1.1, gain: 0.24, decay: 3 },
    ],
  },
  sad: {
    label: "低沉（下行二音）",
    layers: [
      { wave: "triangle", freq: 392, duration: 0.32, gain: 0.4, decay: 2 },
      { wave: "triangle", freq: 294, at: 0.26, duration: 0.7, gain: 0.4, decay: 2.4 },
    ],
  },
}

/** 预设清单（名称 + 说明），供工具列出。 */
export function listSfxPresets(): Array<{ name: string; label: string }> {
  return Object.entries(SFX_PRESETS).map(([name, preset]) => ({ name, label: preset.label }))
}

/** 预设查找：精确名 → 名称包含 → 中文说明包含（「叮咚」也能命中 ding）；未命中返回 null。 */
export function findSfxPreset(query: unknown): { name: string; preset: SfxPreset } | null {
  const q = String(query ?? "").trim().toLowerCase()
  if (!q) return null
  const entries = Object.entries(SFX_PRESETS)
  const exact = entries.find(([name]) => name === q)
  if (exact) return { name: exact[0], preset: exact[1] }
  const byName = entries.find(([name]) => name.includes(q) || q.includes(name))
  if (byName) return { name: byName[0], preset: byName[1] }
  const byLabel = entries.find(([, preset]) => preset.label.toLowerCase().includes(q))
  return byLabel ? { name: byLabel[0], preset: byLabel[1] } : null
}

/** 按预设名合成音效；未命中返回 null（调用方给出可选清单）。 */
export function synthesizePreset(
  name: unknown,
  opts: { sampleRate?: number; volumePercent?: number } = {},
): { name: string; preset: SfxPreset; audio: AudioBuffer } | null {
  const found = findSfxPreset(name)
  if (!found) return null
  return { ...found, audio: synthesizeLayers(found.preset.layers, opts) }
}

/** 预设清单文本（每行一条）。 */
export function formatPresetList(): string {
  return listSfxPresets()
    .map(({ name, label }) => `- ${name}：${label}`)
    .join("\n")
}

/** 写 ASCII 标记（RIFF/WAVE/fmt /data）。 */
function writeAscii(buf: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[at + i] = text.charCodeAt(i)
}

/** 编码为 16bit PCM 单声道 WAV（与系统语音引擎产物同格式，便于拼接/混音）。 */
export function encodeWav(audio: AudioBuffer): Uint8Array {
  const n = audio.samples.length
  const buf = new Uint8Array(44 + n * 2)
  const view = new DataView(buf.buffer)
  writeAscii(buf, 0, "RIFF")
  view.setUint32(4, 36 + n * 2, true)
  writeAscii(buf, 8, "WAVE")
  writeAscii(buf, 12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, audio.sampleRate, true)
  view.setUint32(28, audio.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(buf, 36, "data")
  view.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, audio.samples[i]))
    view.setInt16(44 + i * 2, Math.round(v * 32767), true)
  }
  return buf
}

/** WAV 头部信息（解码与「只读时长」场景共用）。 */
interface WavLayout {
  formatTag: number
  channels: number
  sampleRate: number
  bits: number
  dataOffset: number
  dataSize: number
}

/** 解析 WAV 头：非 RIFF/WAVE、缺 fmt 或 data、未知编码返回 null。 */
function parseWavLayout(bytes: Uint8Array): WavLayout | null {
  if (bytes.byteLength < 44) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null
  let layout: WavLayout | null = null
  let pos = 12
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.byteLength) {
      let tag = view.getUint16(body, true)
      // WAVEFORMATEXTENSIBLE：真实编码在 SubFormat GUID 前两字节
      if (tag === 0xfffe && size >= 40) tag = view.getUint16(body + 24, true)
      layout = {
        formatTag: tag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
        dataOffset: 0,
        dataSize: 0,
      }
    } else if (id === "data" && layout) {
      // 声称的 data 长度超出实际文件 = 已截断的损坏文件：拒绝而非静默交付半段音频
      if (body + size > bytes.byteLength) return null
      layout.dataOffset = body
      layout.dataSize = size
      return layout
    }
    if (size <= 0) break
    pos = body + size + (size % 2)
  }
  return null
}

/** 解码 WAV 为单声道 Float32：支持 PCM 8/16/24/32 与 IEEE float 32/64，多声道取平均下混。 */
export function decodeWav(bytes: Uint8Array): AudioBuffer | null {
  const layout = parseWavLayout(bytes)
  if (!layout || layout.dataSize <= 0 || !layout.channels || !layout.sampleRate) return null
  const { formatTag, channels, sampleRate, bits, dataOffset, dataSize } = layout
  const isPcm = formatTag === 1 && [8, 16, 24, 32].includes(bits)
  const isFloat = formatTag === 3 && [32, 64].includes(bits)
  if (!isPcm && !isFloat) return null
  const bytesPerSample = bits / 8
  const frameBytes = bytesPerSample * channels
  const frames = Math.floor(dataSize / frameBytes)
  if (frames <= 0) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const at = dataOffset + f * frameBytes + c * bytesPerSample
      if (isFloat) sum += bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true)
      else if (bits === 8) sum += (bytes[at] - 128) / 128
      else if (bits === 16) sum += view.getInt16(at, true) / 32768
      else if (bits === 24) {
        const raw = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
        sum += ((raw << 8) >> 8) / 8388608
      } else sum += view.getInt32(at, true) / 2147483648
    }
    out[f] = sum / channels
  }
  return { sampleRate, samples: out }
}

/** 重采样（线性插值）：factor 为**速度倍率**（>1 变快变短，音高随之升高；采样率不变）。 */
export function resampleAudio(audio: AudioBuffer, factor: number): AudioBuffer {
  const f = clampNumber(factor, 0.05, 20, 1)
  if (f === 1) return audio
  const src = audio.samples
  const outLen = Math.max(1, Math.floor(src.length / f))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * f
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const a = src[i0] ?? 0
    const b = src[i0 + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return { sampleRate: audio.sampleRate, samples: out }
}

/** 统一采样率（重采样到目标率并标注新采样率；已一致则原样返回）。 */
export function toSampleRate(audio: AudioBuffer, sampleRate: number): AudioBuffer {
  const target = normalizeSampleRate(sampleRate)
  if (target === audio.sampleRate) return audio
  // resampleAudio 保持采样率标注（变速语义），此处要的是真正的换率：样本数按比率缩放、把标注改成目标率
  const resampled = resampleAudio(audio, audio.sampleRate / target)
  return { sampleRate: target, samples: resampled.samples }
}

/**
 * 时间伸缩（OLA，重叠相加）：改变时长而不改音高。输出长 = 输入长 × factor。
 * 分析帧按 hopIn = hopOut / factor 推进，Hann 窗重叠相加后按窗权重归一（hop 变化时窗和不恒定，必须归一）。
 */
function timeStretch(audio: AudioBuffer, factor: number): AudioBuffer {
  const src = audio.samples
  const sampleRate = audio.sampleRate
  const len = Math.max(1, Math.round(src.length * factor))
  const out = new Float32Array(len)
  const weights = new Float32Array(len)
  const frame = Math.max(256, Math.min(4096, Math.round(sampleRate * 0.046)))
  const hopOut = Math.round(frame / 4)
  const hopIn = Math.max(1, Math.round(hopOut / factor))
  const win = new Float32Array(frame)
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame)
  for (let frameIdx = 0; ; frameIdx++) {
    const inStart = frameIdx * hopIn
    const outStart = frameIdx * hopOut
    if (inStart + frame > src.length || outStart >= len) break
    for (let i = 0; i < frame && outStart + i < len; i++) {
      out[outStart + i] += src[inStart + i] * win[i]
      weights[outStart + i] += win[i]
    }
  }
  let last = len
  while (last > 0 && weights[last - 1] <= 1e-6) last--
  const trimmed = out.slice(0, Math.max(1, last))
  for (let i = 0; i < trimmed.length; i++) if (weights[i] > 1e-6) trimmed[i] /= weights[i]
  return { sampleRate, samples: trimmed }
}

/**
 * 变调不变速（半音）：先把时长拉伸 factor 倍（OLA，音高不变），再重采样 factor 倍（时长还原、音高 ×factor）。
 * 质量中等——OLA 不是相位声码器，快速变化处有轻微相位伪影，语音与提示音够用。
 */
export function pitchShift(audio: AudioBuffer, semitones: number): AudioBuffer {
  const st = clampNumber(semitones, -24, 24, 0)
  if (Math.abs(st) < 0.01) return audio
  const factor = Math.pow(2, st / 12)
  return resampleAudio(timeStretch(audio, factor), factor)
}

/** 按分贝调整增益（超峰自动限制，防削波）。 */
export function applyGainDb(audio: AudioBuffer, db: number): AudioBuffer {
  const d = clampNumber(db, -60, 24, 0)
  if (d === 0) return audio
  const g = Math.pow(10, d / 20)
  const samples = new Float32Array(audio.samples.length)
  for (let i = 0; i < samples.length; i++) samples[i] = audio.samples[i] * g
  return limitPeak({ sampleRate: audio.sampleRate, samples })
}

/** 峰值归一化（缺省对齐 -1dB 满刻度）。 */
export function normalizePeak(audio: AudioBuffer, ceiling = 0.891): AudioBuffer {
  let peak = 0
  for (let i = 0; i < audio.samples.length; i++) {
    const v = Math.abs(audio.samples[i])
    if (v > peak) peak = v
  }
  if (peak === 0) return audio
  const k = ceiling / peak
  const samples = new Float32Array(audio.samples.length)
  for (let i = 0; i < samples.length; i++) samples[i] = audio.samples[i] * k
  return { sampleRate: audio.sampleRate, samples }
}

/** 淡入淡出（余弦曲线，比线性更平滑）。 */
export function fadeEdges(audio: AudioBuffer, fadeInSec: number, fadeOutSec: number): AudioBuffer {
  const n = audio.samples.length
  const fadeIn = Math.max(0, Math.min(n, Math.round(clampNumber(fadeInSec, 0, SFX_MAX_SECONDS, 0) * audio.sampleRate)))
  const fadeOut = Math.max(0, Math.min(n - fadeIn, Math.round(clampNumber(fadeOutSec, 0, SFX_MAX_SECONDS, 0) * audio.sampleRate)))
  if (!fadeIn && !fadeOut) return audio
  const samples = new Float32Array(audio.samples)
  for (let i = 0; i < fadeIn; i++) samples[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn)
  for (let i = 0; i < fadeOut; i++) samples[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut)
  return { sampleRate: audio.sampleRate, samples }
}

/** 反转（倒放）。 */
export function reverseAudio(audio: AudioBuffer): AudioBuffer {
  const samples = new Float32Array(audio.samples.length)
  for (let i = 0; i < samples.length; i++) samples[i] = audio.samples[samples.length - 1 - i]
  return { sampleRate: audio.sampleRate, samples }
}

/** 裁剪：startSec 起（秒），endSec 为**尾部截去**的秒数。 */
export function trimAudio(audio: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const n = audio.samples.length
  const start = Math.max(0, Math.min(n, Math.round(clampNumber(startSec, 0, SFX_MAX_SECONDS * 10, 0) * audio.sampleRate)))
  const tail = Math.max(0, Math.min(n - start, Math.round(clampNumber(endSec, 0, SFX_MAX_SECONDS * 10, 0) * audio.sampleRate)))
  if (start === 0 && tail === 0) return audio
  return { sampleRate: audio.sampleRate, samples: audio.samples.slice(start, n - tail) }
}

/** 回声（单抽头反馈延迟）：mix 为回声分量占比（0 = 干声，1 = 满回声）。 */
export function echoEffect(audio: AudioBuffer, opts: { delayMs?: number; feedback?: number; mix?: number }): AudioBuffer {
  const delay = Math.max(1, Math.round((clampNumber(opts.delayMs, 1, 3000, 220) / 1000) * audio.sampleRate))
  const feedback = clampNumber(opts.feedback, 0, 0.95, 0.35)
  const mix = clampNumber(opts.mix, 0, 1, 0.35)
  const x = audio.samples
  const n = x.length
  const echo = new Float32Array(n)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const srcIdx = i - delay
    echo[i] = srcIdx >= 0 ? (x[srcIdx] + echo[srcIdx]) * feedback : 0
    out[i] = x[i] + mix * echo[i]
  }
  return { sampleRate: audio.sampleRate, samples: out }
}

/** 混响（四路梳状延迟的简化模型）：size 缩放延迟与衰减，mix 为湿声占比。 */
export function reverbEffect(audio: AudioBuffer, opts: { size?: number; mix?: number }): AudioBuffer {
  const size = clampNumber(opts.size, 0.2, 2, 1)
  const mix = clampNumber(opts.mix, 0, 1, 0.3)
  const decay = 0.62 + 0.22 * Math.min(1, size / 2)
  const taps = [0.0297, 0.0371, 0.0411, 0.0437].map((s) => Math.max(1, Math.round(s * size * audio.sampleRate)))
  const x = audio.samples
  const n = x.length
  const wet = new Float32Array(n)
  for (const tap of taps) {
    const comb = new Float32Array(n)
    for (let i = 0; i < n; i++) comb[i] = x[i] + (i >= tap ? comb[i - tap] * decay : 0)
    for (let i = 0; i < n; i++) wet[i] += comb[i] / taps.length
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = x[i] + mix * (wet[i] - x[i])
  return { sampleRate: audio.sampleRate, samples: out }
}

/** 双二阶滤波（RBJ cookbook，Q 缺省 0.7071 = Butterworth 平坦响应）。 */
export function biquadFilter(audio: AudioBuffer, type: "lowpass" | "highpass", cutoffHz: number, q = 0.7071): AudioBuffer {
  const sampleRate = audio.sampleRate
  const f0 = clampNumber(cutoffHz, 20, Math.max(30, sampleRate / 2 - 100), type === "lowpass" ? 4000 : 200)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * clampNumber(q, 0.1, 10, 0.7071))
  const b0 = type === "lowpass" ? (1 - cos) / 2 : (1 + cos) / 2
  const b1 = type === "lowpass" ? 1 - cos : -(1 + cos)
  const b2 = b0
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  const n = audio.samples.length
  const out = new Float32Array(n)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < n; i++) {
    const xi = audio.samples[i]
    const yi = (b0 / a0) * xi + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
    x2 = x1
    x1 = xi
    y2 = y1
    y1 = yi
    out[i] = yi
  }
  return { sampleRate, samples: out }
}

/** 环形调制（机器人音）：深度缺省 0.85，保留少量干声以免完全不可懂。 */
export function ringModulate(audio: AudioBuffer, freqHz: number, depth = 0.85): AudioBuffer {
  const f = clampNumber(freqHz, 1, 4000, 60)
  const d = clampNumber(depth, 0, 1, 0.85)
  const n = audio.samples.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const mod = 1 - d + d * Math.sin((2 * Math.PI * f * i) / audio.sampleRate)
    out[i] = audio.samples[i] * mod
  }
  return { sampleRate: audio.sampleRate, samples: out }
}

/** 混音轨。 */
export interface MixTrack {
  audio: AudioBuffer
  /** 起始延迟（秒），缺省 0。 */
  delaySec?: number
  /** 线性增益，缺省 1。 */
  gain?: number
  /** 循环铺底（垫在其它轨之下），铺到总长为止。 */
  loop?: boolean
}

/**
 * 多轨混音：各轨从自身延迟处叠加（采样率自动统一到最高轨）。
 * 总长的确定：以非循环轨的最远结束点为基准（循环轨铺到该点为止）；给了 totalSec 时取「基准」与「totalSec」的较大者——
 * 循环铺底需要比基准更长时由 totalSec 指定，非循环轨内容不会被截断。
 */
export function mixTracks(tracks: MixTrack[], opts: { totalSec?: number; sampleRate?: number } = {}): AudioBuffer {
  if (!tracks.length) return silence(0.1, normalizeSampleRate(opts.sampleRate))
  const sampleRate = normalizeSampleRate(
    opts.sampleRate ?? tracks.reduce((max, t) => Math.max(max, t.audio.sampleRate), 8000),
  )
  const items = tracks.map((track) => ({
    audio: toSampleRate(track.audio, sampleRate),
    delaySec: clampNumber(track.delaySec, 0, 3600, 0),
    gain: clampNumber(track.gain, 0, 4, 1),
    loop: track.loop === true,
  }))
  const nonLoopEnd = items.reduce((max, it) => (it.loop ? max : Math.max(max, it.delaySec + audioDuration(it.audio))), 0)
  const anyEnd = items.reduce((max, it) => Math.max(max, it.delaySec + audioDuration(it.audio)), 0)
  const base = nonLoopEnd > 0 ? nonLoopEnd : anyEnd
  const total = opts.totalSec === undefined ? Math.max(base, 0.05) : Math.max(base, clampNumber(opts.totalSec, 0.05, 3600, base))
  const n = Math.max(1, Math.round(total * sampleRate))
  const out = new Float32Array(n)
  for (const it of items) {
    const start = Math.round(it.delaySec * sampleRate)
    const src = it.audio.samples
    if (src.length === 0) continue
    if (it.loop) {
      for (let i = start; i < n; i++) out[i] += src[(i - start) % src.length] * it.gain
    } else {
      for (let i = 0; i < src.length && start + i < n; i++) out[start + i] += src[i] * it.gain
    }
  }
  return limitPeak({ sampleRate, samples: out })
}

/** 顺序拼接项：gapSec 为该段**之前**的静音（首段忽略）。 */
export interface ConcatItem {
  audio: AudioBuffer
  gapSec?: number
}

/** 顺序拼接（段间可选静音；采样率自动统一到最高项）。 */
export function concatAudios(items: ConcatItem[], opts: { sampleRate?: number; gapSec?: number } = {}): AudioBuffer {
  if (!items.length) return silence(0.1, normalizeSampleRate(opts.sampleRate))
  const sampleRate = normalizeSampleRate(
    opts.sampleRate ?? items.reduce((max, i) => Math.max(max, i.audio.sampleRate), 8000),
  )
  const defaultGap = clampNumber(opts.gapSec, 0, 3600, 0)
  const parts: Float32Array[] = []
  items.forEach((item, idx) => {
    if (idx > 0) {
      const gap = clampNumber(item.gapSec ?? defaultGap, 0, 3600, defaultGap)
      if (gap > 0) parts.push(new Float32Array(Math.round(gap * sampleRate)))
    }
    parts.push(toSampleRate(item.audio, sampleRate).samples)
  })
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Float32Array(Math.max(1, total))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return { sampleRate, samples: out }
}

/** 效果链参数（全部可选，按固定顺序施加；未给的项不动）。 */
export interface EffectSpec {
  /** 裁剪：起始秒。 */
  trimStart?: number
  /** 裁剪：尾部截去秒数。 */
  trimEnd?: number
  /** 反转（倒放）。 */
  reverse?: boolean
  /** 变调（半音，-24~24）：时长不变，质量中等（OLA）。 */
  pitch?: number
  /** 变速不变调（倍率 0.25~4）：相位声码器实现，时长随之变化而音高不变（机时远高于其它效果）。 */
  tempo?: number
  /** 变速（倍率 0.25~4）：重采样实现，音高随时长一起变。 */
  speed?: number
  /** 低通截止（Hz）。 */
  lowpass?: number
  /** 高通截止（Hz）。 */
  highpass?: number
  /** 环形调制频率（Hz）——机器人音。 */
  robot?: number
  /** 回声。 */
  echo?: { delayMs?: number; feedback?: number; mix?: number }
  /** 混响。 */
  reverb?: { size?: number; mix?: number }
  /** 淡入（秒）。 */
  fadeIn?: number
  /** 淡出（秒）。 */
  fadeOut?: number
  /** 增益（分贝，-60~24）。 */
  gainDb?: number
  /** 峰值归一化到 -1dB。 */
  normalize?: boolean
}

/** 效果链是否为空（工具据此判断"没给任何效果"）。 */
export function isEmptyEffectSpec(spec: EffectSpec): boolean {
  return (
    spec.trimStart === undefined &&
    spec.trimEnd === undefined &&
    spec.reverse !== true &&
    spec.pitch === undefined &&
    spec.tempo === undefined &&
    spec.speed === undefined &&
    spec.lowpass === undefined &&
    spec.highpass === undefined &&
    spec.robot === undefined &&
    spec.echo === undefined &&
    spec.reverb === undefined &&
    spec.fadeIn === undefined &&
    spec.fadeOut === undefined &&
    spec.gainDb === undefined &&
    spec.normalize !== true
  )
}

/**
 * 按固定顺序施加效果链：裁剪 → 反转 → 变调 → 变速不变调 → 变速 → 低通 → 高通 → 环形调制 → 回声 → 混响
 * → 淡入淡出 → 增益 → 归一化。顺序固定（而非按用户给的先后），使同一组参数的结果稳定可复现；
 * applied 如实记录真正生效的项与参数。
 */
export function applyEffects(audio: AudioBuffer, spec: EffectSpec): { audio: AudioBuffer; applied: string[] } {
  const applied: string[] = []
  let out = audio
  if (spec.trimStart !== undefined || spec.trimEnd !== undefined) {
    const start = clampNumber(spec.trimStart, 0, SFX_MAX_SECONDS * 10, 0)
    const tail = clampNumber(spec.trimEnd, 0, SFX_MAX_SECONDS * 10, 0)
    out = trimAudio(out, start, tail)
    applied.push(`裁剪（保留第 ${start.toFixed(2)} 秒起、去掉结尾 ${tail.toFixed(2)} 秒）`)
  }
  if (spec.reverse === true) {
    out = reverseAudio(out)
    applied.push("反转")
  }
  if (spec.pitch !== undefined) {
    const st = clampNumber(spec.pitch, -24, 24, 0)
    out = pitchShift(out, st)
    applied.push(`变调 ${st > 0 ? "+" : ""}${st} 半音（时长不变，OLA 实现）`)
  }
  if (spec.tempo !== undefined) {
    const factor = clampNumber(spec.tempo, 0.25, 4, 1)
    out = { sampleRate: out.sampleRate, samples: tempoShiftSamples(out.samples, out.sampleRate, factor) }
    applied.push(`变速不变调 ×${factor}（相位声码器：音高保持，瞬态略有涂抹）`)
  }
  if (spec.speed !== undefined) {
    const factor = clampNumber(spec.speed, 0.25, 4, 1)
    out = resampleAudio(out, factor)
    applied.push(`变速 ×${factor}（重采样：音高随之${factor > 1 ? "升高" : "降低"}）`)
  }
  if (spec.lowpass !== undefined) {
    const hz = clampNumber(spec.lowpass, 20, 20000, 4000)
    out = biquadFilter(out, "lowpass", hz)
    applied.push(`低通 ${Math.round(hz)} 赫兹`)
  }
  if (spec.highpass !== undefined) {
    const hz = clampNumber(spec.highpass, 20, 20000, 200)
    out = biquadFilter(out, "highpass", hz)
    applied.push(`高通 ${Math.round(hz)} 赫兹`)
  }
  if (spec.robot !== undefined) {
    const hz = clampNumber(spec.robot, 1, 4000, 60)
    out = ringModulate(out, hz)
    applied.push(`环形调制 ${Math.round(hz)} 赫兹（机器人音）`)
  }
  if (spec.echo) {
    const delayMs = clampNumber(spec.echo.delayMs, 1, 3000, 220)
    out = echoEffect(out, spec.echo)
    applied.push(`回声（延迟 ${Math.round(delayMs)} 毫秒）`)
  }
  if (spec.reverb) {
    const mix = clampNumber(spec.reverb.mix, 0, 1, 0.3)
    out = reverbEffect(out, spec.reverb)
    applied.push(`混响（湿声 ${Math.round(mix * 100)}%，简化梳状模型）`)
  }
  if (spec.fadeIn !== undefined || spec.fadeOut !== undefined) {
    const fadeIn = clampNumber(spec.fadeIn, 0, SFX_MAX_SECONDS, 0)
    const fadeOut = clampNumber(spec.fadeOut, 0, SFX_MAX_SECONDS, 0)
    out = fadeEdges(out, fadeIn, fadeOut)
    applied.push(`淡入 ${fadeIn.toFixed(2)} 秒 / 淡出 ${fadeOut.toFixed(2)} 秒`)
  }
  if (spec.gainDb !== undefined) {
    const db = clampNumber(spec.gainDb, -60, 24, 0)
    out = applyGainDb(out, db)
    applied.push(`增益 ${db > 0 ? "+" : ""}${db} 分贝`)
  }
  if (spec.normalize === true) {
    out = normalizePeak(out)
    applied.push("峰值归一化到 -1 分贝满刻度")
  }
  return { audio: out, applied }
}
