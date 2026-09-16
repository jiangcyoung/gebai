/**
 * 渲染档决策（纯函数）：由主机形态（平台/架构/核数）+ NVIDIA 探测 + DRI 设备 + 项目内 Remotion 版本 +
 * 是否含 WebGL 内容 + 实测调优条目，推导原生渲染库的调用参数——硬件编码档、Chrome 模式、光栅化后端（gl）、
 * 并发、码率口径；并把「为什么这样定档」写进 reasons、「什么没能启用」写进 unavailable。
 *
 * 依据（Remotion 官方，见契约 §4.2 决策表）：
 * - 硬件编码：Linux/Windows 走 NVENC 且需 Remotion ≥ 4.0.484；macOS Apple Silicon 走 VideoToolbox；
 *   硬件编码不支持 crf，质量用 videoBitrate 控制（默认 8M，与软件编码体积相当）。
 * - 光栅化后端：只有 WebGL/Three 内容才指定 gl（非 WebGL 内容默认后端更优，angle 有内存泄漏风险）；
 *   Linux+NVIDIA 用 vulkan，Linux 其他 GPU 用 angle-egl，桌面 GPU 用 angle，无 GPU 用 swangle。
 * - Chrome 模式：Linux + NVIDIA 用 chrome-for-testing（官方 GPU 服务器建议档），其余用更轻的 headless-shell。
 * - 版本未知按「不支持硬件编码」处理（未知不冒险：宁可软件档跑通，也不因参数不被识别而失败）。
 */
import { createHash } from "node:crypto"
import type { ProbeInput } from "./detect"

export type HardwareAcceleration = "disable" | "if-possible" | "required"
export type ChromeMode = "headless-shell" | "chrome-for-testing"
export type GlOption = "vulkan" | "angle" | "angle-egl" | "swangle"

/** 实测调优条目（bench 实测所得；键 = profileKey(projectDir, compositionId)）。 */
export interface TunedEntry {
  concurrency: number
  gl: string | null
  chromeMode: string
  hardwareAcceleration: HardwareAcceleration
  fps: number
  measuredAt: string
}

export interface RenderProfile {
  concurrency: number
  /** null = 不传 gl（非 WebGL 内容用默认后端最优）。 */
  gl: GlOption | null
  chromeMode: ChromeMode
  hardwareAcceleration: HardwareAcceleration
  /** 硬件编码时的码率（crf 与硬件编码互斥）；软件档为 null。 */
  videoBitrate: string | null
  /** 软件编码的质量参数；null = 用原生库内置值（即不传 crf）。 */
  crf: number | null
  reasons: string[]
  unavailable: string[]
  /** 每个字段的取值来源：auto=按主机推断 / tuned=实测调优 / override=调用级覆盖。 */
  source: { concurrency: "auto" | "tuned" | "override"; hardware: "auto" | "tuned" | "override" }
}

export interface ProfileOverride {
  concurrency?: number
  gl?: string | null
  chromeMode?: string
  hardwareAcceleration?: HardwareAcceleration
  videoBitrate?: string | null
  crf?: number | null
  /** off = 强制软件档（REEL_GPU=off）。 */
  gpu?: "auto" | "off"
}

/** NVENC（Linux/Windows 内置 ffmpeg 的 h264_nvenc）所需的最低 Remotion 版本。 */
export const NVENC_MIN_VERSION: [number, number, number] = [4, 0, 484]
const GL_VALUES: GlOption[] = ["vulkan", "angle", "angle-egl", "swangle"]
const CONCURRENCY_RANGE: [number, number] = [1, 64]
/**
 * 自动档并发上限（不作用于调用级显式 override）。
 *
 * 实测依据（本机 28 核 · 1080p 合成 · chrome-headless-shell · 60 帧样本）：
 * 并发 1/2/4/8/16 的耗时分别为 12.4 / 9.4 / **8.6 / 8.7 / 8.8** 秒——**并发 4 已饱和**，
 * 再加只白占页面池（每页一个 tab）而不提吞吐；且自动档原取 `cpuCount/2`（本机 = 14）时，
 * 在部分 Chrome 形态下会触发页面池无响应（实测 `Visited "http://localhost:3001/index.html" but got no response`，
 * 而同一帧段降到 8 以下则稳定通过）。故自动档封顶 8：吞吐不变、内存与稳定性更优。
 * 真正吃满多核靠**分片并行**（多进程各带自己的页面池），而非单进程加大并发。
 */
const AUTO_CONCURRENCY_MAX = 8

