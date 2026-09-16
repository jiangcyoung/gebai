/**
 * 分片并行渲染：帧段切分、分片规划，以及拼接/合轨所需的外部件。
 *
 * **为什么是「多浏览器」而不是「多页」**（实测，见 docs/reel-render-performance.md）：
 * 单个 Chrome 的截帧通道是串行的——把页数从 2 加到 28，吞吐锁死在 ~21 fps、整机 CPU 只用三成；
 * 每片各带一个 Chrome 后吞吐随片数上升（本机 1080p · 300 帧样本：1 片 37.2 fps → 4 片 64.3 → 6 片 72.0）。
 * 瓶颈在单个浏览器，不在 CPU，故「加页无效、加浏览器有效」。
 *
 * **音轨不进分片**：每段音频都带自己的 AAC 编码器延迟，逐段拼接会在接缝留下数十毫秒静音或重叠；
 * 分片只出无声视频，音轨整段单独渲一次再合轨——按构造正确，不依赖拼接器对延迟的容忍。
 */
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 片内页数：实测 4 页即饱和，再多只占页面池（每页一个 tab）不提吞吐。 */
export const PAGES_PER_SHARD = 4
/**
 * 单片最短帧数：再短则浏览器启动与编码器初始化的固定开销盖过并行收益。
 * 实测依据：50 帧/片（300 帧切 6 片）时仍是全部配置里最快的一档，故下限取 60 留出余量。
 */
export const MIN_FRAMES_PER_SHARD = 60
/**
 * 分片数上限：实测吞吐在 6 片见顶（300 帧样本 6 片 72.0 fps / 8 片 69.7 / 10 片 67.8 / 12 片 60.2）——
 * 超过后浏览器争抢与拼接开销抬头，故封顶 6。
 */
export const MAX_SHARDS = 6
/** 启用自动分片的最低总帧数：低于此规模单浏览器本就只需数秒，不值得付启动开销。 */
export const MIN_TOTAL_FRAMES_FOR_AUTO_SHARD = 180

export interface ShardPlan {
  /** 分片数；1 = 不切分（走单浏览器整段渲染）。 */
  count: number
  pagesPerShard: number
  /** 人读依据（写进作业日志与工具输出，便于解释"为什么切这么多片"）。 */
  reason: string
}

/**
 * 分片规划（纯函数）：按帧数、核数与实测饱和点定片数。
 * 调用级显式指定优先（`shards`），不受自动档阈值约束。
 */
export function planShards(opts: { totalFrames: number; cpuCount: number; override?: number | null }): ShardPlan {
  if (opts.override !== undefined && opts.override !== null) {
    const requested = Math.floor(opts.override)
    if (!Number.isFinite(requested) || requested < 1) {
      return { count: 1, pagesPerShard: PAGES_PER_SHARD, reason: `分片数非法（${opts.override}）：按不切分处理` }
    }
    const count = Math.min(MAX_SHARDS, requested)
    return {
      count,
      pagesPerShard: PAGES_PER_SHARD,
      reason: `调用级指定 ${requested} 片${count !== requested ? `，封顶到 ${count}（实测吞吐在 ${MAX_SHARDS} 片见顶）` : ""}`,
    }
  }
  const totalFrames = Math.max(0, Math.floor(opts.totalFrames))
  if (totalFrames < MIN_TOTAL_FRAMES_FOR_AUTO_SHARD) {
    return {
      count: 1,
      pagesPerShard: PAGES_PER_SHARD,
      reason: `帧数 ${totalFrames} 低于自动分片阈值 ${MIN_TOTAL_FRAMES_FOR_AUTO_SHARD}：单浏览器渲染（分片启动开销大于收益）`,
    }
  }
  const byFrames = Math.floor(totalFrames / MIN_FRAMES_PER_SHARD)
  const cpu = Number.isFinite(opts.cpuCount) && opts.cpuCount > 0 ? Math.floor(opts.cpuCount) : 1
  const byCpu = Math.max(1, Math.floor(cpu / PAGES_PER_SHARD))
  const count = Math.max(1, Math.min(MAX_SHARDS, byFrames, byCpu))
  const limits = [`帧数允许 ${byFrames}`, `核数允许 ${byCpu}`, `实测饱和点 ${MAX_SHARDS}`]
  return {
    count,
    pagesPerShard: PAGES_PER_SHARD,
    reason: count > 1 ? `自动分片 ${count} 片（取 ${limits.join(" / ")} 的最小值）` : `自动判定不分片（${limits.join(" / ")}）`,
  }
}

