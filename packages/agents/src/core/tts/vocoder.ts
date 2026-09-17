/**
 * 相位声码器（变速不变调）：STFT 域的时间伸缩——改变时长而保持音高，与重采样实现的变速（`speed`，
 * 音高随时长一起变）互补。
 *
 * 原理：分析帧按 hopA 推进、合成帧按 hopS = hopA / 速度推进（速度 > 1 时 hopS 更小、输出更短）。
 * 每帧做 FFT 后，对每个频点用「实际相位增量 − 理论相位增量」反推真实频率，再按 hopS 累积合成相位——
 * 幅度谱大体保留，故音高不变。
 *
 * 两点取舍（如实标注）：
 * - **相位锁定**（Laroche & Dolson，identity phase locking）：只对谱峰频点累积相位，峰周围频点跟随
 *   所在区域的峰（相对相位取自当前分析帧）。抑制纯相位声码器典型的「相位散乱」噪声，语音清晰度明显更好；
 *   但瞬态（爆破音、鼓点）仍会有涂抹——这是相位声码器的固有限制，不是实现缺陷。
 * - 质量与代价正相关：帧长按采样率取约 46 毫秒，长音频（分钟级）需数十秒机时，故由调用方设时长上限。
 *
 * 本模块是**纯数值计算**（只用内置类型，不依赖项目内其它模块），便于独立测试与复用。
 */

const TWO_PI = Math.PI * 2

interface Twiddle {
  cos: Float64Array
  sin: Float64Array
}

/** 旋转因子表（按半长与方向缓存）：跨帧跨调用复用，避免重复三角函数计算。 */
const twiddleCache = new Map<string, Twiddle>()

function twiddles(half: number, inverse: boolean): Twiddle {
  const key = `${half}${inverse ? "i" : "f"}`
  const hit = twiddleCache.get(key)
  if (hit) return hit
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  const sign = inverse ? 1 : -1
  const len = half * 2
  for (let k = 0; k < half; k++) {
    const angle = (sign * TWO_PI * k) / len
    cos[k] = Math.cos(angle)
    sin[k] = Math.sin(angle)
  }
  const made = { cos, sin }
  twiddleCache.set(key, made)
  return made
}

/** 就地 radix-2 复数 FFT（帧长恒为 2 的幂；inverse 时按 1/n 归一）。 */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const { cos, sin } = twiddles(half, inverse)
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const at = i + k
        const other = at + half
        const br = re[other]
        const bi = im[other]
        const vr = br * cos[k] - bi * sin[k]
        const vi = br * sin[k] + bi * cos[k]
        const ar = re[at]
        const ai = im[at]
        re[at] = ar + vr
        im[at] = ai + vi
        re[other] = ar - vr
        im[other] = ai - vi
      }
    }
  }
  if (inverse) {
    const scale = 1 / n
    for (let i = 0; i < n; i++) {
      re[i] *= scale
      im[i] *= scale
    }
  }
}

/** 帧长（2 的幂，约 46 毫秒——语音与音效在时频分辨率上的折中）。 */
export function pickFrameSize(sampleRate: number): number {
  const ideal = sampleRate * 0.046
  const power = Math.round(Math.log2(ideal))
  return Math.min(4096, Math.max(512, 2 ** power))
}

/**
 * 变速不变调（相位声码器）。
 *
 * @param samples 单声道浮点样本（[-1, 1]）
 * @param sampleRate 采样率
 * @param tempo 速度倍率：>1 变快（时长缩短）、<1 变慢（时长拉长），音高保持不变。
 *              超出 0.25~4 钳制；≈1 时原样返回。
 */