/** 解析 `4.0.484` / `v4.1.0-rc.2` 形态版本号；不可解析返回 null。 */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 版本比较：-1 / 0 / 1；a 未知（null）返回 -1（按「低于目标版本」处理，不放行未验证的能力）。 */
export function compareVersion(a: [number, number, number] | null, b: [number, number, number]): number {
  if (!a) return -1
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** 调优缓存键：项目目录 + 合成 ID 的稳定哈希（同项目同合成才复用实测值）。 */
export function profileKey(projectDir: string, compositionId: string): string {
  return createHash("sha256").update(`${projectDir}::${compositionId}`).digest("hex").slice(0, 16)
}

/** 传给原生库的 chromiumOptions：只有需要指定光栅化后端时才带 gl（非 WebGL 内容不传）。 */
export function chromiumOf(p: RenderProfile): { gl?: string } {
  return p.gl ? { gl: p.gl } : {}
}

function asGl(value: string | null | undefined): GlOption | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  return (GL_VALUES as string[]).includes(value) ? (value as GlOption) : undefined
}

function asChromeMode(value: string | undefined): ChromeMode | undefined {
  return value === "headless-shell" || value === "chrome-for-testing" ? value : undefined
}

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return CONCURRENCY_RANGE[0]
  return Math.max(CONCURRENCY_RANGE[0], Math.min(CONCURRENCY_RANGE[1], Math.floor(value)))
}

