/**
 * 分片不是万能提速：它只在单浏览器**留有空闲 CPU** 时才成立，而这必须实测、不能按核数推断——
 * 容器往往只拿到宿主的一部分配额（实测机器：`nproc` 报 8，cgroup 配额只有 4 核）。两种真实形态：
 *
 * - **CPU 富余型**：单个 Chrome 的截帧通道串行、整机 CPU 只用三成——此时多浏览器有效（加页无效）；
 * - **CPU 配额受限型**：单浏览器就把配额吃满并**持续被节流**。实测（4 核配额 · 1080p · 90 帧）：
 *   1 片 7.2 fps（占 3.69/4 核、节流时长是墙钟的 119%）→ 2 片 5.0 → 4 片 4.5 → 6 片 4.4，
 *   加片只会加剧争抢；同步实测的还有：并发 1/2/4 为 6.0/7.2/6.9 fps（默认 2 已最优）、
 *   540p 10.6 fps（截帧成本随像素线性）、gl 默认≈angle 7.2/7.3 而 swangle 1.1（灾难）。
 *
 * 故 `planShards` 以**上次整片实测的在用核数**为判据：接近配额即不分片，明显富余才加片。
 * 记账口径是 cgroup 的 `cpu.stat`（只有它反映本容器真实用量；`/proc/stat` 是宿主全局，仅作参系不参与判定）。
 *
 * **音轨不进分片**：每段音频都带自己的 AAC 编码器延迟，逐段拼接会在接缝留下数十毫秒静音或重叠；
 * 分片只出无声视频，音轨整段单独渲一次再合轨——按构造正确，不依赖拼接器对延迟的容忍。
 */
import { spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { coresUsedOf, type ThroughputEntry } from "./profile"

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
/** CPU 受限判据：上次实测的在用核数达到可用核数的这个比例，即认为配额已被吃满（分片无益）。 */
export const CPU_BOUND_RATIO = 0.7
/** CPU 富余判据：在用核数低于可用核数的这个比例，才认为加浏览器有实在收益。 */
export const CPU_HEADROOM_RATIO = 0.5

/** 实测结论（人读）：只用 cgroup 口径——它才是本容器真实用量；宿主全局读数含其他租户，不参与判定。 */
function measuredCores(opts: { measured?: ThroughputEntry | null; cpuCount: number }): { used: number; cores: number } | null {
  const m = opts.measured
  if (!m || m.cpuSource !== "cgroup" || m.wallMs <= 0) return null
  const cores = m.cores > 0 ? m.cores : Math.max(1, Math.floor(opts.cpuCount))
  const used = coresUsedOf(m)
  return used > 0 ? { used, cores } : null
}

export interface ShardPlan {
  /** 分片数；1 = 不切分（走单浏览器整段渲染）。 */
  count: number
  pagesPerShard: number
  /** 人读依据（写进作业日志与工具输出，便于解释"为什么切这么多片"）。 */
  reason: string
}

/**
 * 分片规划（纯函数）：按帧数与**上次整片实测的 CPU 占用**定片数（无实测记录时按核数保守推算）。
 * 调用级显式指定优先（`shards`），不受自动档阈值约束——但要如实告出它与实测的冲突。
 */
export function planShards(opts: { totalFrames: number; cpuCount: number; override?: number | null; measured?: ThroughputEntry | null }): ShardPlan {
  const cpu = Number.isFinite(opts.cpuCount) && opts.cpuCount > 0 ? Math.floor(opts.cpuCount) : 1
  const measured = measuredCores(opts)
  const cpuBound = measured && measured.used >= CPU_BOUND_RATIO * measured.cores ? measured : null
  if (opts.override !== undefined && opts.override !== null) {
    const requested = Math.floor(opts.override)
    if (!Number.isFinite(requested) || requested < 1) {
      return { count: 1, pagesPerShard: PAGES_PER_SHARD, reason: `分片数非法（${opts.override}）：按不切分处理` }
    }
    const count = Math.min(MAX_SHARDS, requested)
    const notes: string[] = []
    if (count !== requested) notes.push(`封顶到 ${count}（饱和点 ${MAX_SHARDS}）`)
    if (cpuBound && count > 1) notes.push(`⚠ 上次实测单浏览器已占 ${cpuBound.used.toFixed(1)}/${cpuBound.cores} 核，此处加片大概率更慢`)
    return {
      count,
      pagesPerShard: PAGES_PER_SHARD,
      reason: `调用级指定 ${requested} 片${notes.length ? `，${notes.join("；")}` : ""}`,
    }
  }
  if (cpuBound) {
    return {
      count: 1,
      pagesPerShard: PAGES_PER_SHARD,
      reason: `CPU 配额受限（上次实测单浏览器占 ${cpuBound.used.toFixed(1)}/${cpuBound.cores} 核）：单浏览器渲染——分片只会加剧争抢`,
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
  // 有实测且明显富余 → 按可用核数切（实测场景：单个 Chrome 卡在截帧通道、整机 CPU 只用三成）；
  // 无实测或无明确富余 → 回落核数的保守推算（每片先按 4 页养得起的量级）。
  const headroom = measured && measured.used <= CPU_HEADROOM_RATIO * measured.cores
  const byCpu = headroom ? measured!.cores : Math.max(1, Math.floor(cpu / PAGES_PER_SHARD))
  const count = Math.max(1, Math.min(MAX_SHARDS, byFrames, byCpu))
  const limits = headroom
    ? [`帧数允许 ${byFrames}`, `实测 CPU 富余（${measured!.used.toFixed(1)}/${measured!.cores} 核）允许 ${byCpu}`, `饱和点 ${MAX_SHARDS}`]
    : [`帧数允许 ${byFrames}`, `核数允许 ${byCpu}${measured ? `（实测在用 ${measured.used.toFixed(1)}/${measured.cores} 核，未显富余）` : ""}`, `饱和点 ${MAX_SHARDS}`]
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
