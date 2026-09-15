/**
 * shotcraft_render：原生渲染库渲染入口（进程内直连 `@remotion/renderer`，热 bundle + 热浏览器复用）。
 * - still / preview：逐镜头 QA 与低清预览（帧段 + 缩放），秒级发起，免审批；
 * - video：成片渲染（可带帧段、码率、CRF、props 变体——例如同一时间线渲"带 BGM / 无 BGM"两版）；
 * - bench：实测调优（硬件编码强制探针 + 并发候选实测，结论写缓存并自动用于后续渲染）；
 * - status / log / stop / jobs：后台作业管理（进度、日志、cancelSignal 中止）。
 * 长时渲染全部后台执行——工具调用立即返回作业 ID，不占用任务等待，也不受工具超时限制。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { Tool, ToolContext, ToolResult } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import { jobsDir, resolveProjectDir } from "./paths"
import { collectProbe } from "./detect"
import { decideProfile, describeProfile, type GlOption, type HardwareAcceleration, type RenderProfile } from "./profile"
import {
  cancelJob,
  createJob,
  describeJob,
  getJob,
  listJobs,
  pickTuningEntry,
  readJobLog,
  readTuning,
  runBench,
  runMediaRender,
  runStill,
  startJob,
  type JobKind,
} from "./jobs"
import { detectEntryPoint, listCompositions, loadNativeLibs, resolveComposition, type NativeBrowser, type NativeLibs, type VideoConfig } from "./runtime"
import { prepareRender } from "./jobs"
import { resolveSkillDir } from "./library"

/** 帧段解析：`a-b`（含端点）/ `a-`（到片尾）；非法返回 null。 */
export function parseFrameRange(input: string): [number, number | null] | null {
  const m = /^(\d+)\s*-\s*(\d*)$/.exec(input.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === "" ? null : Number(m[2])
  if (end !== null && end < start) return null
  return [start, end]
}

/** props 解析：JSON 文本或 JSON 文件路径。 */
export function parsePropsInput(value: unknown, projectDir: string): Record<string, unknown> {
  if (value === undefined || value === null || value === "") return {}
  if (typeof value === "object") return value as Record<string, unknown>
  const text = String(value).trim()
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch (err) {
      throw new Error(`props JSON 解析失败：${(err as Error).message}`)
    }
  }
  const abs = isAbsolute(text) ? text : resolve(projectDir, text)
  if (!existsSync(abs)) throw new Error(`props 文件不存在：${abs}`)
  return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>
}

function outPath(projectDir: string, value: unknown, fallback: string): string {
  if (!value) return join(projectDir, "out", fallback)
  const text = String(value)
  return isAbsolute(text) ? text : resolve(projectDir, text)
}

function overridesOf(args: Record<string, unknown>) {
  const glRaw = args.gl === undefined ? undefined : String(args.gl)
  const gl = glRaw === undefined ? undefined : (glRaw === "auto" || glRaw === "off" ? (glRaw as "auto" | "off") : (glRaw as GlOption))
  const chromeRaw = args.chrome_mode === undefined ? undefined : String(args.chrome_mode)
  const chromeMode = chromeRaw === undefined ? undefined : (chromeRaw === "auto" ? ("auto" as const) : (chromeRaw as "headless-shell" | "chrome-for-testing"))
  const hwRaw = args.hardware_acceleration === undefined ? undefined : String(args.hardware_acceleration)
  const hardwareAcceleration = hwRaw === undefined ? undefined : (hwRaw as "auto" | HardwareAcceleration)
  return {
    concurrency: typeof args.concurrency === "number" ? args.concurrency : undefined,
    gl,
    chromeMode,
    hardwareAcceleration,
  }
}

interface Prepared {
  libs: NativeLibs
  profile: RenderProfile
  serveUrl: string
  composition: VideoConfig
  browser: NativeBrowser
  bundleCached: boolean
}