/** 主决策：产出原生库调用参数与可读依据。 */
export function decideProfile(input: ProbeInput, override: ProfileOverride = {}, tuned: TunedEntry | null = null): RenderProfile {
  const reasons: string[] = []
  const unavailable: string[] = []
  const webgl = Boolean(input.webglContent)
  const version = input.remotionVersion ?? null
  const gpuOff = override.gpu === "off"
  const nvidia = gpuOff ? null : input.nvidia
  const renderNodes = gpuOff ? [] : (input.renderNodes ?? [])
  const appleSilicon = gpuOff ? false : input.appleSilicon
  const linuxArm64 = input.platform === "linux" && input.arch === "arm64"

  // 光栅化后端（表内 gl 列）：仅 WebGL/Three 内容指定，非 WebGL 一律 null
  const chromiumGl = (value: GlOption): GlOption | null => (webgl ? value : null)

  // —— 决策表 ——
  let hardware: HardwareAcceleration = "disable"
  let chromeMode: ChromeMode = "headless-shell"
  let gl: GlOption | null = chromiumGl("swangle")
  let gpuForm: string

  if (gpuOff) {
    gpuForm = "无 GPU（REEL_GPU=off）"
    chromeMode = "headless-shell"
    gl = chromiumGl("swangle")
    reasons.push("REEL_GPU=off：强制软件档（编码 disable + crf，WebGL 内容用 swangle 软件光栅化）")
  } else if (input.platform === "linux" && linuxArm64) {
    gpuForm = nvidia ? "Linux ARM64 + NVIDIA" : "Linux ARM64"
    chromeMode = "headless-shell"
    gl = chromiumGl("angle-egl")
    unavailable.push("Linux ARM64 的 Remotion 内置 ffmpeg 不含 NVENC：硬件编码不可用，走软件 x264")
    if (nvidia) unavailable.push(`检测到 ${nvidia.name}，但该平台无可用硬件编码器`)
  } else if (input.platform === "linux" && nvidia) {
    gpuForm = `Linux + NVIDIA ${nvidia.name}`
    chromeMode = "chrome-for-testing"
    gl = chromiumGl("vulkan")
    if (compareVersion(parseVersion(version), NVENC_MIN_VERSION) >= 0) {
      hardware = "if-possible"
      reasons.push(`NVIDIA ${nvidia.name}：启用 NVENC（Remotion ${version} ≥ 4.0.484），质量由 videoBitrate 控制`)
    } else {
      unavailable.push(`NVENC 需 Remotion ≥ 4.0.484（当前 ${version ?? "未探测到版本"}）：硬件编码未启用，走软件 x264`)
      reasons.push(`检测到 NVIDIA ${nvidia.name} 但版本门控未通过：仅 GPU 光栅化可用`)
    }
  } else if (input.platform === "linux" && renderNodes.length > 0) {
    gpuForm = `Linux GPU（DRI ${renderNodes.join(", ")}）`
    chromeMode = "headless-shell"
    gl = chromiumGl("angle-egl")
    reasons.push("检测到 DRI 渲染设备但非 NVIDIA：仅用于 GPU 光栅化（gl=angle-egl）")
    unavailable.push("硬件编码不可用：原生库仅支持 NVIDIA NVENC 与 macOS VideoToolbox，该 GPU 只参与光栅化")
  } else if (input.platform === "win32" && nvidia) {
    gpuForm = `Windows + NVIDIA ${nvidia.name}`
    chromeMode = "headless-shell"
    gl = chromiumGl("angle")
    if (compareVersion(parseVersion(version), NVENC_MIN_VERSION) >= 0) {
      hardware = "if-possible"
      reasons.push(`NVIDIA ${nvidia.name}：启用 NVENC（Remotion ${version} ≥ 4.0.484），质量由 videoBitrate 控制`)
    } else {
      unavailable.push(`NVENC 需 Remotion ≥ 4.0.484（当前 ${version ?? "未探测到版本"}）：硬件编码未启用，走软件 x264`)
    }
    reasons.push("Windows：Chrome 用 headless-shell（官方只在 Linux GPU 场景建议 chrome-for-testing）")
  } else if (input.platform === "darwin" && appleSilicon) {
    gpuForm = "Apple Silicon（VideoToolbox）"
    hardware = "if-possible"
    chromeMode = "headless-shell"
    gl = chromiumGl("angle")
    reasons.push("macOS Apple Silicon：启用 VideoToolbox 硬件编码，质量由 videoBitrate 控制")
  } else if (input.platform === "darwin" || input.platform === "win32") {
    gpuForm = input.platform === "darwin" ? "Intel Mac（无可用硬件编码）" : "Windows GPU（非 NVIDIA）"
    chromeMode = "headless-shell"
    gl = chromiumGl("angle")
    unavailable.push("硬件编码不可用：原生库只支持 NVIDIA NVENC 与 macOS Apple Silicon 的 VideoToolbox，该 GPU 仅参与光栅化")
  } else {
    gpuForm = "无 GPU"
    chromeMode = "headless-shell"
    gl = chromiumGl("swangle")
    reasons.push("未检测到 GPU 硬件：编码走软件 x264，WebGL 内容用 swangle 软件光栅化")
  }

  // —— 调用级覆盖 ——
  let hardwareSource: RenderProfile["source"]["hardware"] = "auto"
  if (override.hardwareAcceleration !== undefined) {
    hardware = override.hardwareAcceleration
    hardwareSource = "override"
    reasons.push(`调用级指定 hardware_acceleration=${hardware}`)
  }

  let glSource: "auto" | "override" | "tuned" = "auto"
  const overrideGl = asGl(override.gl)
  if (overrideGl !== undefined) {
    gl = overrideGl
    glSource = "override"
    reasons.push(overrideGl === null ? "调用级指定 gl=off：使用默认后端" : `调用级指定 gl=${overrideGl}`)
  }
  let chromeSource: "auto" | "override" | "tuned" = "auto"
  const overrideChrome = asChromeMode(override.chromeMode)
  if (overrideChrome) {
    chromeMode = overrideChrome
    chromeSource = "override"
    reasons.push(`调用级指定 chromeMode=${overrideChrome}`)
  }

  // —— 实测调优（仅覆盖未被显式指定的字段）——
  // —— 自动档并发：取半核数，但**封顶到饱和点** ——
  // 旧注释（并发与全核数无差异）在 835 帧全片基准上仍成立，但**小样本下并发 4 已饱和**（见
  // AUTO_CONCURRENCY_MAX 实测），继续按 cpuCount/2 给出 14 会白占页面池并带来页面池无响应风险。
  const autoConcurrency = Math.max(1, Math.min(AUTO_CONCURRENCY_MAX, Math.round(input.cpuCount / 2)))
  let concurrency = autoConcurrency
  let concurrencySource: RenderProfile["source"]["concurrency"] = "auto"
  if (tuned) {
    const diffs: string[] = []
    if (override.concurrency === undefined) {
      concurrency = Math.min(AUTO_CONCURRENCY_MAX, tuned.concurrency)
      concurrencySource = "tuned"
      diffs.push(`并发 ${autoConcurrency} → ${tuned.concurrency}${tuned.concurrency > AUTO_CONCURRENCY_MAX ? `（封顶 ${AUTO_CONCURRENCY_MAX}；并发 4 已饱和，再加只占页面池）` : ""}`)
    }
    if (hardwareSource === "auto" && tuned.hardwareAcceleration && tuned.hardwareAcceleration !== hardware) {
      diffs.push(`硬件档 ${hardware} → ${tuned.hardwareAcceleration}`)
      hardware = tuned.hardwareAcceleration
      hardwareSource = "tuned"
    } else if (hardwareSource === "auto" && tuned.hardwareAcceleration) {
      hardwareSource = "tuned"
    }
    if (glSource === "auto" && tuned.gl !== undefined) {
      const tunedGl = asGl(tuned.gl)
      if (tunedGl !== undefined && tunedGl !== gl) {
        diffs.push(`gl ${gl ?? "默认后端"} → ${tunedGl ?? "默认后端"}`)
        gl = tunedGl
        glSource = "tuned"
      }
    }
    if (chromeSource === "auto" && asChromeMode(tuned.chromeMode)) {
      const tunedChrome = asChromeMode(tuned.chromeMode)!
      if (tunedChrome !== chromeMode) diffs.push(`Chrome 模式 ${chromeMode} → ${tunedChrome}`)
      chromeMode = tunedChrome
      chromeSource = "tuned"
    }
    reasons.push(
      `采用本机实测调优（${tuned.fps.toFixed(1)} fps @ ${tuned.measuredAt}）${diffs.length ? `：${diffs.join("；")}` : "：取值与自动推断一致"}`,
    )
  }
  if (override.concurrency !== undefined) {
    concurrency = override.concurrency
    concurrencySource = "override"
    reasons.push(`调用级指定并发 ${concurrency}`)
  }
  const requestedConcurrency = concurrency
  concurrency = clampConcurrency(concurrency)
  if (concurrency !== requestedConcurrency) {
    reasons.push(`并发被钳制到 [${CONCURRENCY_RANGE[0]}, ${CONCURRENCY_RANGE[1]}] 内的 ${concurrency}`)
  }

  // —— 质量参数：硬件档用码率，软件档用 crf（crf 默认不传 = 原生库内置值）——
  let videoBitrate: string | null = null
  let crf: number | null = null
  if (hardware !== "disable") {
    videoBitrate = override.videoBitrate === undefined ? "8M" : override.videoBitrate
    if (videoBitrate) reasons.push(`硬件编码使用 videoBitrate=${videoBitrate}（硬件编码不支持 crf）`)
    if (override.crf !== undefined && override.crf !== null) {
      unavailable.push("硬件编码不支持 crf：已忽略 crf 请求，请改用 videoBitrate 控制质量")
    }
  } else {
    crf = override.crf ?? null
    if (crf !== null) reasons.push(`软件编码使用 crf=${crf}`)
    else reasons.push("软件编码使用原生库内置 crf（未显式指定）")
    if (override.videoBitrate) reasons.push(`软件编码忽略 videoBitrate=${override.videoBitrate}（仅硬件编码使用）`)
  }

  reasons.unshift(`主机形态：${gpuForm}`)
  return {
    concurrency,
    gl,
    chromeMode,
    hardwareAcceleration: hardware,
    videoBitrate,
    crf,
    reasons,
    unavailable,
    source: { concurrency: concurrencySource, hardware: hardwareSource },
  }
}

