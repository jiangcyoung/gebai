/**
 * 输出尺寸与画质档：视频产物的尺寸换算与草稿档参数。
 *
 * **尺寸必须提前校验**：h264 要求宽高为偶数，Remotion 也只接受整数尺寸；`scale` 是自由浮点数，
 * `1080 × 0.667 = 720.36` 这类值会一路通过到编码阶段才失败（错误停在 ffmpeg 里，与"尺寸没算对"离得很远）。
 * 这里把判断提到工具入口：给出可执行的修正建议（用 `height` 参数，或换成能整除的比例）。
 */

export interface VideoSize {
  width: number
  height: number
  /** 由 `height` 换算或直接取自 `scale`。 */
  scale: number
}

/** Remotion 合法的 x264 preset（速度 ↔ 压缩率的档位）。 */
export const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"] as const
export type X264Preset = (typeof X264_PRESETS)[number]

/** 解析 x264 preset 参数：未给或非法返回 null（由调用方决定是报错还是忽略）。 */
export function asX264Preset(value: unknown): X264Preset | null {
  if (typeof value !== "string") return null
  const v = value.trim().toLowerCase()
  return (X264_PRESETS as readonly string[]).includes(v) ? (v as X264Preset) : null
}

/**
 * 草稿档（确认动效与节奏用，不用于交付）：更低分辨率 + 最快的编码档 + 较低帧图质量。
 *
 * **分辨率那一项只在真瓶颈的通道才用**（`resolveDraftScale`）——实测同帧段 120 帧：
 * remotion（CDP 截帧，成本随像素线性）540p 比 1080p 快 **1.47×**；而浏览器通道（抓帧仅 3.2ms/帧）
 * 只有 **1.04×**（噪声内），降分辨率在那里是白丢画质。
 */
export const DRAFT = { scale: 0.5, x264Preset: "ultrafast" as X264Preset, jpegQuality: 70 } as const

/**
 * 本次渲染的输出缩放：显式 `scale` 最优先；否则草稿档仅在「分辨率是真瓶颈」的通道降分辨率，
 * 其余情况用默认值（成片 1、预览 0.5——“低清看节奏”是预览本身的设计，与草稿档无关）。
 */
export function resolveOutputScale(opts: { argScale?: number; draft: boolean; browserBackend: boolean; isVideo: boolean }): number {
  if (typeof opts.argScale === "number") return opts.argScale
  if (opts.draft && !opts.browserBackend) return DRAFT.scale
  return opts.isVideo ? 1 : 0.5
}

/** 视频画质档：final 为交付用全质量，draft 为确认用快速档。 */
export type QualityTier = "final" | "draft"

function nearInteger(v: number): boolean {
  return Math.abs(v - Math.round(v)) < 1e-6
}

/** 常用缩放比例（按序尝试；能否用取决于合成尺寸）。 */
const SCALE_CANDIDATES = [1, 0.75, 2 / 3, 0.5, 1 / 3, 0.25]

/** 该合成下可行的输出档（整数且偶数宽高）：用于报错时给出**可直接采用**的选项，而不是泛泛而谈。 */
export function feasibleSizes(width: number, height: number): Array<{ scale: number; width: number; height: number }> {
  const out: Array<{ scale: number; width: number; height: number }> = []
  for (const scale of SCALE_CANDIDATES) {
    const w = width * scale
    const h = height * scale
    if (!nearInteger(w) || !nearInteger(h)) continue
    const rw = Math.round(w)
    const rh = Math.round(h)
    if (rw % 2 !== 0 || rh % 2 !== 0 || rw <= 0 || rh <= 0) continue
    out.push({ scale, width: rw, height: rh })
  }
  return out
}

/** 比例的人读写法（2/3 比 0.6666666666666666 好读）。 */
const scaleText = (scale: number): string => (scale === 2 / 3 ? "2/3" : scale === 1 / 3 ? "1/3" : String(scale))

/**
 * 解析视频输出尺寸：`height`（目标高，按合成长宽比换算）优先于 `scale`；缺省 scale=1（原尺寸）。
 * 校验整数与偶数（h264 要求），不合法时返回可操作的错误说明。
 */
export function resolveVideoSize(opts: { width: number; height: number; scale?: number | null; targetHeight?: number | null }): VideoSize | { error: string } {
  const { width, height } = opts
  let scale: number
  if (opts.targetHeight !== undefined && opts.targetHeight !== null) {
    if (!Number.isFinite(opts.targetHeight) || opts.targetHeight <= 0) return { error: `height 必须是正数（收到 ${opts.targetHeight}）` }
    scale = opts.targetHeight / height
  } else {
    scale = opts.scale === undefined || opts.scale === null ? 1 : opts.scale
    if (!Number.isFinite(scale) || scale <= 0) return { error: `scale 必须是正数（收到 ${opts.scale}）` }
  }

  const rawW = width * scale
  const rawH = height * scale
  const problems: string[] = []
  if (!nearInteger(rawW) || !nearInteger(rawH)) problems.push(`换算结果不是整数（${rawW.toFixed(2)}×${rawH.toFixed(2)}）`)
  const w = Math.round(rawW)
  const h = Math.round(rawH)
  if (w % 2 !== 0 || h % 2 !== 0) problems.push(`宽高必须是偶数（${w}×${h}）`)
  if (w <= 0 || h <= 0) problems.push(`尺寸必须为正（${w}×${h}）`)
  if (problems.length) {
    const options = feasibleSizes(width, height)
    const scaleHint = options.length ? options.map((o) => `scale=${scaleText(o.scale)}（${o.width}×${o.height}）`).join("、") : ""
    const heightHint = options.length ? options.map((o) => String(o.height)).join("/") : ""
    return {
      error:
        `输出尺寸不合法：${problems.join("；")}——h264 要求整数且偶数的宽高。` +
        `当前合成 ${width}×${height}、scale ${scale}。可用：${scaleHint}；` +
        `或改用 height=<目标高> 按合成长宽比换算（本合成的可行高度：${heightHint}）。`,
    }
  }
  return { width: w, height: h, scale }
}
