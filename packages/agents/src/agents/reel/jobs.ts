/**
 * 渲染作业：长时渲染（成片可达数分钟）一律后台执行——工具调用立即返回作业 ID，进度经原生库 onProgress
 * 回调汇入（帧数 / 百分比 / fps / 预计剩余），取消走 cancelSignal，日志按行落盘，索引按 JSONL 追加。
 * 队列分档：静帧/预览并行 2（逐镜头 QA 要能连着发），成片/实测调优独占 1（抢 CPU/GPU 反而更慢）。
 * 附带实测调优（bench）：硬件编码强制探针（hardwareAcceleration=required）+ 并发候选实测，结论写入调优缓存。
 *
 * 坑（真机经验，必须照做）：
 * - `binariesDirectory` 默认不传：Remotion 用项目内 @remotion/compositor-* 的 compositor 与 ffmpeg，
 *   只给一个 ffmpeg 的目录会让 compositor 查找失败（调用方配置的目录须含三件套）。
 * - 并发与 Remotion 同规则（见 detect.effectiveCpuCount）；仍被拒时按报错里的上限自愈重试一次。
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { effectiveCpuCount } from "./detect"
import { jobIndexPath, jobLogPath, jobsDir, stateDir, tuningPath } from "./paths"
import { chromiumOf, profileKey, type HardwareAcceleration, type RenderProfile, type TunedEntry } from "./profile"
import type { NativeBrowser, NativeLibs, VideoConfig } from "./runtime"

export type JobKind = "still" | "preview" | "video" | "bench"
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"

export interface JobProgress {
  stage: string
  percent?: number
  renderedFrames?: number
  totalFrames?: number
  fps?: number
  etaSec?: number
}

export interface Job {
  id: string
  kind: JobKind
  project: string
  composition: string
  status: JobStatus
  output?: string
  /** 登记时刻（排队开始）；实际开跑时刷新为运行时刻。 */
  startedAt: string
  endedAt?: string
  error?: string
  summary?: string
  progress?: JobProgress
}

/** 机器级硬件编码探针结论（bench 以 hardwareAcceleration=required 实测所得）。 */
interface EncoderProbe {
  hardware: boolean
  checkedAt: string
  error?: string
}

/** 本机调优缓存：机器级硬件编码探针结论 + 按 profileKey 记账的实测档位。 */
export interface Tuning {
  encoderProbe?: EncoderProbe
  entries: Record<string, TunedEntry>
}

// —— 作业注册表与队列 ——

const jobs = new Map<string, Job>()
const logs = new Map<string, string[]>()
interface CancelSlot {
  cancel: (() => void) | null
  cancelled: boolean
}
const cancelSlots = new Map<string, CancelSlot>()

type Lane = "light" | "heavy"
const LANE_OF: Record<JobKind, Lane> = { still: "light", preview: "light", video: "heavy", bench: "heavy" }
const LANE_LIMIT: Record<Lane, number> = { light: 2, heavy: 1 }
const running: Record<Lane, number> = { light: 0, heavy: 0 }
const waiters: Array<{ lane: Lane; resolve: () => void }> = []

/** 释放名额后按先进先出把名额发下去（同档保序，不同档互不阻塞）。 */
function pump(): void {
  let i = 0
  while (i < waiters.length) {
    const waiter = waiters[i]
    if (running[waiter.lane] < LANE_LIMIT[waiter.lane]) {
      running[waiter.lane]++
      waiters.splice(i, 1)
      waiter.resolve()
    } else {
      i++
    }
  }
}

async function acquireSlot(kind: JobKind): Promise<() => void> {
  const lane = LANE_OF[kind]
  if (running[lane] < LANE_LIMIT[lane]) {
    running[lane]++
  } else {
    await new Promise<void>((resolve) => waiters.push({ lane, resolve }))
  }
  return () => {
    running[lane]--
    pump()
  }
}

let seq = 0
function nextJobId(kind: JobKind): string {
  seq++
  return `${kind}-${Date.now().toString(36)}-${seq}`
}

function appendIndex(ctx: ToolContext, entry: Record<string, unknown>): void {
  try {
    mkdirSync(jobsDir(ctx), { recursive: true })
    appendFileSync(jobIndexPath(ctx), `${JSON.stringify(entry)}\n`)
  } catch {
    /* 索引落盘失败不影响渲染 */
  }
}