/** 决策结果的人读描述（工具输出：参数 + 依据 + 未能启用项）。 */
export function describeProfile(p: RenderProfile, input: ProbeInput): string[] {
  const lines: string[] = []
  const gpu = input.nvidia
    ? `${input.nvidia.name}${input.nvidia.driver ? `（驱动 ${input.nvidia.driver}）` : ""}`
    : input.appleSilicon
      ? "Apple Silicon（VideoToolbox）"
      : (input.renderNodes?.length ?? 0) > 0
        ? `非 NVIDIA GPU（${input.renderNodes.join(", ")}）`
        : "无 GPU"
  const encoding =
    p.hardwareAcceleration === "disable"
      ? `软件 x264（crf ${p.crf ?? "原生默认"}）`
      : `硬件编码 hardwareAcceleration=${p.hardwareAcceleration} · videoBitrate=${p.videoBitrate ?? "未指定"}`
  lines.push(`主机：${input.platform}/${input.arch} · ${input.cpuCount} 核 · ${(input.memoryMB / 1024).toFixed(1)}GB 内存`)
  lines.push(`GPU：${gpu}`)
  lines.push(`编码：${encoding}`)
  lines.push(`Chrome：${p.chromeMode}${p.gl ? ` · gl=${p.gl}` : " · 默认后端（非 WebGL 内容不指定 gl）"}`)
  lines.push(
    `并发：${p.concurrency}（来源 ${p.source.concurrency}）· Remotion ${input.remotionVersion ?? "未探测到版本"}`,
  )
  if (input.webglContent) lines.push("内容：含 WebGL/Three 镜头")
  for (const reason of p.reasons) lines.push(`· ${reason}`)
  for (const item of p.unavailable) lines.push(`未能启用：${item}`)
  return lines
}
