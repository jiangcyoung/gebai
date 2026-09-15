/**
 * shotcraft 渲染档决策（纯函数 + 可注入探测，便于单测）：
 * 由「主机形态（平台/架构/核数）+ GPU 探测 + 项目内 Remotion 版本能力 + 项目是否含 WebGL 内容 + 实测调优缓存」
 * 推导原生渲染库的调用参数——硬件编码（NVENC/VideoToolbox）、Chrome 光栅化后端（gl）、Chrome 模式
 * （chrome-for-testing / headless-shell）、并发数、码率口径；无 GPU 时明确落到软件档并如实说明。
 *
 * 依据（Remotion 官方）：
 * - 硬件编码：macOS VideoToolbox；Linux/Windows NVENC 需 Remotion ≥4.0.484（内置 ffmpeg 含 h264_nvenc/hevc_nvenc，
 *   Linux ARM64 不含）；硬件编码下不支持 crf，质量用 videoBitrate 控制（官方建议 8M 与软件编码体积相当）。
 * - 光栅化：WebGL/Three 内容才指定 gl（桌面 angle / Linux GPU 实例 vulkan 或 angle-egl / 无 GPU swangle）；
 *   非 WebGL 内容用默认后端（官方：angle 有内存泄漏风险且无收益）。
 * - Chrome 模式：GPU 场景用 chrome-for-testing（模拟显示面、GPU-bound 更快）；CPU-bound 用 headless-shell（更轻更快）。
 */
import { createHash } from "node:crypto"

export type GlOption = "angle" | "egl" | "swiftshader" | "vulkan" | "angle-egl" | "swangle"
export type ChromeMode = "headless-shell" | "chrome-for-testing"
export type HardwareAcceleration = "disable" | "if-possible" | "required"
export type GpuVendor = "nvidia" | "apple" | "intel" | "amd" | "unknown"

export interface GpuInfo {
  vendor: GpuVendor
  name: string
  driver?: string
  memoryMB?: number
}

/** Remotion 能力门控表（低于该版本不传对应参数，避免未知参数失败）。 */
export const FEATURE_MIN_VERSION = {
  /** 硬件编码选项 hardwareAcceleration。 */
  hardwareAcceleration: "4.0.228",
  /** Linux/Windows NVENC（内置 ffmpeg 内含 nvenc 编码器）。 */
  nvenc: "4.0.484",
  /** chromeMode 选项（chrome-for-testing）。 */
  chromeMode: "4.0.248",
  /** binariesDirectory（预置原生二进制目录；默认由项目内 @remotion/compositor-* 提供，不显式传递）。 */
  binariesDirectory: "4.0.120",
  /** gl=vulkan。 */
  glVulkan: "4.0.41",
  /** gl=angle-egl。 */
  glAngleEgl: "4.0.52",
  /** renderMedia 的 frameRange（预览帧段）。 */
  frameRange: "4.0.421",
  /** openBrowser（热浏览器复用）。 */
  openBrowser: "3.0.0",
} as const

export type Feature = keyof typeof FEATURE_MIN_VERSION

export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** 版本能力判定：未探测到版本时按"支持"处理（不因缺版本信息而丢掉最佳性能档）。 */
export function supports(version: string | null | undefined, feature: Feature): boolean {
  const min = parseVersion(FEATURE_MIN_VERSION[feature])
  const cur = parseVersion(version)
  if (!min || !cur) return true
  return compareVersion(cur, min) >= 0
}

export interface ProbeInput {
  platform: string
  arch: string
  cpuCount: number
  memoryMB?: number
  /** NVIDIA 探测结果（未检测到 = null）。 */
  nvidia?: GpuInfo | null
  /** Linux DRI 渲染设备（/dev/dri/renderD*，非 NVIDIA GPU 存在性判据）。 */
  renderNodes?: string[]
  /** macOS Apple Silicon（VideoToolbox 硬件编码可用）。 */
  appleSilicon?: boolean
  /** 项目内已安装 Remotion 版本（能力门控）。 */
  remotionVersion?: string | null
  /** 项目是否含 WebGL/Three/Skia 内容。 */
  webglContent?: boolean
  /** GPU 策略：off = 强制软件档。 */
  gpuPolicy?: "auto" | "off"
  /** 机器 + 项目 + 合成级实测调优（bench 写入）。 */
  tuning?: TuningEntry | null
  /** 调用级覆盖。 */
  overrides?: {
    concurrency?: number
    gl?: GlOption | "auto" | "off"
    chromeMode?: ChromeMode | "auto"
    hardwareAcceleration?: "auto" | HardwareAcceleration
  }
}