/**
 * 帧段等分（纯函数）：切成 count 段连续区间，尽量均衡（余数分给前若干片）。
 * 边界为闭区间，段与段首尾相接不重叠——拼接后即原帧段。
 */
export function splitFrameRange(start: number, end: number, count: number): Array<[number, number]> {
  const total = end - start + 1
  const n = Math.max(1, Math.min(Math.floor(count), total))
  if (n <= 1) return [[start, end]]
  const base = Math.floor(total / n)
  const remainder = total % n
  const out: Array<[number, number]> = []
  let cursor = start
  for (let i = 0; i < n; i++) {
    const size = base + (i < remainder ? 1 : 0)
    out.push([cursor, cursor + size - 1])
    cursor += size
  }
  return out
}

/** 平台对应的 compositor 包名（内含 remotion/ffmpeg/ffprobe 三件套，与 Remotion 同规则）。 */
const COMPOSITOR_PACKAGES: Record<string, string[]> = {
  win32: ["@remotion/compositor-win32-x64-msvc"],
  darwin: ["@remotion/compositor-darwin-arm64", "@remotion/compositor-darwin-x64"],
  linux: [
    "@remotion/compositor-linux-x64-gnu",
    "@remotion/compositor-linux-x64-musl",
    "@remotion/compositor-linux-arm64-gnu",
    "@remotion/compositor-linux-arm64-musl",
  ],
}

/**
 * 拼接/合轨用的 ffmpeg：优先调用方配置的 binariesDirectory，其次运行时依赖内的 compositor 包。
 * 两处都没有返回 null（调用方据此回退到不分片，而不是渲完才发现拼不起来）。
 */
export function resolveShardFfmpeg(opts: {
  binariesDirectory?: string | null
  /** 含 node_modules 的候选根（共享运行时目录、原生库所在目录等）。 */
  roots?: Array<string | null | undefined>
}): string | null {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  if (opts.binariesDirectory) {
    const candidate = join(opts.binariesDirectory, exe)
    if (existsSync(candidate)) return candidate
  }
  for (const root of opts.roots ?? []) {
    if (!root) continue
    for (const pkg of COMPOSITOR_PACKAGES[process.platform] ?? []) {
      const candidate = join(root, "node_modules", ...pkg.split("/"), exe)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 运行外部件并把失败转成带 stderr 摘要的错误（拼接/合轨失败必须可诊断）。 */
function runFfmpeg(ffmpeg: string, args: string[], what: string): void {
  const result = spawnSync(ffmpeg, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw new Error(`${what}失败：${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" | ")
    throw new Error(`${what}失败（ffmpeg 退出码 ${result.status}）：${detail.slice(0, 500)}`)
  }
}

/**
 * 无损拼接同参数的分片视频（concat 分离器 + `-c copy`，不重编码）。
 * 各片由同一份编码参数产出，拼接只做容器级接续，故画质与单次整段渲染一致（实测逐帧 PSNR ≥ 42dB）。
 */
export function concatVideoSegments(opts: { ffmpeg: string; segments: string[]; output: string; listPath: string }): void {
  const body = opts.segments
    .map((segment) => `file '${segment.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n")
  writeFileSync(opts.listPath, `${body}\n`)
  runFfmpeg(
    opts.ffmpeg,
    ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", opts.listPath, "-c", "copy", "-movflags", "+faststart", opts.output],
    "分片拼接",
  )
}

/** 把整段音轨合回无声视频（两路都 `-c copy`，不重编码）。 */
export function muxAudioVideo(opts: { ffmpeg: string; video: string; audio: string; output: string }): void {
  runFfmpeg(
    opts.ffmpeg,
    [
      "-v", "error", "-y",
      "-i", opts.video,
      "-i", opts.audio,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c", "copy",
      "-movflags", "+faststart",
      opts.output,
    ],
    "音视频合轨",
  )
}
