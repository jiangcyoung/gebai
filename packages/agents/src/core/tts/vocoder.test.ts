import { describe, expect, test } from "bun:test"
import { applyEffects, audioDuration, resampleAudio, tempoLimitNote, TEMPO_MAX_OUTPUT_SECONDS, type AudioBuffer } from "./audio"
import { pickFrameSize, tempoShiftSamples } from "./vocoder"

/** 混叠正弦测试信号（含 2、3 次谐波，接近语音的周期结构）。 */
function tone(freq: number, seconds: number, sampleRate = 22050, gain = 0.4, harmonics = false): AudioBuffer {
  const n = Math.round(seconds * sampleRate)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * freq * i) / sampleRate
    samples[i] = gain * (Math.sin(t) + (harmonics ? 0.4 * Math.sin(2 * t) + 0.2 * Math.sin(3 * t) : 0))
  }
  return { sampleRate, samples }
}

function peak(samples: Float32Array): number {
  let max = 0
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]))
  return max
}

/** 自相关估计基频：取最短周期的相关峰（长滞后是周期的整数倍，同样高）。 */
function estimateFreq(audio: AudioBuffer): number {
  const sr = audio.sampleRate
  const start = Math.round(audio.samples.length * 0.2)
  const avail = audio.samples.length - start - 1
  if (avail < 256) return 0
  const window = Math.max(64, Math.min(Math.round(sr * 0.1), Math.floor(avail / 2)))
  const minLag = Math.max(2, Math.floor(sr / 4000))
  const maxLag = Math.max(minLag + 2, Math.min(window - 1, Math.ceil(sr / 80)))
  const corr = new Float64Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i < window; i++) sum += audio.samples[start + i] * audio.samples[start + i + lag]
    corr[lag] = sum
  }
  let best = -Infinity
  let bestLag = minLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (corr[lag] > best) {
      best = corr[lag]
      bestLag = lag
    }
  }
  const threshold = best * 0.85
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= threshold && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) return sr / lag
  }
  return sr / bestLag
}

describe("帧长选择", () => {
  test("按采样率取约 46 毫秒的 2 的幂，并钳制在 512~4096", () => {
    expect(pickFrameSize(8000)).toBe(512)
    expect(pickFrameSize(16000)).toBe(1024)
    expect(pickFrameSize(22050)).toBe(1024)
    expect(pickFrameSize(44100)).toBe(2048)
    expect(pickFrameSize(48000)).toBe(2048)
    expect(pickFrameSize(96000)).toBe(4096)
    expect(pickFrameSize(192000)).toBe(4096)
  })
})

describe("tempoShiftSamples 时长", () => {
  test("tempo=1 原样返回（不复制、不处理）", () => {
    const src = tone(440, 0.2)
    expect(tempoShiftSamples(src.samples, src.sampleRate, 1)).toBe(src.samples)
  })

  test("tempo=2 时长约减半、tempo=0.5 时长约翻倍", () => {
    const src = tone(440, 0.4)
    const fast = tempoShiftSamples(src.samples, src.sampleRate, 2)
    expect(fast.length / src.samples.length).toBeCloseTo(0.5, 1)

    const slow = tempoShiftSamples(src.samples, src.sampleRate, 0.5)
    expect(slow.length / src.samples.length).toBeCloseTo(2, 1)
  })

  test("极端倍率被钳制到 0.25~4（时长方向正确、不崩）", () => {
    const src = tone(440, 0.3)
    const fastest = tempoShiftSamples(src.samples, src.sampleRate, 99)
    expect(fastest.length / src.samples.length).toBeCloseTo(0.25, 1)
    const slowest = tempoShiftSamples(src.samples, src.sampleRate, 0.001)
    expect(slowest.length / src.samples.length).toBeCloseTo(4, 1)
  })
})