/** 渲染前置（在作业内执行）：探测 → 档位 → 原生库 → 打包/浏览器 → 合成解析（含实测调优套用）。 */
async function prepareAndResolve(opts: {
  ctx: ToolContext
  args: Record<string, unknown>
  projectDir: string
  log: (line: string) => void
}): Promise<Prepared> {
  const { ctx, args, projectDir, log } = opts
  const entryPoint = detectEntryPoint(projectDir)
  if (!entryPoint) throw new Error(`项目 ${projectDir} 未找到 Remotion 入口点（含 registerRoot 的文件）；先用 project action=init 建工程或确认 src/index.ts 存在`)
  const probe = await collectProbe(ctx, { projectDir })
  const overrides = overridesOf(args)
  const base = decideProfile({ ...probe.input, overrides })
  log(`打包/浏览器前置：${describeProfile(base).split("\n")[0]}`)
  const libs = await loadNativeLibs(projectDir)
  log(`原生渲染库：${libs.rendererDir}（Remotion ${libs.version ?? "?"}）`)
  let prepared = await prepareRender({
    ctx,
    libs,
    projectDir,
    entryPoint,
    profile: base,
    onLog: log,
    onBundleProgress: (percent) => {
      if (percent % 25 === 0) log(`打包进度 ${percent}%`)
    },
    onDownloadProgress: (percent) => log(`Chrome 下载 ${Math.round(percent * 100)}%`),
  })
  log(prepared.bundleCached ? `复用已打包产物（${prepared.bundleMs}ms）` : `打包完成（${prepared.bundleMs}ms）`)

  let compositionId = args.composition ? String(args.composition) : ""
  if (!compositionId) {
    const comps = await listCompositions({ libs, serveUrl: prepared.serveUrl, profile: base, browser: prepared.browser })
    if (!comps.length) throw new Error("项目内没有注册任何合成（Composition）")
    compositionId = comps[0].id
    log(`未指定合成，取第一个：${comps.map((c) => c.id).join(", ")}`)
  }

  const tuning = pickTuningEntry(ctx, base, projectDir, compositionId)
  const profile = decideProfile({ ...probe.input, overrides, tuning })
  let browser = prepared.browser
  if (profile.chromeMode !== base.chromeMode || (profile.gl ?? "") !== (base.gl ?? "")) {
    const again = await prepareRender({
      ctx,
      libs,
      projectDir,
      entryPoint,
      profile,
      onLog: log,
      onDownloadProgress: (percent) => log(`Chrome 下载 ${Math.round(percent * 100)}%`),
    })
    browser = again.browser
    prepared = { ...prepared, browser, bundleCached: again.bundleCached }
  }
  const inputProps = parsePropsInput(args.props, projectDir)
  const composition = await resolveComposition({
    libs,
    serveUrl: prepared.serveUrl,
    compositionId,
    inputProps,
    profile,
    browser,
  })
  log(`合成：${composition.id} · ${composition.width}×${composition.height} · ${composition.fps}fps · ${composition.durationInFrames} 帧`)
  return { libs, profile, serveUrl: prepared.serveUrl, composition, browser, bundleCached: prepared.bundleCached }
}

/** 各渲染动作的收尾摘要（含实际生效的性能档，便于复核）。 */
function profileTail(profile: RenderProfile): string {
  return `档位：并发 ${profile.concurrency} · 编码 ${profile.hardwareAcceleration === "disable" ? "软件" : `硬件（${profile.hardwareEncoder ?? "?"}，${profile.hardwareAcceleration}）`} · Chrome ${profile.chromeMode}${profile.gl ? ` · gl=${profile.gl}` : ""}`
}

