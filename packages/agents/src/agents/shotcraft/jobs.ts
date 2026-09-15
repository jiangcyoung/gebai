/**
 * shotcraft 渲染作业：长时渲染（成片可达数分钟）一律作为后台作业执行——工具调用立即返回作业 ID，
 * 进度经原生库回调实时汇入（渲染帧数/编码帧数/每秒帧数），stop 用 cancelSignal 中止，日志逐条落盘。
 * 队列按作业轻重分档（静帧/预览可并行，成片与实测调优独占），避免多作业互相抢 CPU/GPU。
 * 附带实测调优（bench）：并发候选实测 + 硬件编码强制探针（hardwareAcceleration=required），
 * 结论写入调优缓存——后续渲染自动套用，且不以推测冒充"已启用 GPU"。
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { jobsDir, jobIndexPath, jobLogPath, libraryRoot, tuningPath } from "./paths"
import {
  emptyTuningFile,
  machineSignature,
  tuningKey,
  type EncoderProbe,
  type RenderProfile,
  type TuningEntry,
  type TuningFile,
} from "./profile"
import { ensureBundle, acquireBrowser, type NativeBrowser, type NativeLibs, type VideoConfig } from "./runtime"

export type JobKind = "still" | "preview" | "video" | "bench"

export interface JobProgress {
  stage: string
  percent?: number
  renderedFrames?: number
  encodedFrames?: number
  totalFrames?: number
  fps?: number
}

export interface JobState {
  id: string
  kind: JobKind
  project: string
  composition: string
  output?: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  createdAt: string
  startedAt?: string
  endedAt?: string
  progress: JobProgress
  /** 实际请求的性能档（模型可见：这次到底跑在什么档上）。 */
  params?: Record<string, unknown>
  error?: string
  summary?: string
  logPath: string
}

const jobs = new Map<string, JobState>()
const cancels = new Map<string, () => void>()
const jobLogs = new Map<string, string[]>()

const LIGHT_KINDS = new Set<JobKind>(["still", "preview"])
const QUEUE_LIMIT = { heavy: 1, light: 2 }
let running = { heavy: 0, light: 0 }
const waiters: Array<() => void> = []

function isLight(kind: JobKind): boolean {
  return LIGHT_KINDS.has(kind)
}

async function acquireSlot(kind: JobKind): Promise<() => void> {
  const lane = isLight(kind) ? "light" : "heavy"
  while (running[lane] >= QUEUE_LIMIT[lane]) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  running[lane]++
  return () => {
    running[lane]--
    const next = waiters.shift()
    if (next) next()
  }
}

let seq = 0
function nextJobId(kind: JobKind): string {
  seq++
  return `${kind}-${Date.now().toString(36)}-${seq}`
}

export function createJob(opts: {
  ctx: ToolContext
  kind: JobKind
  project: string
  composition: string
  output?: string
  params?: Record<string, unknown>
}): JobState {
  const id = nextJobId(opts.kind)
  const logPath = jobLogPath(opts.ctx, id)
  mkdirSync(jobsDir(opts.ctx), { recursive: true })
  const job: JobState = {
    id,
    kind: opts.kind,
    project: opts.project,
    composition: opts.composition,
    output: opts.output,
    status: "queued",
    createdAt: new Date().toISOString(),
    progress: { stage: "排队中" },
    params: opts.params,
    logPath,
  }
  jobs.set(id, job)
  jobLogs.set(id, [])
  appendIndex(opts.ctx, { id, kind: job.kind, project: job.project, composition: job.composition, output: job.output, startedAt: job.createdAt })
  return job
}

function appendIndex(ctx: ToolContext, entry: Record<string, unknown>): void {
  try {
    mkdirSync(jobsDir(ctx), { recursive: true })
    appendFileSync(jobIndexPath(ctx), `${JSON.stringify(entry)}\n`)
  } catch {
    /* 索引失败不影响渲染 */
  }
}