export function createJob(opts: {
  ctx: ToolContext
  kind: JobKind
  project: string
  composition: string
  output?: string
}): Job {
  const job: Job = {
    id: nextJobId(opts.kind),
    kind: opts.kind,
    project: opts.project,
    composition: opts.composition,
    output: opts.output,
    status: "queued",
    startedAt: new Date().toISOString(),
    progress: { stage: "排队中" },
  }
  jobs.set(job.id, job)
  logs.set(job.id, [])
  appendIndex(opts.ctx, {
    id: job.id,
    kind: job.kind,
    project: job.project,
    composition: job.composition,
    output: job.output,
    status: job.status,
    startedAt: job.startedAt,
  })
  return job
}

export function getJob(id: string): Job | null {
  return jobs.get(id) ?? null
}

/** 作业已到终态（不再变化）。 */
function isSettled(job: Job): boolean {
  return job.status === "done" || job.status === "failed" || job.status === "cancelled"
}

/**
 * 同步等待作业到终态（供 still 的 `wait=true` 送审路径用：静帧秒级，等它比再轮询一次省一个往返）。
 * 超时返回当前作业——调用方按 `status` 判定，仍未终态就提示用 action=status 继续查。
 */
export async function waitJob(id: string, timeoutMs = 180_000, intervalMs = 150): Promise<Job | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = getJob(id)
    if (!job) return null
    if (isSettled(job)) return job
    if (Date.now() >= deadline) return job
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 作业列表：索引 JSONL 回放（跨进程可见的历史）叠加内存中的最新状态，按开始时间倒序。 */
export function listJobs(ctx: ToolContext, limit = 20): Job[] {
  const byId = new Map<string, Job>()
  let text = ""
  try {
    text = readFileSync(jobIndexPath(ctx), "utf8")
  } catch {
    text = ""
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as Partial<Job>
      if (!rec.id || !rec.kind) continue
      const prev = byId.get(rec.id)
      byId.set(rec.id, {
        id: rec.id,
        kind: rec.kind,
        project: rec.project ?? prev?.project ?? "",
        composition: rec.composition ?? prev?.composition ?? "",
        status: rec.status ?? prev?.status ?? "queued",
        output: rec.output ?? prev?.output,
        startedAt: rec.startedAt ?? prev?.startedAt ?? "",
        endedAt: rec.endedAt ?? prev?.endedAt,
        error: rec.error ?? prev?.error,
        summary: rec.summary ?? prev?.summary,
        progress: prev?.progress,
      })
    } catch {
      /* 跳过损坏行 */
    }
  }
  for (const [id, job] of jobs) byId.set(id, { ...byId.get(id), ...job })
  return [...byId.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, Math.max(1, limit))
}

/** 作业状态人读描述（进度条 + 帧数 + 速率 + 预计剩余）。 */
export function describeJob(job: Job): string {
  const parts: string[] = [`${job.id} · ${job.kind} · ${job.status}`]
  const progress = job.progress
  if (progress) {
    const total = progress.totalFrames
    const done = progress.renderedFrames
    if (total && done !== undefined) {
      const percent = progress.percent ?? Math.round((done / total) * 100)
      const filled = Math.round((percent / 100) * 20)
      parts.push(`[${"#".repeat(filled)}${"-".repeat(Math.max(0, 20 - filled))}] ${percent}% · 帧 ${done}/${total}`)
      if (progress.fps && progress.fps > 0) {
        const etaSec = progress.etaSec ?? Math.max(0, total - done) / progress.fps
        parts.push(`${progress.fps.toFixed(1)} fps · 预计剩余 ${etaSec < 60 ? `${etaSec.toFixed(0)}s` : `${(etaSec / 60).toFixed(1)}min`}`)
      }
    } else if (progress.percent !== undefined) {
      parts.push(`${progress.stage} ${progress.percent}%`)
    } else {
      parts.push(progress.stage)
    }
  }
  if (job.output) parts.push(`产物 ${job.output}`)
  if (job.summary) parts.push(job.summary.split("\n")[0]!)
  if (job.error) parts.push(`错误 ${job.error}`)
  return parts.join(" · ")
}