export const renderTool: Tool = {
  name: "render",
  description:
    "原生渲染库渲染与实测调优（进程内直连 @remotion/renderer，非 CLI；热 bundle + 热浏览器复用，首次会下载 Chrome）：still 静帧（逐镜头 QA）/ preview 低清预览段 / video 成片（可 props 变体渲多版、可帧段）/ bench 实测并发与硬件编码探针（写调优缓存）/ status 进度 / log 日志 / stop 中止。长时渲染后台执行，立即返回作业 ID。",
  parameters: schema(
    {
      action: { type: "string", enum: ["still", "preview", "video", "bench", "status", "log", "stop"], description: "渲染或作业管理动作" },
      project: { type: "string", description: "视频项目目录（默认 SHOTCRAFT_PROJECT 或会话工作目录）" },
      composition: { type: "string", description: "合成 ID（省略则取项目内第一个）" },
      frame: { type: "number", description: "still：渲染哪一帧（默认 0；-1 = 最后一帧）" },
      frame_range: { type: "string", description: "preview/video/bench：帧段 `起始-结束`（含端点；`0-` 表示到片尾）" },
      out: { type: "string", description: "输出路径（默认 <项目>/out/<合成>-<类型>.<扩展名>）" },
      props: { type: "string", description: "输入属性：JSON 文本或 JSON 文件路径（如 {\"bgm\":false} 渲无 BGM 版）" },
      scale: { type: "number", description: "缩放（preview 默认 0.5；video 默认 1）" },
      codec: { type: "string", description: "视频编码：h264（默认）/ h265 / vp9 / prores" },
      video_bitrate: { type: "string", description: "视频码率（硬件编码下必用其控质量，默认 8M；与 crf 互斥）" },
      crf: { type: "number", description: "软件编码质量因子（默认 Remotion 内置值；硬件编码不可用）" },
      image_format: { type: "string", description: "帧图格式：still 默认 png；video 默认 jpeg（更快）" },
      jpeg_quality: { type: "number", description: "jpeg 质量 0-100（默认 80）" },
      concurrency: { type: "number", description: "并发数（默认按 CPU 核数，或被 bench 实测调优覆盖）" },
      gl: { type: "string", description: "Chrome 光栅化后端（auto 默认 / off 用默认后端 / angle / angle-egl / vulkan / egl / swangle）" },
      chrome_mode: { type: "string", description: "Chrome 形态（auto 默认 / headless-shell / chrome-for-testing）" },
      hardware_acceleration: { type: "string", description: "硬件编码（auto 默认 / if-possible / required / disable）" },
      candidates: { type: "string", description: "bench：并发候选（逗号分隔，默认 [核数, 核数/2]）" },
      job: { type: "string", description: "status/log/stop：作业 ID（status 省略则列出全部作业）" },
      tail: { type: "number", description: "log：返回日志尾部行数（默认 60）" },
    },
    ["action"],
  ),
  outputSchema: {
    type: "object",
    properties: {
      jobId: { type: "string" },
      status: { type: "string" },
      output: { type: "string" },
      profile: { type: "object" },
    },
  },
  requiresApproval: (args) => {
    const action = String(args.action ?? "")
    if (action === "status" || action === "log" || action === "stop") return false
    return !(action === "still" || action === "preview")
  },
  async execute(args, ctx): Promise<ToolResult> {
    const action = String(args.action ?? "status")

    if (action === "status") {
      const jobId = args.job ? String(args.job) : ""
      if (jobId) {
        const job = getJob(jobId)
        if (!job) return { output: `未找到作业 ${jobId}（可用 status 不带 job 列出全部）。` }
        const lines = [describeJob(job)]
        if (job.output) lines.push(`输出：${job.output}`)
        if (job.params) lines.push(`参数：${Object.entries(job.params).map(([k, v]) => `${k}=${String(v)}`).join(" · ")}`)
        if (job.error) lines.push(`错误：${job.error}`)
        if (job.summary) lines.push(`结果：${job.summary}`)
        lines.push("")
        lines.push("日志尾部：")
        lines.push(readJobLog(job, ctx, 12))
        return { output: lines.join("\n"), data: { job } }
      }
      const all = listJobs()
      const tuning = readTuning(ctx)
      const lines: string[] = []
      if (!all.length) lines.push("本进程内没有渲染作业。")
      for (const job of all.slice(0, 10)) lines.push(describeJob(job) + (job.summary ? ` · ${job.summary.split("\n")[0]}` : job.error ? ` · ${job.error}` : ""))
      if (tuning.encoderProbe) lines.push(`硬件编码实测：${tuning.encoderProbe.hardware ? "通过" : `未通过（${tuning.encoderProbe.error ?? "未知"}）`}（${tuning.encoderProbe.checkedAt}）`)
      if (Object.keys(tuning.entries).length) lines.push(`实测调优缓存：${Object.keys(tuning.entries).length} 条`)
      return { output: lines.join("\n"), data: { jobs: all.slice(0, 10), encoderProbe: tuning.encoderProbe ?? null } }
    }

    if (action === "log") {
      const job = getJob(String(args.job ?? ""))
      if (!job) return { output: `未找到作业 ${args.job ?? ""}（status 可列出全部作业）。` }
      const tail = typeof args.tail === "number" ? Math.max(1, Math.min(2000, args.tail)) : 60
      return { output: readJobLog(job, ctx, tail) || "（暂无日志）" }
    }

    if (action === "stop") {
      const id = String(args.job ?? "")
      const job = getJob(id)
      if (!job) return { output: `未找到作业 ${id}。` }
      if (job.status !== "running" && job.status !== "queued") return { output: `作业 ${id} 当前状态为 ${job.status}，无需中止。` }
      const ok = cancelJob(id)
      job.status = "cancelled"
      return { output: ok ? `已请求中止作业 ${id}（cancelSignal 已发出）。` : `作业 ${id} 尚未进入可中止阶段（排队中），已标记取消。`, data: { job } }
    }

    // 渲染类动作
    const projectDir = resolveProjectDir(ctx, args.project ? String(args.project) : undefined)
    if (!existsSync(projectDir)) return { output: `项目目录不存在：${projectDir}（先用 project action=init 建工程）。` }
    if (!resolveSkillDir(ctx)) return { output: "技能库尚未就绪：请先执行 setup。" }
    mkdirSync(jobsDir(ctx), { recursive: true })

    const probe = await collectProbe(ctx, { projectDir })
    const planned = decideProfile({ ...probe.input, overrides: overridesOf(args) })

    if (action === "bench") {
      const rangeText = String(args.frame_range ?? "0-29")
      const range = parseFrameRange(rangeText)
      if (!range) return { output: `bench 需要明确的帧段（如 0-29），收到：${rangeText}` }
      const [rangeStart, rangeEnd] = range
      if (rangeEnd === null) return { output: `bench 需要闭合帧段（如 0-29），收到：${rangeText}` }
      const candidates = String(args.candidates ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
      const fallback = [probe.input.cpuCount, Math.max(1, Math.round(probe.input.cpuCount / 2))]
      const requested = [...new Set(candidates.length ? candidates : fallback)].sort((a, b) => b - a)
      // Remotion 硬限并发 ≤ 本机核数（超限直接报错）：先裁剪再实测，并如实说明被裁掉的候选
      const list = requested.filter((n) => n <= probe.input.cpuCount)
      const dropped = requested.filter((n) => n > probe.input.cpuCount)
      if (!list.length) list.push(probe.input.cpuCount)
      const job = createJob({ ctx, kind: "bench", project: projectDir, composition: String(args.composition ?? "(auto)"), params: { frameRange: rangeText, candidates: list } })
      startJob(ctx, job, async (log) => {
        const prepared = await prepareAndResolve({ ctx, args: { ...args, frame: undefined }, projectDir, log })
        return runBench({
          ctx,
          libs: prepared.libs,
          projectDir,
          entryPoint: detectEntryPoint(projectDir) ?? "",
          serveUrl: prepared.serveUrl,
          composition: prepared.composition,
          profile: prepared.profile,
          browser: prepared.browser,
          inputProps: parsePropsInput(args.props, projectDir),
          job,
          candidates: list,
          frameRange: [rangeStart, rangeEnd],
          benchDir: join(jobsDir(ctx), "bench"),
        })
      })
      return {
        output: [
          `已启动实测调优作业：${job.id}（帧段 ${rangeText} · 并发候选 ${list.join(", ")}${dropped.length ? `；已剔除超本机上限的候选 ${dropped.join(", ")}（本机上限 ${probe.input.cpuCount}）` : ""}）`,
          `计划档位：${describeProfile(planned).split("\n").slice(2).join(" · ")}`,
          "说明：bench 会先用 hardware_acceleration=required 做硬件编码强制探针（实测本机原生编码器是否可用），再逐并发候选实测吞吐，最优并发写入缓存并被后续渲染自动采用。",
          `查询进度：render action=status job=${job.id}`,
        ].join("\n"),
        data: { jobId: job.id, kind: job.kind, plannedProfile: planned },
      }
    }

    const kind: JobKind = action === "still" ? "still" : action === "preview" ? "preview" : "video"
    const isStill = kind === "still"
    const ext = isStill ? (String(args.image_format ?? "png") === "jpeg" ? "jpg" : String(args.image_format ?? "png")) : "mp4"
    const fallbackName = isStill
      ? `${args.composition ?? "composition"}-frame${typeof args.frame === "number" ? args.frame : 0}.${ext}`
      : `${args.composition ?? "composition"}${kind === "preview" ? "-preview" : ""}.${ext}`
    const output = outPath(projectDir, args.out, fallbackName)
    mkdirSync(join(output, ".."), { recursive: true })

    const job = createJob({
      ctx,
      kind,
      project: projectDir,
      composition: String(args.composition ?? "(auto)"),
      output,
      params: {
        ...(isStill ? { frame: typeof args.frame === "number" ? args.frame : 0 } : {}),
        ...(args.frame_range ? { frameRange: String(args.frame_range) } : {}),
        ...(args.scale !== undefined ? { scale: String(args.scale) } : {}),
        codec: String(args.codec ?? "h264"),
        concurrency: planned.concurrency,
        chromeMode: planned.chromeMode,
        gl: planned.gl ?? "default",
        hardwareAcceleration: planned.hardwareAcceleration,
      },
    })

    startJob(ctx, job, async (log) => {
      const prepared = await prepareAndResolve({ ctx, args, projectDir, log })
      const inputProps = parsePropsInput(args.props, projectDir)
      if (isStill) {
        const frame = typeof args.frame === "number" ? args.frame : 0
        return runStill({
          ctx,
          libs: prepared.libs,
          projectDir,
          entryPoint: detectEntryPoint(projectDir) ?? "",
          serveUrl: prepared.serveUrl,
          composition: prepared.composition,
          profile: prepared.profile,
          browser: prepared.browser,
          inputProps,
          job,
          frame,
          output,
          imageFormat: String(args.image_format ?? "png"),
          jpegQuality: typeof args.jpeg_quality === "number" ? args.jpeg_quality : undefined,
          scale: typeof args.scale === "number" ? args.scale : undefined,
        })
      }
      const rangeText = args.frame_range ? String(args.frame_range) : ""
      let frameRange: [number, number] | undefined
      if (rangeText) {
        const parsed = parseFrameRange(rangeText)
        if (!parsed || parsed[1] === null) throw new Error(`帧段格式应为 起始-结束（如 0-59），收到：${rangeText}`)
        frameRange = [parsed[0], parsed[1]]
      }
      const scale = typeof args.scale === "number" ? args.scale : kind === "preview" ? 0.5 : undefined
      const summary = await runMediaRender({
        ctx,
        libs: prepared.libs,
        projectDir,
        entryPoint: detectEntryPoint(projectDir) ?? "",
        serveUrl: prepared.serveUrl,
        composition: prepared.composition,
        profile: prepared.profile,
        browser: prepared.browser,
        inputProps,
        job,
        output,
        options: {
          frameRange,
          scale,
          codec: args.codec ? String(args.codec) : undefined,
          videoBitrate: args.video_bitrate ? String(args.video_bitrate) : null,
          crf: typeof args.crf === "number" ? args.crf : null,
          imageFormat: args.image_format ? String(args.image_format) : undefined,
          jpegQuality: typeof args.jpeg_quality === "number" ? args.jpeg_quality : undefined,
        },
      })
      return `${summary}\n${profileTail(prepared.profile)}`
    })

    return {
      output: [
        `已启动${kind === "video" ? "成片" : kind === "preview" ? "预览" : "静帧"}渲染作业：${job.id}`,
        `输出：${output}`,
        `计划档位：${profileTail(planned)}`,
        `合成：${args.composition ?? "（自动取第一个）"}${args.frame_range ? ` · 帧段 ${args.frame_range}` : ""}`,
        "说明：打包与浏览器复用；首次渲染需下载 Chrome（约 150MB，同实例各项目共用一份），进度见日志。",
        `查询进度：render action=status job=${job.id}｜查看日志：render action=log job=${job.id}`,
      ].join("\n"),
      data: { jobId: job.id, kind, output, plannedProfile: planned },
    }
  },
}