/** 作业日志：落盘 + 内存保留最近 200 行（status/log 查询用）。 */
export function jobLog(job: JobState, ctx: ToolContext, line: string): void {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`
  const buf = jobLogs.get(job.id) ?? []
  buf.push(stamped)
  if (buf.length > 200) buf.splice(0, buf.length - 200)
  jobLogs.set(job.id, buf)
  try {
    appendFileSync(jobLogPath(ctx, job.id), `${stamped}\n`)
  } catch {
    /* 日志落盘失败不影响渲染 */
  }
}

export function readJobLog(job: JobState, ctx: ToolContext, tail: number): string {
  const mem = jobLogs.get(job.id) ?? []
  try {
    const full = readFileSync(jobLogPath(ctx, job.id), "utf8").split("\n").filter(Boolean)
    const lines = full.length ? full : mem
    return lines.slice(-tail).join("\n")
  } catch {
    return mem.slice(-tail).join("\n")
  }
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id)
}

export function listJobs(): JobState[] {
  return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function cancelJob(id: string): boolean {
  const cancel = cancels.get(id)
  if (!cancel) return false
  cancel()
  return true
}

/** 后台执行作业（工具调用立即返回）：排队 → 运行 → 收尾状态与索引。 */
export function startJob(ctx: ToolContext, job: JobState, run: (log: (line: string) => void, register: (cancel: () => void) => void) => Promise<string>): void {
  const log = (line: string) => jobLog(job, ctx, line)
  void (async () => {
    const release = await acquireSlot(job.kind)
    if (job.status === "cancelled") {
      release()
      return
    }
    job.status = "running"
    job.startedAt = new Date().toISOString()
    job.progress = { stage: "启动中" }
    const register = (cancel: () => void) => cancels.set(job.id, cancel)
    try {
      const summary = await run(log, register)
      job.status = "done"
      job.summary = summary
    } catch (err) {
      const message = (err as Error).message ?? String(err)
      if (/cancel/i.test(message)) {
        job.status = "cancelled"
        job.error = message
      } else {
        job.status = "failed"
        job.error = message
      }
    } finally {
      job.endedAt = new Date().toISOString()
      job.progress.stage = job.status === "done" ? "完成" : job.status === "cancelled" ? "已中止" : "失败"
      cancels.delete(job.id)
      appendIndex(ctx, { id: job.id, kind: job.kind, status: job.status, output: job.output, endedAt: job.endedAt, error: job.error })
      release()
    }
  })()
}

/** 作业状态可读描述（进度条 + 帧数 + 速率 + 预计剩余）。 */
export function describeJob(job: JobState): string {
  const p = job.progress
  const parts: string[] = [`${job.id} · ${job.kind} · ${job.status}`]
  const total = p.totalFrames
  const done = p.renderedFrames
  if (total && done !== undefined) {
    const percent = p.percent ?? Math.round((done / total) * 100)
    const filled = Math.round((percent / 100) * 20)
    parts.push(`[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${percent}% · 帧 ${done}/${total}`)
    if (p.fps && p.fps > 0) {
      const remain = Math.max(0, total - done) / p.fps
      parts.push(`${p.fps.toFixed(1)} fps · 预计剩余 ${remain < 60 ? `${remain.toFixed(0)}s` : `${(remain / 60).toFixed(1)}min`}`)
    }
  } else if (p.percent !== undefined) {
    parts.push(`${p.stage} ${p.percent}%`)
  } else {
    parts.push(p.stage)
  }
  return parts.join(" · ")
}

// —— 调优缓存读写 ——

export function readTuning(ctx: ToolContext): TuningFile {
  try {
    const parsed = JSON.parse(readFileSync(tuningPath(ctx), "utf8")) as TuningFile
    return { encoderProbe: parsed.encoderProbe, entries: parsed.entries ?? {} }
  } catch {
    return emptyTuningFile()
  }
}

export function writeTuning(ctx: ToolContext, file: TuningFile): void {
  mkdirSync(libraryRoot(ctx), { recursive: true })
  mkdirSync(join(libraryRoot(ctx), "state"), { recursive: true })
  writeFileSync(tuningPath(ctx), JSON.stringify(file, null, 2))
}

export function recordEncoderProbe(ctx: ToolContext, probe: EncoderProbe): void {
  const file = readTuning(ctx)
  file.encoderProbe = probe
  writeTuning(ctx, file)
}

export function recordTuningEntry(ctx: ToolContext, key: string, entry: TuningEntry): void {
  const file = readTuning(ctx)
  file.entries[key] = entry
  writeTuning(ctx, file)
}

/** 取本机 + 项目 + 合成的实测调优（无则 null）。 */
export function pickTuningEntry(ctx: ToolContext, profile: RenderProfile, projectDir: string, composition: string): TuningEntry | null {
  const file = readTuning(ctx)
  const sig = machineSignature({
    platform: profile.platform,
    arch: profile.arch,
    cpuCount: profile.cpuCount,
    gpu: profile.gpu,
    remotionVersion: profile.remotionVersion,
    webglContent: profile.webglContent,
  })
  return file.entries[tuningKey(sig, projectDir, composition)] ?? null
}

export function tuningKeyFor(profile: RenderProfile, projectDir: string, composition: string): string {
  const sig = machineSignature({
    platform: profile.platform,
    arch: profile.arch,
    cpuCount: profile.cpuCount,
    gpu: profile.gpu,
    remotionVersion: profile.remotionVersion,
    webglContent: profile.webglContent,
  })
  return tuningKey(sig, projectDir, composition)
}

// —— 渲染执行 ——

export interface RenderRunArgs {
  ctx: ToolContext
  libs: NativeLibs
  projectDir: string
  entryPoint: string
  serveUrl: string
  composition: VideoConfig
  profile: RenderProfile
  browser: NativeBrowser
  inputProps: Record<string, unknown>
}

function chromiumOf(profile: RenderProfile): Record<string, unknown> {
  return profile.gl ? { gl: profile.gl } : {}
}

/** 从 Remotion 的并发拒绝错误中取本机上限（`Maximum for --concurrency is N (number of cores on this system)`）。 */
export function parseConcurrencyLimit(message: string): number | null {
  const m = /Maximum for --concurrency is (\d+)/.exec(message)
  return m ? Number(m[1]) : null
}

/** 静帧渲染（逐镜头 QA 的主力：秒级发起、热 bundle + 热浏览器）。 */
export async function runStill(args: RenderRunArgs & { job: JobState; frame: number; output: string; imageFormat: string; jpegQuality?: number; scale?: number }): Promise<string> {
  const { job, profile } = args
  const { cancelSignal, cancel } = args.libs.makeCancelSignal()
  args.job.progress = { stage: "渲染静帧", renderedFrames: 0, totalFrames: 1 }
  const started = Date.now()
  jobLog(job, args.ctx, `静帧渲染：合成 ${args.composition.id} · 帧 ${args.frame} · 输出 ${args.output}`)
  await args.libs.renderStill({
    composition: args.composition,
    serveUrl: args.serveUrl,
    output: args.output,
    frame: args.frame,
    imageFormat: args.imageFormat,
    jpegQuality: args.jpegQuality,
    scale: args.scale,
    inputProps: args.inputProps,
    puppeteerInstance: args.browser,
    chromeMode: profile.chromeMode,
    chromiumOptions: chromiumOf(profile),
    logLevel: "error",
    overwrite: true,
    cancelSignal,
  }).catch((err: unknown) => {
    cancel()
    throw err
  })
  job.progress = { stage: "完成", renderedFrames: 1, totalFrames: 1 }
  const ms = Date.now() - started
  jobLog(job, args.ctx, `静帧完成：${ms}ms`)
  return `静帧已渲染：${args.output}（${(ms / 1000).toFixed(1)}s，合成 ${args.composition.id} 帧 ${args.frame}）`
}

export interface MediaRunOptions {
  frameRange?: [number, number]
  scale?: number
  codec?: string
  videoBitrate?: string | null
  crf?: number | null
  imageFormat?: string
  jpegQuality?: number
  /** 强制硬件编码档（bench 探针用 required）。 */
  hardwareAcceleration?: RenderProfile["hardwareAcceleration"]
  concurrency?: number
}

/** 视频渲染（成片/预览段/实测调优共用）：进度经原生库 onProgress 回调实时汇入作业。 */
export async function runMediaRender(args: RenderRunArgs & { job: JobState; output: string; options?: MediaRunOptions }): Promise<string> {
  const { job, profile } = args
  const opts = args.options ?? {}
  const codec = opts.codec ?? "h264"
  const hardwareAcceleration = opts.hardwareAcceleration ?? profile.hardwareAcceleration
  const concurrency = opts.concurrency ?? profile.concurrency
  const { cancelSignal, cancel } = args.libs.makeCancelSignal()
  const frameRange = opts.frameRange
  const totalFrames = frameRange ? frameRange[1] - frameRange[0] + 1 : args.composition.durationInFrames
  job.progress = { stage: "渲染中", renderedFrames: 0, encodedFrames: 0, totalFrames, percent: 0 }
  const started = Date.now()
  let lastLog = 0
  jobLog(
    job,
    args.ctx,
    `视频渲染：合成 ${args.composition.id}${frameRange ? ` · 帧段 ${frameRange[0]}-${frameRange[1]}` : " · 全片"} · 编码 ${codec} · 并发 ${concurrency} · 硬件编码 ${hardwareAcceleration} · Chrome ${profile.chromeMode}${profile.gl ? ` gl=${profile.gl}` : ""} · 输出 ${args.output}`,
  )
  const params: Record<string, unknown> = {
    composition: args.composition,
    serveUrl: args.serveUrl,
    codec,
    outputLocation: args.output,
    inputProps: args.inputProps,
    concurrency,
    imageFormat: opts.imageFormat ?? "jpeg",
    jpegQuality: opts.jpegQuality ?? 80,
    scale: opts.scale,
    frameRange,
    puppeteerInstance: args.browser,
    chromeMode: profile.chromeMode,
    chromiumOptions: chromiumOf(profile),
    logLevel: "error",
    overwrite: true,
    cancelSignal,
    onProgress: (p: { renderedFrames?: number; encodedFrames?: number; progress?: number; stitchStage?: string }) => {
      job.progress = {
        stage: p.stitchStage ?? "渲染中",
        renderedFrames: p.renderedFrames,
        encodedFrames: p.encodedFrames,
        totalFrames,
        percent: p.progress !== undefined ? Math.round(p.progress * 100) : undefined,
        fps: p.renderedFrames ? p.renderedFrames / ((Date.now() - started) / 1000) : undefined,
      }
      const now = Date.now()
      if (now - lastLog > 30_000) {
        lastLog = now
        jobLog(job, args.ctx, describeJob(job))
      }
    },
  }
  if (hardwareAcceleration !== "disable") {
    params.hardwareAcceleration = hardwareAcceleration
    const bitrate = opts.videoBitrate ?? profile.videoBitrate ?? "8M"
    params.videoBitrate = bitrate
  } else if (opts.crf !== null && opts.crf !== undefined) {
    params.crf = opts.crf
  }
  await args.libs.renderMedia(params).catch(async (err: unknown) => {
    // 自愈：并发超过本机上限时 Remotion 直接拒绝（Maximum for --concurrency is N）——按实际上限重试一次
    const limit = parseConcurrencyLimit((err as Error).message)
    if (limit === null || limit < 1) {
      cancel()
      throw err
    }
    jobLog(job, args.ctx, `并发 ${concurrency} 超本机上限（${limit}），按上限重试`)
    params.concurrency = limit
    job.progress = { stage: "渲染中（并发已按上限调整）", renderedFrames: 0, totalFrames }
    await args.libs.renderMedia(params)
  })
  const ms = Date.now() - started
  const fps = totalFrames / (ms / 1000)
  job.progress.fps = fps
  jobLog(job, args.ctx, `渲染完成：${totalFrames} 帧 / ${(ms / 1000).toFixed(1)}s（${fps.toFixed(1)} fps）`)
  return `已渲染 ${totalFrames} 帧 → ${args.output}（${(ms / 1000).toFixed(1)}s，${fps.toFixed(1)} fps；编码 ${codec}${hardwareAcceleration !== "disable" ? ` · 硬件编码 ${hardwareAcceleration}` : " · 软件编码"}）`
}

/** 实测调优：硬件编码强制探针 + 并发候选实测，结论写入调优缓存。 */
export async function runBench(args: RenderRunArgs & {
  job: JobState
  candidates: number[]
  frameRange: [number, number]
  benchDir: string
}): Promise<string> {
  const { job, profile } = args
  mkdirSync(args.benchDir, { recursive: true })
  const lines: string[] = []
  const probe = await probeHardwareEncoder(args)
  const file = readTuning(args.ctx)
  file.encoderProbe = probe
  writeTuning(args.ctx, file)
  lines.push(
    probe.hardware
      ? `硬件编码探针：通过（hardwareAcceleration=required 渲染成功，本机编码器可用）`
      : `硬件编码探针：未通过（${probe.error ?? "未知原因"}）——本机按软件编码运行`,
  )
  jobLog(job, args.ctx, lines[lines.length - 1])

  const results: Array<{ concurrency: number; fps: number; seconds: number }> = []
  for (const concurrency of args.candidates) {
    const out = join(args.benchDir, `bench-${concurrency}.mp4`)
    const started = Date.now()
    job.progress = { stage: `实测并发 ${concurrency}`, totalFrames: args.frameRange[1] - args.frameRange[0] + 1, renderedFrames: 0 }
    try {
      await runMediaRender({ ...args, output: out, job: args.job, options: { frameRange: args.frameRange, concurrency, imageFormat: "jpeg", jpegQuality: 80 } })
      const seconds = Math.max((Date.now() - started) / 1000, 0.001)
      const frames = args.frameRange[1] - args.frameRange[0] + 1
      results.push({ concurrency, seconds, fps: frames / seconds })
      jobLog(job, args.ctx, `并发 ${concurrency}：${seconds.toFixed(1)}s（${(frames / seconds).toFixed(1)} fps）`)
    } catch (err) {
      jobLog(job, args.ctx, `并发 ${concurrency} 实测失败：${(err as Error).message}`)
    } finally {
      rmSync(out, { force: true })
    }
  }
  if (!results.length) throw new Error("并发实测全部失败，未写入调优缓存")
  results.sort((a, b) => b.fps - a.fps)
  const best = results[0]
  const entry: TuningEntry = {
    concurrency: best.concurrency,
    gl: profile.gl,
    chromeMode: profile.chromeMode,
    hardwareAcceleration: profile.hardwareAcceleration,
    fps: best.fps,
    measuredAt: new Date().toISOString(),
  }
  recordTuningEntry(args.ctx, tuningKeyFor(profile, args.projectDir, args.composition.id), entry)
  const table = results.map((r) => `并发 ${r.concurrency}：${r.seconds.toFixed(1)}s（${r.fps.toFixed(1)} fps）`).join("；")
  lines.push(`并发实测：${table}`)
  lines.push(`已写入调优缓存：并发 ${best.concurrency}（后续同项目/同合成渲染自动采用）`)
  return lines.join("\n")
}

/** 硬件编码强制探针：以 hardwareAcceleration=required 渲染 2 帧——成功即本机原生编码器确实可用。 */
async function probeHardwareEncoder(args: RenderRunArgs & { job: JobState; benchDir: string }): Promise<EncoderProbe> {
  const now = new Date().toISOString()
  if (!args.profile.gpu) {
    return { hardware: false, checkedAt: now, error: "未检测到 GPU（NVENC/VideoToolbox 均不可用）" }
  }
  const out = join(args.benchDir, "probe.mp4")
  try {
    await args.libs.renderMedia({
      composition: args.composition,
      serveUrl: args.serveUrl,
      codec: "h264",
      outputLocation: out,
      inputProps: args.inputProps,
      concurrency: 1,
      frameRange: [0, 1],
      imageFormat: "jpeg",
      jpegQuality: 60,
      hardwareAcceleration: "required",
      videoBitrate: "4M",
      puppeteerInstance: args.browser,
      chromeMode: args.profile.chromeMode,
      chromiumOptions: chromiumOf(args.profile),
      logLevel: "error",
      overwrite: true,
      onProgress: () => {},
    })
    return { hardware: true, checkedAt: now, composition: args.composition.id }
  } catch (err) {
    return { hardware: false, checkedAt: now, composition: args.composition.id, error: (err as Error).message.slice(0, 400) }
  } finally {
    rmSync(out, { force: true })
  }
}

/** 打包 + 浏览器就绪（渲染前置）：封装为一次调用，避免工具层重复编排。 */
export async function prepareRender(opts: {
  ctx: ToolContext
  libs: NativeLibs
  projectDir: string
  entryPoint: string
  profile: RenderProfile
  onLog: (line: string) => void
  onBundleProgress?: (percent: number) => void
  onDownloadProgress?: (percent: number) => void
}): Promise<{ serveUrl: string; browser: NativeBrowser; bundleCached: boolean; bundleMs: number }> {
  const bundle = await ensureBundle({
    projectDir: opts.projectDir,
    libs: opts.libs,
    stateRoot: libraryRoot(opts.ctx),
    entryPoint: opts.entryPoint,
    onProgress: opts.onBundleProgress,
    onLog: opts.onLog,
  })
  const browser = await acquireBrowser({
    libs: opts.libs,
    projectDir: opts.projectDir,
    chromeMode: opts.profile.chromeMode,
    gl: opts.profile.gl,
    onLog: opts.onLog,
    onDownloadProgress: opts.onDownloadProgress,
  })
  return { serveUrl: bundle.serveUrl, browser, bundleCached: bundle.cached, bundleMs: bundle.ms }
}