describe("tempoShiftSamples 音高保持", () => {
  test("tempo=1.5：时长缩短而基频不变（对照重采样会推高音高）", () => {
    const src = tone(440, 0.6)
    const baseFreq = estimateFreq(src)
    expect(Math.abs(baseFreq - 440) / 440).toBeLessThan(0.03)

    const stretched = tempoShiftSamples(src.samples, src.sampleRate, 1.5)
    const shifted = { sampleRate: src.sampleRate, samples: stretched }
    expect(audioDuration(shifted) / audioDuration(src)).toBeCloseTo(1 / 1.5, 1)
    const kept = estimateFreq(shifted)
    expect(Math.abs(kept - 440) / 440).toBeLessThan(0.06)

    // 同一倍率下重采样（speed 语义）会把 440 推到 660：两者目的不同，不可互换
    const resampledFreq = estimateFreq({ sampleRate: src.sampleRate, samples: resampleAudio(src, 1.5).samples })
    expect(Math.abs(resampledFreq - 660) / 660).toBeLessThan(0.06)
  })

  test("tempo=0.7：放慢而基频不变", () => {
    const src = tone(300, 0.6, 44100, 0.4, true)
    const out = { sampleRate: src.sampleRate, samples: tempoShiftSamples(src.samples, src.sampleRate, 0.7) }
    expect(audioDuration(out) / audioDuration(src)).toBeCloseTo(1 / 0.7, 1)
    expect(Math.abs(estimateFreq(out) - 300) / 300).toBeLessThan(0.06)
  })

  test("含谐波的周期信号：基频保持、幅度不为零", () => {
    const src = tone(220, 0.5, 44100, 0.4, true)
    const out = { sampleRate: src.sampleRate, samples: tempoShiftSamples(src.samples, src.sampleRate, 1.8) }
    expect(Math.abs(estimateFreq(out) - 220) / 220).toBeLessThan(0.06)
    expect(peak(out.samples)).toBeGreaterThan(0.1)
    expect(peak(out.samples)).toBeLessThan(3)
  })
})

describe("tempoShiftSamples 健壮性", () => {
  test("输出为有限值（无 NaN/Inf），且样本数非零", () => {
    const src = tone(440, 0.3)
    const out = tempoShiftSamples(src.samples, src.sampleRate, 1.35)
    expect(out.length).toBeGreaterThan(0)
    for (let i = 0; i < out.length; i += 37) expect(Number.isFinite(out[i])).toBe(true)
  })

  test("极短输入（不足一帧）不崩且输出非空", () => {
    const out = tempoShiftSamples(new Float32Array(32).fill(0.3), 44100, 2)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThan(64)
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i])).toBe(true)
  })

  test("空输入原样返回", () => {
    const empty = new Float32Array(0)
    expect(tempoShiftSamples(empty, 44100, 2)).toBe(empty)
  })

  test("静音输入输出接近静音（不放大数值噪声）", () => {
    const out = tempoShiftSamples(new Float32Array(22050), 22050, 1.5)
    expect(peak(out)).toBeLessThan(1e-6)
  })
})

describe("效果链集成（tempo）", () => {
  test("applyEffects：applied 记录变速不变调且时长缩短、音高保持", () => {
    const src = tone(440, 0.6)
    const res = applyEffects(src, { tempo: 1.5 })
    expect(res.applied).toHaveLength(1)
    expect(res.applied[0]).toContain("变速不变调")
    expect(audioDuration(res.audio) / audioDuration(src)).toBeCloseTo(1 / 1.5, 1)
    expect(Math.abs(estimateFreq(res.audio) - 440) / 440).toBeLessThan(0.06)
  })

  test("applyEffects：tempo 与其它效果组合时按固定顺序生效", () => {
    const src = tone(440, 0.5)
    const res = applyEffects(src, { tempo: 1.2, lowpass: 3000, normalize: true })
    expect(res.applied).toHaveLength(3)
    expect(res.applied[0]).toContain("变速不变调 ×1.2")
    expect(res.applied[1]).toContain("低通 3000")
    expect(res.applied[2]).toContain("归一化")
  })
})

describe("产物时长上限", () => {
  test("按预计输出时长判定：快放宽松、慢放收紧", () => {
    expect(tempoLimitNote(0)).toBeNull()
    expect(tempoLimitNote(600)).toBeNull()
    expect(tempoLimitNote(1200, 2)).toBeNull()
    expect(tempoLimitNote(Number.NaN)).toBeNull()

    const slow = tempoLimitNote(600, 0.5)
    expect(slow).toContain("上限")
    expect(slow).toContain("300")
    expect(tempoLimitNote(2400, 4)).toBeNull()
    // 0.25 倍放慢时输出膨胀 4 倍：输入上限收缩到 150 秒
    expect(tempoLimitNote(150, 0.25)).toBeNull()
    expect(tempoLimitNote(151, 0.25)).toContain("上限")
    expect(TEMPO_MAX_OUTPUT_SECONDS).toBe(600)
  })
})