/** 追加一行作业日志：内存保留最近 200 行（进程内查询），同时落盘（跨进程/事后排查）。 */
export function jobLog(job: Job, ctx: ToolContext, line: string): void {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`
  const buf = logs.get(job.id) ?? []
  buf.push(stamped)
  if (buf.length > 200) buf.splice(0, buf.length - 200)
  logs.set(job.id, buf)
  try {
    appendFileSync(jobLogPath(ctx, job.id), `${stamped}\n`)
  } catch {
    /* 日志落盘失败不影响渲染 */
  }
}

/** 读取作业日志尾部若干行（落盘优先，落盘不可读时回落到内存缓冲）。 */
export function readJobLog(ctx: ToolContext, id: string, tailLines = 50): string {
  const mem = logs.get(id) ?? []
  try {
    const lines = readFileSync(jobLogPath(ctx, id), "utf8").split("\n").filter(Boolean)
    const source = lines.length ? lines : mem
    return source.slice(-Math.max(1, tailLines)).join("\n")
  } catch {
    return mem.slice(-Math.max(1, tailLines)).join("\n")
  }
}

/** 运行期把原生库的取消触发器登记到作业上（startJob 已建槽位；未登记的运行期作业取消返回 false）。 */
function bindCancel(jobId: string, cancel: () => void): void {
  const slot = cancelSlots.get(jobId) ?? { cancel: null, cancelled: false }
  slot.cancel = cancel
  cancelSlots.set(jobId, slot)
}

export function cancelJob(id: string): boolean {
  const slot = cancelSlots.get(id)
  const job = jobs.get(id)
  if (job && job.status === "queued") {
    job.status = "cancelled"
    job.endedAt = new Date().toISOString()
    job.progress = { stage: "已取消（尚未开始）" }
    return true
  }
  if (!slot || !slot.cancel) return false
  slot.cancelled = true
  try {
    slot.cancel()
  } catch {
    /* 原生库取消失败不阻断状态更新 */
  }
  return true
}

/**
 * 后台执行作业：排队 → 运行 → 收尾（状态/摘要/错误/索引）。异常一律写进 job 不外抛——
 * 调用方（工具）拿到的是作业 ID，失败只能从状态与日志里读。
 */
export function startJob(job: Job, ctx: ToolContext, run: (log: (line: string) => void) => Promise<string>): void {
  const log = (line: string) => jobLog(job, ctx, line)
  const slot: CancelSlot = { cancel: null, cancelled: false }
  cancelSlots.set(job.id, slot)
  void (async () => {
    const release = await acquireSlot(job.kind)
    try {
      if (job.status === "cancelled") {
        log("作业在开始前被取消")
        return
      }
      job.status = "running"
      job.startedAt = new Date().toISOString()
      job.progress = { stage: "启动中" }
      appendIndex(ctx, { id: job.id, kind: job.kind, project: job.project, composition: job.composition, output: job.output, status: "running", startedAt: job.startedAt })
      try {
        const summary = await run(log)
        job.status = "done"
        job.summary = summary
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        if (slot.cancelled || /cancell?ed|aborted/i.test(message)) {
          job.status = "cancelled"
          job.error = message
          log(`作业已取消：${message}`)
        } else {
          job.status = "failed"
          job.error = message
          log(`作业失败：${message}`)
        }
      }
    } finally {
      job.endedAt = new Date().toISOString()
      const finalStage =
        job.status === "done" ? "完成" : job.status === "cancelled" ? "已取消" : job.status === "failed" ? "失败" : "结束"
      job.progress = { ...(job.progress ?? {}), stage: finalStage }
      cancelSlots.delete(job.id)
      appendIndex(ctx, {
        id: job.id,
        kind: job.kind,
        project: job.project,
        composition: job.composition,
        output: job.output,
        status: job.status,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        error: job.error,
        summary: job.summary,
      })
      release()
    }
  })()
}

// —— 调优缓存 ——

export function readTuning(ctx: ToolContext): Tuning {
  try {
    const parsed = JSON.parse(readFileSync(tuningPath(ctx), "utf8")) as Partial<Tuning>
    return { encoderProbe: parsed.encoderProbe, entries: parsed.entries ?? {} }
  } catch {
    return { entries: {} }
  }
}

export function writeTuning(ctx: ToolContext, tuning: Tuning): void {
  mkdirSync(stateDir(ctx), { recursive: true })
  writeFileSync(tuningPath(ctx), JSON.stringify({ encoderProbe: tuning.encoderProbe, entries: tuning.entries }, null, 2))
}

export function pickTuned(tuning: Tuning, key: string): TunedEntry | null {
  return tuning.entries[key] ?? null
}

// —— 帧段与并发上限解析 ——

/** 解析帧段文本：`0-29` → [0,29]；`300-` → [300,null]（到片尾）；`120` → [120,120]（单帧）；非法返回 null。 */
export function parseFrameRange(text: string | undefined): [number, number | null] | null {
  if (typeof text !== "string") return null
  const raw = text.trim()
  if (!raw) return null
  const single = /^(\d+)$/.exec(raw)
  if (single) {
    const frame = Number(single[1])
    return [frame, frame]
  }
  const from = /^(\d+)\s*-\s*$/.exec(raw)
  if (from) return [Number(from[1]), null]
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(raw)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    return start <= end ? [start, end] : null
  }
  return null
}

/** 从 Remotion 的并发拒绝错误里取本机上限（`Maximum for --concurrency is N`）。 */
export function parseConcurrencyLimit(message: string): number | null {
  const m = /Maximum for --concurrency is (\d+)/.exec(message)
  if (!m) return null
  const limit = Number(m[1])
  return limit >= 1 ? limit : null
}

/**
 * bench 默认并发候选：有效核数与其一半（去重、降序）——只测两档，实测预算可控。
 * 调用方显式给了 candidates 就以调用方为准。
 */
export function defaultBenchCandidates(cpuCount: number): number[] {
  const cpu = Math.max(1, Math.floor(Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 1))
  return [...new Set([cpu, Math.max(1, Math.ceil(cpu / 2))])].sort((a, b) => b - a)
}

// —— 渲染执行 ——

interface RenderBaseArgs {
  ctx: ToolContext
  job: Job
  libs: NativeLibs
  profile: RenderProfile
  composition: VideoConfig
  serveUrl: string
  browser: NativeBrowser
  inputProps?: Record<string, unknown>
  /** 入口点（工具层透传，仅用于日志定位；打包由调用方完成）。 */
  entryPoint?: string
  /** 日志出口：外部注入（startJob 注入的 log）优先，缺省直接写作业日志。 */
  log?: (line: string) => void
  /** 原生二进制目录（含 remotion/ffmpeg/ffprobe）；null = 用 Remotion 项目内的 compositor 包。 */
  binariesDirectory?: string | null
}

export interface StillArgs extends RenderBaseArgs {
  frame: number
  output: string
  imageFormat?: string
  jpegQuality?: number
  scale?: number
}

export interface MediaArgs extends RenderBaseArgs {
  output: string
  /** [起, 止]；止为 null 表示到片尾；省略 = 全片。 */
  frameRange?: [number, number | null] | null
  scale?: number
  codec?: string
  videoBitrate?: string | null
  crf?: number | null
  imageFormat?: string
  jpegQuality?: number
  concurrency?: number
  /** x264 编码速度档（ultrafast…placebo；不传用 Remotion 内置默认）。 */
  x264Preset?: string | null
  /** 强制硬件编码档（bench 探针用 required）。 */
  hardwareAcceleration?: HardwareAcceleration
}

export interface BenchArgs extends RenderBaseArgs {
  projectDir: string
  candidates: number[]
  /** [起, 止]；止为 null 表示到片尾。 */
  frameRange: [number, number | null]
  /** 实测临时产物目录；缺省落在库根 state/bench（测完即删）。 */
  benchDir?: string
}

/** 日志出口：外部注入（startJob 注入的 log）优先，缺省直接写作业日志。 */
function logTo(args: RenderBaseArgs): (line: string) => void {
  if (args.log) return args.log
  return (line: string) => jobLog(args.job, args.ctx, line)
}

/** 质量参数：硬件档用 videoBitrate（不支持 crf），软件档用 crf（null = 原生库内置值，不传）。 */
function qualityParams(
  profile: RenderProfile,
  opts: { videoBitrate?: string | null; crf?: number | null; hardwareAcceleration?: HardwareAcceleration },
): Record<string, unknown> {
  const hardware = opts.hardwareAcceleration ?? profile.hardwareAcceleration
  const params: Record<string, unknown> = {}
  if (hardware !== "disable") {
    params.hardwareAcceleration = hardware
    params.videoBitrate = opts.videoBitrate ?? profile.videoBitrate ?? "8M"
    return params
  }
  const crf = opts.crf ?? profile.crf
  if (crf !== null && crf !== undefined) params.crf = crf
  return params
}

interface RenderProgress {
  renderedFrames?: number
  encodedFrames?: number
  progress?: number
  stitchStage?: string
}

/** 进度回调 → job.progress（帧数/百分比/fps/预计剩余）+ 节流日志（默认 30s 一行）。 */
function progressReporter(job: Job, log: (line: string) => void, totalFrames: number, started: number, intervalMs = 30_000) {
  let lastLog = 0
  return (p: RenderProgress): void => {
    const elapsedSec = Math.max((Date.now() - started) / 1000, 0.001)
    const fps = p.renderedFrames ? p.renderedFrames / elapsedSec : undefined
    const remaining = p.renderedFrames !== undefined ? Math.max(0, totalFrames - p.renderedFrames) : undefined
    job.progress = {
      stage: p.stitchStage ?? "渲染中",
      renderedFrames: p.renderedFrames,
      totalFrames,
      percent: p.progress !== undefined ? Math.round(p.progress * 100) : undefined,
      fps,
      etaSec: fps && fps > 0 && remaining !== undefined ? remaining / fps : undefined,
    }
    const now = Date.now()
    if (now - lastLog > intervalMs) {
      lastLog = now
      log(describeJob(job))
    }
  }
}

function resolveFrameSpan(args: MediaArgs): [number, number] {
  const total = args.composition.durationInFrames
  const range = args.frameRange
  if (!range) return [0, Math.max(0, total - 1)]
  const start = Math.max(0, range[0])
  const end = range[1] === null || range[1] === undefined ? total - 1 : Math.min(range[1], total - 1)
  if (start > end) throw new Error(`帧段 ${range[0]}-${range[1] ?? "片尾"} 超出合成 ${args.composition.id} 的时长（共 ${total} 帧），请调整 frameRange`)
  return [start, end]
}

/** 静帧：直传原生库（帧号/格式/缩放/热浏览器/chromeMode/chromiumOptions），返回人读摘要。 */
export async function runStill(args: StillArgs): Promise<string> {
  const { job, profile } = args
  const started = Date.now()
  const log = logTo(args)
  const { cancelSignal, cancel } = args.libs.makeCancelSignal()
  bindCancel(job.id, cancel)
  job.progress = { stage: "渲染静帧", renderedFrames: 0, totalFrames: 1 }
  log(
    `静帧渲染：合成 ${args.composition.id} · 帧 ${args.frame} · ${args.imageFormat ?? "png"} · Chrome ${profile.chromeMode}${profile.gl ? ` gl=${profile.gl}` : ""} · 输出 ${args.output}`,
  )
  await args.libs
    .renderStill({
      composition: args.composition,
      serveUrl: args.serveUrl,
      output: args.output,
      frame: args.frame,
      imageFormat: args.imageFormat ?? "png",
      // 质量参数只在 jpeg 帧图下合法（png 传它会被原生库直接拒绝）
      ...((args.imageFormat ?? "png") === "jpeg" && args.jpegQuality !== undefined ? { jpegQuality: args.jpegQuality } : {}),
      scale: args.scale,
      inputProps: args.inputProps,
      puppeteerInstance: args.browser,
      chromeMode: profile.chromeMode,
      chromiumOptions: chromiumOf(profile),
      binariesDirectory: args.binariesDirectory ?? null,
      logLevel: "error",
      overwrite: true,
      cancelSignal,
    })
  job.output = args.output
  job.progress = { stage: "完成", renderedFrames: 1, totalFrames: 1, percent: 100 }
  const ms = Date.now() - started
  log(`静帧完成：${ms}ms`)
  return `静帧已渲染：${args.output}（合成 ${args.composition.id} 帧 ${args.frame}，${(ms / 1000).toFixed(1)}s）`
}

/** 预览/成片：帧段/缩放/编码/码率或 crf/并发/硬件档/props；含「并发超上限自愈重试一次」。 */
export async function runMediaRender(args: MediaArgs): Promise<string> {
  const { job, profile } = args
  const log = logTo(args)
  const codec = args.codec ?? "h264"
  const hardwareAcceleration = args.hardwareAcceleration ?? profile.hardwareAcceleration
  const [start, end] = resolveFrameSpan(args)
  const totalFrames = end - start + 1
  const { cancelSignal, cancel } = args.libs.makeCancelSignal()
  bindCancel(job.id, cancel)
  job.output = args.output
  job.progress = { stage: "渲染中", renderedFrames: 0, totalFrames, percent: 0 }
  const started = Date.now()
  const mediaFormat = args.imageFormat ?? "jpeg"
  const render = async (concurrency: number): Promise<void> => {
    const params: Record<string, unknown> = {
      composition: args.composition,
      serveUrl: args.serveUrl,
      codec,
      outputLocation: args.output,
      inputProps: args.inputProps,
      concurrency,
      frameRange: [start, end],
      imageFormat: mediaFormat,
      ...(mediaFormat === "jpeg" ? { jpegQuality: args.jpegQuality ?? 80 } : {}),
      scale: args.scale,
      puppeteerInstance: args.browser,
      chromeMode: profile.chromeMode,
      chromiumOptions: chromiumOf(profile),
      binariesDirectory: args.binariesDirectory ?? null,
      logLevel: "error",
      overwrite: true,
      cancelSignal,
      ...(args.x264Preset ? { x264Preset: args.x264Preset } : {}),
      onProgress: progressReporter(job, log, totalFrames, started),
      ...qualityParams(profile, { videoBitrate: args.videoBitrate, crf: args.crf, hardwareAcceleration }),
    }
    await args.libs.renderMedia(params).catch(async (err: unknown) => {
      // 自愈：并发超过本机上限时 Remotion 直接拒绝——按报错里的上限重试一次
      const limit = parseConcurrencyLimit((err as Error)?.message ?? "")
      if (limit === null || limit >= concurrency) {
        cancel()
        throw err
      }
      log(`并发 ${concurrency} 超本机上限（${limit}），按上限重试一次`)
      job.progress = { stage: "渲染中（并发已按上限调整）", renderedFrames: 0, totalFrames, percent: 0 }
      params.concurrency = limit
      await args.libs.renderMedia(params)
    })
  }
  const first = args.concurrency ?? profile.concurrency
  log(
    `视频渲染：合成 ${args.composition.id} · 帧段 ${start}-${end}（${totalFrames} 帧）· 编码 ${codec}${args.x264Preset ? `（preset ${args.x264Preset}）` : ""} · 并发 ${first} · 硬件编码 ${hardwareAcceleration} · Chrome ${profile.chromeMode}${profile.gl ? ` gl=${profile.gl}` : ""} · 输出 ${args.output}`,
  )
  await render(first)
  const ms = Date.now() - started
  const fps = totalFrames / Math.max(ms / 1000, 0.001)
  job.progress = { ...(job.progress ?? { stage: "完成" }), stage: "完成", percent: 100, renderedFrames: totalFrames, totalFrames, fps }
  log(`渲染完成：${totalFrames} 帧 / ${(ms / 1000).toFixed(1)}s（${fps.toFixed(1)} fps）`)
  const encoding = hardwareAcceleration === "disable" ? "软件编码" : `硬件编码 ${hardwareAcceleration}`
  return `已渲染 ${totalFrames} 帧 → ${args.output}（${(ms / 1000).toFixed(1)}s，${fps.toFixed(1)} fps；${codec} · ${encoding}）`
}

/** 硬件编码强制探针：以 hardwareAcceleration=required 渲染 2 帧——成功即本机原生编码器确实可用。 */
async function probeEncoder(args: BenchArgs, benchDir: string): Promise<EncoderProbe> {
  const checkedAt = new Date().toISOString()
  const output = join(benchDir, "encoder-probe.mp4")
  const { cancelSignal, cancel } = args.libs.makeCancelSignal()
  bindCancel(args.job.id, cancel)
  try {
    await args.libs.renderMedia({
      composition: args.composition,
      serveUrl: args.serveUrl,
      codec: "h264",
      outputLocation: output,
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
      binariesDirectory: args.binariesDirectory ?? null,
      logLevel: "error",
      overwrite: true,
      cancelSignal,
      onProgress: () => {},
    })
    return { hardware: true, checkedAt }
  } catch (err) {
    return { hardware: false, checkedAt, error: ((err as Error)?.message ?? String(err)).slice(0, 400) }
  } finally {
    rmSync(output, { force: true })
  }
}

/** 实测调优：硬件编码强制探针（required）+ 并发候选实测，结论写入调优缓存（键 = profileKey）。 */
export async function runBench(args: BenchArgs): Promise<string> {
  const { job, profile } = args
  const log = logTo(args)
  const benchDir = args.benchDir ?? join(stateDir(args.ctx), "bench")
  mkdirSync(benchDir, { recursive: true })
  const lines: string[] = []
  const candidates = args.candidates.length ? args.candidates : defaultBenchCandidates(effectiveCpuCount())

  const encoderProbe = await probeEncoder(args, benchDir)
  const tuning = readTuning(args.ctx)
  tuning.encoderProbe = encoderProbe
  writeTuning(args.ctx, tuning)
  const probeLine = encoderProbe.hardware
    ? "硬件编码探针：通过（hardwareAcceleration=required 渲染成功，本机编码器可用）"
    : `硬件编码探针：未通过（${encoderProbe.error ?? "未知原因"}）——本机按软件编码运行`
  lines.push(probeLine)
  log(probeLine)

  const benchRange: [number, number] = [
    args.frameRange[0],
    args.frameRange[1] ?? Math.max(args.frameRange[0], args.composition.durationInFrames - 1),
  ]
  const totalFrames = benchRange[1] - benchRange[0] + 1
  const measured: Array<{ concurrency: number; fps: number; seconds: number }> = []
  for (const concurrency of candidates) {
    const output = join(benchDir, `bench-${concurrency}.mp4`)
    job.progress = { stage: `实测并发 ${concurrency}`, renderedFrames: 0, totalFrames, percent: 0 }
    const started = Date.now()
    try {
      await runMediaRender({
        ctx: args.ctx,
        job,
        libs: args.libs,
        profile: args.profile,
        composition: args.composition,
        serveUrl: args.serveUrl,
        browser: args.browser,
        inputProps: args.inputProps,
        output,
        frameRange: benchRange,
        concurrency,
        imageFormat: "jpeg",
        jpegQuality: 80,
      })
      const seconds = Math.max((Date.now() - started) / 1000, 0.001)
      const fps = totalFrames / seconds
      measured.push({ concurrency, fps, seconds })
      log(`并发 ${concurrency}：${seconds.toFixed(1)}s（${fps.toFixed(1)} fps）`)
    } catch (err) {
      log(`并发 ${concurrency} 实测失败：${(err as Error)?.message ?? String(err)}`)
    } finally {
      rmSync(output, { force: true })
    }
  }
  if (!measured.length) throw new Error("并发实测全部失败，未写入调优缓存：请先确认项目可正常渲染（reel_render action=still）")
  measured.sort((a, b) => b.fps - a.fps)
  const best = measured[0]!
  const entry: TunedEntry = {
    concurrency: best.concurrency,
    gl: profile.gl,
    chromeMode: profile.chromeMode,
    // 探针未通过则如实记软件档，不以推测冒充"已启用 GPU"
    hardwareAcceleration: encoderProbe.hardware ? profile.hardwareAcceleration : "disable",
    fps: best.fps,
    measuredAt: new Date().toISOString(),
  }
  const key = profileKey(args.projectDir, args.composition.id)
  const file = readTuning(args.ctx)
  file.encoderProbe = encoderProbe
  file.entries[key] = entry
  writeTuning(args.ctx, file)

  lines.push(`并发实测：${measured.map((m) => `${m.concurrency}（${m.fps.toFixed(1)} fps）`).join("；")}`)
  lines.push(`已写入调优缓存 ${key}：并发 ${best.concurrency} · 硬件档 ${entry.hardwareAcceleration}（后续同项目同合成自动采用）`)
  lines.push(`缓存文件：${tuningPath(args.ctx)}（按库根隔离——换 REEL_LIBRARY_DIR 即另一份缓存，不跨库根共享）`)
  log(lines[lines.length - 1]!)
  return lines.join("\n")
}