export function tempoShiftSamples(samples: Float32Array, sampleRate: number, tempo: number): Float32Array {
  const speed = Math.max(0.25, Math.min(4, Number.isFinite(tempo) ? tempo : 1))
  const len = samples.length
  if (Math.abs(speed - 1) < 1e-3 || len === 0) return samples
  const frame = pickFrameSize(sampleRate)
  const hopAnalysis = frame >> 2
  const hopSynthesis = Math.max(1, Math.round(hopAnalysis / speed))
  const ratio = hopSynthesis / hopAnalysis
  const bins = (frame >> 1) + 1
  const win = new Float64Array(frame)
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / frame)

  const frameCount = Math.ceil((len + frame) / hopAnalysis)
  const outLen = Math.ceil(len * ratio) + frame
  // 缓冲用 Float32：重叠相加只累加几帧，24 位精度绰绰有余，内存开销减半（长音频下这是关键约束）
  const out = new Float32Array(outLen)
  /** 窗平方和：分析窗与合成窗相乘，重叠相加后按此归一（hop 变化时窗和不恒定）。 */
  const weight = new Float32Array(outLen)

  const re = new Float64Array(frame)
  const im = new Float64Array(frame)
  const mag = new Float64Array(bins)
  const phase = new Float64Array(bins)
  const prevPhase = new Float64Array(bins)
  const sumPhase = new Float64Array(bins)
  const advance = new Float64Array(bins)
  const owner = new Int32Array(bins)
  const peaks: number[] = []

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopAnalysis
    if (start >= len + frame) break
    for (let i = 0; i < frame; i++) {
      const idx = start + i
      re[i] = idx < len ? samples[idx] * win[i] : 0
      im[i] = 0
    }
    fft(re, im, false)
    let maxMag = 0
    for (let k = 0; k < bins; k++) {
      const r = re[k]
      const i2 = im[k]
      const m = Math.sqrt(r * r + i2 * i2)
      mag[k] = m
      phase[k] = Math.atan2(i2, r)
      if (m > maxMag) maxMag = m
    }

    // 真实频率 = 理论推进 + 相位偏差（偏差 wrap 到 [-π, π]），再折算到合成 hop
    for (let k = 0; k < bins; k++) {
      const expected = (TWO_PI * k * hopAnalysis) / frame
      let delta = phase[k] - prevPhase[k] - expected
      delta -= TWO_PI * Math.round(delta / TWO_PI)
      advance[k] = (expected + delta) * ratio
    }

    if (f === 0) {
      for (let k = 0; k < bins; k++) sumPhase[k] = phase[k]
    } else {
      peaks.length = 0
      const threshold = maxMag * 0.0015
      for (let k = 1; k < bins - 1; k++) {
        if (mag[k] > threshold && mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks.push(k)
      }
      if (peaks.length) {
        // 相位锁定：峰按真实频率累积；其余频点归属最近的峰，取其相对相位
        owner.fill(-1)
        for (let i = 0; i < peaks.length; i++) {
          const p = peaks[i]
          const prev = i > 0 ? peaks[i - 1] : -1
          const next = i < peaks.length - 1 ? peaks[i + 1] : bins
          const lo = prev < 0 ? 0 : (prev + p + 1) >> 1
          const hi = i === peaks.length - 1 ? bins - 1 : (p + next) >> 1
          for (let k = lo; k <= hi; k++) owner[k] = p
        }
        for (const p of peaks) sumPhase[p] += advance[p]
        for (let k = 0; k < bins; k++) {
          const p = owner[k]
          if (p < 0) sumPhase[k] += advance[k]
          else if (p !== k) {
            let d = phase[k] - phase[p]
            d -= TWO_PI * Math.round(d / TWO_PI)
            sumPhase[k] = sumPhase[p] + d
          }
        }
      } else {
        for (let k = 0; k < bins; k++) sumPhase[k] += advance[k]
      }
    }
    prevPhase.set(phase)

    // 合成谱：幅度取自分析帧、相位取累积值，并补共轭对称以得到实信号
    for (let k = 0; k < bins; k++) {
      const m = mag[k]
      const ph = sumPhase[k]
      re[k] = m * Math.cos(ph)
      im[k] = m * Math.sin(ph)
    }
    for (let k = 1; k < frame >> 1; k++) {
      re[frame - k] = re[k]
      im[frame - k] = -im[k]
    }
    fft(re, im, true)

    const at = f * hopSynthesis
    for (let i = 0; i < frame; i++) {
      const idx = at + i
      if (idx >= outLen) break
      const w = win[i]
      out[idx] += re[i] * w
      weight[idx] += w * w
    }
  }

  const target = Math.max(1, Math.round(len * ratio))
  const result = new Float32Array(target)
  for (let i = 0; i < target; i++) {
    const w = weight[i]
    result[i] = w > 1e-6 ? out[i] / w : 0
  }
  return result
}