export interface RenderProfile {
  platform: string
  arch: string
  cpuCount: number
  memoryMB?: number
  concurrency: number
  gpu: GpuInfo | null
  /** 推断/实测的硬件编码器名（未启用为 null）。 */
  hardwareEncoder: "h264_nvenc" | "hevc_nvenc" | "h264_videotoolbox" | null
  hardwareAcceleration: HardwareAcceleration
  chromeMode: ChromeMode
  /** null = 不传 gl（非 WebGL 内容用默认后端最优）。 */
  gl: GlOption | null
  webglContent: boolean
  /** 硬件编码时的默认码率（crf 与硬件编码不兼容）。 */
  videoBitrate: string | null
  /** 决策依据（逐条可读，进工具输出）。 */
  reasons: string[]
  /** 因版本过老/平台不支持而未能启用的能力。 */
  unavailable: string[]
  fromTuning: boolean
  remotionVersion: string | null
}

export interface TuningEntry {
  concurrency?: number
  gl?: GlOption | null
  chromeMode?: ChromeMode
  hardwareAcceleration?: HardwareAcceleration
  fps?: number
  measuredAt: string
}

export interface EncoderProbe {
  /** 实测确认硬件编码生效（renderMedia + hardwareAcceleration=required 探针）。 */
  hardware: boolean
  checkedAt: string
  composition?: string
  error?: string
}

export interface TuningFile {
  /** 机器级：硬件编码实测结论（与项目无关）。 */
  encoderProbe?: EncoderProbe
  /** 键 = tuningKey(machineSignature, 项目, 合成)：bench 实测最优档。 */
  entries: Record<string, TuningEntry>
}

export function emptyTuningFile(): TuningFile {
  return { entries: {} }
}

/** 机器签名：同机同版本同内容形态的实测结果才可复用。 */
export function machineSignature(input: {
  platform: string
  arch: string
  cpuCount: number
  gpu: GpuInfo | null
  remotionVersion?: string | null
  webglContent?: boolean
}): string {
  const parts = [
    input.platform,
    input.arch,
    String(input.cpuCount),
    input.gpu ? `${input.gpu.vendor}:${input.gpu.name}` : "nogpu",
    input.remotionVersion ?? "unknown",
    input.webglContent ? "webgl" : "nowebgl",
  ]
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16)
}

export function tuningKey(signature: string, projectDir: string, composition: string): string {
  return `${signature}:${createHash("sha256").update(`${projectDir}::${composition}`).digest("hex").slice(0, 12)}`
}

/** 解析 nvidia-smi csv 输出（`name, driver_version, memory.total`；nounits 时为纯数字）。 */
export function parseNvidiaSmi(stdout: string): GpuInfo | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const cells = line.split(",").map((c) => c.trim())
  const name = cells[0]
  if (!name || /^(not found|no devices)/i.test(name)) return null
  const memMatch = /(\d+)/.exec(cells[2] ?? "")
  return { vendor: "nvidia", name, driver: cells[1] || undefined, memoryMB: memMatch ? Number(memMatch[1]) : undefined }
}

/** 从项目 package.json 依赖判断是否含 WebGL/Three/Skia 内容（决定是否指定 gl 后端）。 */
const WEBGL_PACKAGES = ["three", "@react-three/fiber", "@remotion/three", "@remotion/skia", "skia-canvas", "@shopify/react-native-skia", "p5"]
export function hasWebglDependencies(packageJsonText: string): boolean {
  try {
    const pkg = JSON.parse(packageJsonText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
    return WEBGL_PACKAGES.some((p) => names.has(p))
  } catch {
    return false
  }
}

/** 源码中对 WebGL 图形栈的引用（依赖未声明但源码直引的场景）。 */
export function hasWebglImports(sourceSnippets: string[]): boolean {
  const re = /(from\s+["'](?:three|@react-three\/fiber|@remotion\/three|@remotion\/skia|skia-canvas|p5)["']|require\(["'](?:three|p5)["']\))/
  return sourceSnippets.some((s) => re.test(s))
}

/** 主决策：产出原生库调用参数（含决策依据与不可用项）。 */
export function decideProfile(input: ProbeInput): RenderProfile {
  const overrides = input.overrides ?? {}
  const reasons: string[] = []
  const unavailable: string[] = []
  const version = input.remotionVersion ?? null
  const webglContent = Boolean(input.webglContent)

  let gpu: GpuInfo | null = input.nvidia ?? null
  if (input.gpuPolicy === "off") {
    gpu = null
    reasons.push("SHOTCRAFT_GPU=off：强制软件档，不使用 GPU 加速")
  } else if (!gpu && input.appleSilicon) {
    gpu = { vendor: "apple", name: "Apple Silicon (VideoToolbox)" }
  } else if (!gpu && input.platform === "linux" && (input.renderNodes?.length ?? 0) > 0) {
    gpu = { vendor: "unknown", name: `DRI 渲染设备（${input.renderNodes!.join(", ")}）` }
  }
  if (!gpu) reasons.push("未检测到可用 GPU：编码走软件 x264，光栅化按软件后端")

  // 硬件编码（NVENC / VideoToolbox）
  const requested = overrides.hardwareAcceleration ?? "auto"
  let hardwareAcceleration: HardwareAcceleration = "disable"
  let hardwareEncoder: RenderProfile["hardwareEncoder"] = null
  const nvencPlatform = input.platform === "linux" || input.platform === "win32"
  const nvencArchOk = input.arch !== "arm64"
  if (requested === "disable") {
    reasons.push("调用级指定 hardware_acceleration=disable：软件编码")
  } else if (!gpu) {
    if (requested === "required") unavailable.push("无 GPU：无法满足 hardware_acceleration=required")
  } else if (!supports(version, "hardwareAcceleration")) {
    unavailable.push(`Remotion ${version ?? "?"} 低于 ${FEATURE_MIN_VERSION.hardwareAcceleration}，不支持硬件编码选项`)
  } else if (gpu.vendor === "apple") {
    hardwareAcceleration = requested === "required" ? "required" : "if-possible"
    hardwareEncoder = "h264_videotoolbox"
    reasons.push("macOS：启用 VideoToolbox 硬件编码")
  } else if (gpu.vendor === "nvidia" && nvencPlatform && nvencArchOk) {
    if (supports(version, "nvenc")) {
      hardwareAcceleration = requested === "required" ? "required" : "if-possible"
      hardwareEncoder = "h264_nvenc"
      reasons.push(`NVIDIA ${gpu.name}：启用 NVENC 硬件编码（Remotion ${version} ≥ ${FEATURE_MIN_VERSION.nvenc}）`)
    } else {
      unavailable.push(`Linux/Windows NVENC 需 Remotion ≥ ${FEATURE_MIN_VERSION.nvenc}（当前 ${version ?? "?"}）`)
    }
  } else if (gpu.vendor === "nvidia" && !nvencArchOk) {
    unavailable.push("Linux ARM64 的 Remotion 内置 ffmpeg 不含 NVENC，硬件编码不可用")
  } else if (gpu) {
    unavailable.push(`${gpu.name}：Remotion 硬件编码仅支持 NVIDIA NVENC 与 macOS VideoToolbox，该 GPU 走软件编码`)
  }

  // Chrome 模式：Linux GPU 场景用 chrome-for-testing（能真正用上 GPU），其余用更轻的 headless-shell
  let chromeMode: ChromeMode = "headless-shell"
  const wantChromeForTesting = input.platform === "linux" && Boolean(gpu)
  if (requested !== "disable" && wantChromeForTesting) {
    if (supports(version, "chromeMode")) {
      chromeMode = "chrome-for-testing"
      reasons.push("Linux + GPU：chrome-for-testing（模拟显示面，GPU 渲染更快）")
    } else {
      unavailable.push(`chrome-for-testing 需 Remotion ≥ ${FEATURE_MIN_VERSION.chromeMode}（当前 ${version ?? "?"}）`)
    }
  } else if (wantChromeForTesting) {
    reasons.push("硬件档被禁用：仍用 headless-shell")
  } else {
    reasons.push("headless-shell：CPU-bound 渲染更快、依赖更少")
  }
  if (overrides.chromeMode === "chrome-for-testing" || overrides.chromeMode === "headless-shell") {
    chromeMode = overrides.chromeMode
    reasons.push(`调用级指定 chrome_mode=${overrides.chromeMode}`)
  }

  // 光栅化后端：仅 WebGL/Three 内容指定 gl
  let gl: GlOption | null = null
  const glOverride = overrides.gl ?? "auto"
  if (glOverride === "off") {
    reasons.push("调用级指定 gl=off：使用默认后端")
  } else if (glOverride !== "auto") {
    gl = glOverride
    if (gl === "vulkan" && !supports(version, "glVulkan")) unavailable.push(`gl=vulkan 需 Remotion ≥ ${FEATURE_MIN_VERSION.glVulkan}`)
    if (gl === "angle-egl" && !supports(version, "glAngleEgl")) unavailable.push(`gl=angle-egl 需 Remotion ≥ ${FEATURE_MIN_VERSION.glAngleEgl}`)
    reasons.push(`调用级指定 gl=${gl}`)
  } else if (!webglContent) {
    reasons.push("项目不含 WebGL/Three 内容：不指定 gl（默认后端最优）")
  } else if (!gpu) {
    gl = "swangle"
    reasons.push("WebGL 内容 + 无 GPU：swangle 软件渲染")
  } else if (input.platform === "linux" && gpu.vendor === "nvidia") {
    gl = supports(version, "glVulkan") ? "vulkan" : "swangle"
    reasons.push("WebGL 内容 + Linux NVIDIA：gl=vulkan（官方 GPU 服务器档）")
  } else if (input.platform === "linux") {
    gl = supports(version, "glAngleEgl") ? "angle-egl" : "swangle"
    reasons.push("WebGL 内容 + Linux GPU：gl=angle-egl")
  } else {
    gl = "angle"
    reasons.push("WebGL 内容 + 桌面 GPU：gl=angle")
  }

  // 并发：默认用满 CPU 核数（Remotion 自身默认仅一半），可被实测缓存或调用级覆盖
  let concurrency = overrides.concurrency ?? input.cpuCount
  let fromTuning = false
  if (input.tuning) {
    if (overrides.concurrency === undefined && input.tuning.concurrency) concurrency = input.tuning.concurrency
    if (glOverride === "auto" && input.tuning.gl !== undefined) gl = input.tuning.gl
    if ((overrides.chromeMode ?? "auto") === "auto" && input.tuning.chromeMode) chromeMode = input.tuning.chromeMode
    if (requested === "auto" && input.tuning.hardwareAcceleration) hardwareAcceleration = input.tuning.hardwareAcceleration
    fromTuning = true
    reasons.push(`采用本机实测调优：并发 ${concurrency}${input.tuning.fps ? `（${input.tuning.fps.toFixed(1)} fps）` : ""}`)
  }
  concurrency = Math.max(1, Math.min(64, Math.floor(concurrency)))

  const videoBitrate = hardwareAcceleration !== "disable" ? "8M" : null
  if (videoBitrate) reasons.push("硬件编码使用 videoBitrate=8M（硬件编码不支持 crf）")

  return {
    platform: input.platform,
    arch: input.arch,
    cpuCount: input.cpuCount,
    memoryMB: input.memoryMB,
    concurrency,
    gpu,
    hardwareEncoder,
    hardwareAcceleration,
    chromeMode,
    gl,
    webglContent,
    videoBitrate,
    reasons,
    unavailable,
    fromTuning,
    remotionVersion: version,
  }
}

/** 决策结果的可读描述（工具输出用）。 */
export function describeProfile(p: RenderProfile): string {
  const lines = [
    `主机：${p.platform}/${p.arch} · ${p.cpuCount} 核${p.memoryMB ? ` · ${(p.memoryMB / 1024).toFixed(0)}GB 内存` : ""}`,
    `GPU：${p.gpu ? `${p.gpu.name}${p.gpu.driver ? `（驱动 ${p.gpu.driver}）` : ""}` : "无"}`,
    `编码：${p.hardwareAcceleration === "disable" ? "软件 x264" : `${p.hardwareEncoder ?? "硬件编码"}（hardwareAcceleration=${p.hardwareAcceleration}）${p.videoBitrate ? ` · ${p.videoBitrate}` : ""}`}`,
    `Chrome：${p.chromeMode}${p.gl ? ` · gl=${p.gl}` : " · 默认后端（非 WebGL 内容）"}`,
    `并发：${p.concurrency}（Remotion 默认仅一半核数）`,
  ]
  if (p.remotionVersion) lines.push(`Remotion：${p.remotionVersion}${p.fromTuning ? " · 已套用本机实测调优" : ""}`)
  if (p.unavailable.length) lines.push(`未能启用：${p.unavailable.join("；")}`)
  return lines.join("\n")
}
