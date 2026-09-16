/**
 * reel_render：渲染与实测调优（进程内直连 @remotion/renderer，不经 CLI）。
 * - still 静帧（逐镜 QA 主力，秒级）/ preview 低清预览段 / video 成片（可帧段、可 props 变体）
 * - bench 实测并发与硬件编码探针（结论写入调优缓存，后续渲染自动采用）
 * - status / log / stop 查询与中止
 * 长任务一律后台作业：工具调用立即返回作业 ID，用 status 轮询，不必干等。
 */
import { join } from "node:path"
import type { Tool, ToolResult } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import { collectProbe, effectiveCpuCount } from "./detect"
import { browserReadiness, expectedChromeVersion, resolveBinariesDirectory, resolveBrowserExecutable, BROWSER_EXECUTABLE_ENV, BINARIES_DIR_ENV, type BrowserReadiness } from "./external"
import {
  cancelJob,
  createJob,
  defaultBenchCandidates,
  describeJob,
  getJob,
  listJobs,
  parseFrameRange,
  pickTuned,
  readJobLog,
  readTuning,
  runBench,
  runMediaRender,
  runStill,
  startJob,
} from "./jobs"
import { decideProfile, describeProfile, profileKey, type ProfileOverride, type RenderProfile } from "./profile"
import { detectEntryPoint, listCompositions, loadNativeLibs, prepareBundle, resolveComposition } from "./runtime"
import { isRuntimeReady, resolveOutputPath, resolveProjectDir, runtimeDir } from "./paths"

/** 解析 props 参数：对象直传、JSON 文本、或指向 JSON 文件的路径。 */
async function parseProps(raw: unknown): Promise<Record<string, unknown>> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === "object") return raw as Record<string, unknown>
  const text = String(raw).trim()
  if (!text) return {}
  if (text.startsWith("{")) {
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch (err) {
      throw new Error(`props 不是合法 JSON：${(err as Error).message}`)
    }
  }
  const file = Bun.file(text)
  if (!(await file.exists())) throw new Error(`props 文件不存在：${text}`)
  try {
    return JSON.parse(await file.text()) as Record<string, unknown>
  } catch (err) {
    throw new Error(`props 文件不是合法 JSON（${text}）：${(err as Error).message}`)
  }
}

/** 从参数收集渲染档覆盖（未给的项不覆盖自动决策）。 */
function overrideFrom(args: Record<string, unknown>): ProfileOverride {
  const override: ProfileOverride = {}
  if (typeof args.concurrency === "number") override.concurrency = args.concurrency
  if (args.gl !== undefined) override.gl = args.gl === "off" || args.gl === "none" ? null : String(args.gl)
  if (args.chrome_mode !== undefined) override.chromeMode = String(args.chrome_mode)
  if (args.hardware_acceleration !== undefined) override.hardwareAcceleration = String(args.hardware_acceleration) as RenderProfile["hardwareAcceleration"]
  if (args.video_bitrate !== undefined) override.videoBitrate = args.video_bitrate === "" ? null : String(args.video_bitrate)
  if (args.crf !== undefined) override.crf = typeof args.crf === "number" ? args.crf : null
  if (process.env.REEL_GPU === "off") override.gpu = "off"
  return override
}

/**
 * 浏览器来源行：渲染前把"用哪来的浏览器、会不会触发下载"讲清楚——
 * 未就绪时打警示（内网环境下这一步即是失败根因，不必等崩了再查）。
 */
function browserLine(state: BrowserReadiness): string {
  return `浏览器：${state.ready ? "" : "⚠ "}${state.note}`
}

export const renderTool: Tool = {
  name: "render",
  description:
    "渲染与实测调优（进程内直连 @remotion/renderer，非 CLI；热打包 + 热浏览器复用）：still 静帧（逐镜 QA）/ preview 低清预览段 / video 成片（可帧段与 props 变体）/ bench 实测并发与硬件编码探针（写调优缓存）/ status 进度 / log 日志 / stop 中止。长任务后台执行，立即返回作业 ID。",
  parameters: schema(
    {
      action: { type: "string", enum: ["still", "preview", "video", "bench", "status", "log", "stop"], description: "渲染动作或作业管理" },
      project: { type: "string", description: "视频工程目录（缺省用 REEL_PROJECT）" },
      composition: { type: "string", description: "合成 ID（缺省取工程内第一个合成）" },
      frame: { type: "number", description: "still：渲染哪一帧（默认 0；-1 = 末帧）" },
      frame_range: { type: "string", description: "preview/video/bench：帧段 `起始-结束`（含端点；`0-` 表示到片尾）" },
      scale: { type: "number", description: "缩放（preview 默认 0.5；video 默认 1）" },
      codec: { type: "string", description: "视频编码：h264（默认）/ h265 / vp9 / prores" },
      video_bitrate: { type: "string", description: "视频码率（硬件编码下必用其控质量，默认 8M；与 crf 互斥）" },
      crf: { type: "number", description: "软件编码质量因子（不传则用 Remotion 内置值）" },
      image_format: { type: "string", description: "帧图格式：still 默认 png；video 默认 jpeg（更快）" },
      jpeg_quality: { type: "number", description: "jpeg 质量 0-100（默认 82）" },
      props: { type: "string", description: "输入属性：JSON 文本或 JSON 文件路径（如 {\"bgm\":false} 渲无音乐版）" },
      out: { type: "string", description: "输出路径（默认 <工程>/out/<合成>-<类型>.<扩展名>；相对路径以工程目录为基准，绝对路径直通）" },
      chrome_executable: { type: "string", description: `浏览器可执行文件（Chrome/Chromium 路径；缺省用 ${BROWSER_EXECUTABLE_ENV}、.reel.json 的 browserExecutable，都没有则交给 Remotion 缓存/下载）` },
      binaries_directory: { type: "string", description: `原生二进制目录（含 remotion/ffmpeg/ffprobe，用于换内置 ffmpeg；缺省用 ${BINARIES_DIR_ENV}、.reel.json 的 binariesDirectory）` },
      concurrency: { type: "number", description: "并发数（默认按 CPU 与实测调优决策）" },
      gl: { type: "string", description: "Chromium 光栅化后端（auto 默认 / off 不指定 / angle / vulkan / egl / swangle）" },
      chrome_mode: { type: "string", description: "Chrome 形态（headless-shell 默认 / chrome-for-testing）" },
      hardware_acceleration: { type: "string", description: "硬件编码（disable / if-possible / required；auto 默认由档位决策）" },
      candidates: { type: "string", description: "bench：并发候选（逗号分隔；默认 [有效核数, 其一半]）" },
      job: { type: "string", description: "status/log/stop：作业 ID（status 省略则列出全部）" },
      tail: { type: "number", description: "log：返回日志尾部行数（默认 60）" },
    },
    ["action"],
  ),
  outputSchema: {
    type: "object",
    properties: {
      jobId: { type: "string" },
      kind: { type: "string" },
      output: { type: "string" },
      composition: { type: "string" },
      profile: { type: "object" },
      jobs: { type: "array", items: { type: "object" } },
    },
  },
  requiresApproval: true,
  async execute(args, ctx): Promise<ToolResult> {
    const action = String(args.action ?? "")

    /* ── 作业管理（无工程依赖） ── */
    if (action === "status") {
      const id = args.job ? String(args.job) : ""
      if (!id) {
        const jobs = listJobs(ctx, 12)
        if (!jobs.length) return { output: "本进程内没有渲染作业记录。可用：still / preview / video / bench。" }
        return {
          output: ["最近渲染作业（新→旧）：", ...jobs.map((j) => `  ${describeJob(j)}`)].join("\n"),
          data: { jobs },
        }
      }
      const job = getJob(id)
      if (!job) return { output: `未找到作业：${id}` }
      const logTail = readJobLog(ctx, id, 12)
      return {
        output: [describeJob(job), job.output ? `输出：${job.output}` : "", logTail ? `日志尾部：\n${logTail}` : ""].filter(Boolean).join("\n"),
        data: { jobId: id, kind: job.kind },
      }
    }
    if (action === "log") {
      const id = args.job ? String(args.job) : listJobs(ctx, 1)[0]?.id
      if (!id) return { output: "没有可查看的作业（先发起 still / preview / video / bench）" }
      const tail = typeof args.tail === "number" ? Math.max(1, Math.min(400, args.tail)) : 60
      const text = readJobLog(ctx, id, tail)
      return { output: text || `作业 ${id} 暂无日志`, data: { jobId: id } }
    }
    if (action === "stop") {
      const id = args.job ? String(args.job) : ""
      if (!id) {
        const running = listJobs(ctx, 20).find((j) => j.status === "running" || j.status === "queued")
        if (!running) return { output: "没有正在运行的作业" }
        const okRunning = cancelJob(running.id)
        return { output: okRunning ? `已中止作业 ${running.id}` : `作业 ${running.id} 无法中止（可能已结束）` }
      }
      const ok = cancelJob(id)
      return { output: ok ? `已中止作业 ${id}` : `作业 ${id} 未在运行（或已结束）` }
    }

    if (!["still", "preview", "video", "bench"].includes(action)) {
      return { output: `未知动作：${action}（可用：still / preview / video / bench / status / log / stop）` }
    }

    /* ── 渲染类动作：解析工程与档位 → 登记作业 → 后台执行 ── */
    const projectDir = resolveProjectDir(ctx, args.project ? String(args.project) : undefined)
    // 外部件先解析（配置了但路径不可用时立即报错，不把问题留到渲染中途）
    const browserExec = resolveBrowserExecutable({ ctx, projectDir, arg: args.chrome_executable })
    const binaries = resolveBinariesDirectory({ ctx, projectDir, arg: args.binaries_directory })
    if (!isRuntimeReady(ctx)) {
      return { output: `共享运行时依赖未就绪（${ctx.home}/vendor/reel/runtime）——先执行 reel_project action=install，或用 reel_project action=init 一并准备。` }
    }
    const entryPoint = (() => {
      try {
        return detectEntryPoint(projectDir)
      } catch (err) {
        throw new Error(`入口点探测失败：${(err as Error).message}（先 reel_project action=init）`)
      }
    })()

    let libs
    try {
      libs = await loadNativeLibs(projectDir)
    } catch (err) {
      return { output: `原生渲染库加载失败：${(err as Error).message}\n\n→ 修复：reel_project action=install（重建依赖）` }
    }

    const probe = await collectProbe(ctx, { projectDir })
    const tuning = readTuning(ctx)
    const inputProps = await parseProps(args.props)
    const override = overrideFrom(args as Record<string, unknown>)

    // 合成解析需要 serveUrl（热打包 + 热浏览器）：先按基础档准备，再定档
    const baseProfile = decideProfile(probe.input, override, null)
    const browserState = browserReadiness({
      mode: baseProfile.chromeMode,
      browserExecutable: browserExec.path,
      expectedVersion: expectedChromeVersion(runtimeDir(ctx)),
    })
    const prepared = await prepareBundle({
      ctx,
      libs,
      projectDir,
      entryPoint,
      profile: baseProfile,
      browserExecutable: browserExec.path,
      onLog: () => {},
    }).catch((err: unknown) => {
      throw new Error(`打包/浏览器准备失败：${(err as Error).message}`)
    })

    let compositionId = args.composition ? String(args.composition) : ""
    if (!compositionId) {
      const comps = await listCompositions({ libs, serveUrl: prepared.serveUrl, profile: baseProfile, browser: prepared.browser })
      if (!comps.length) throw new Error("工程内没有注册任何合成（Composition）——检查 src/Root.tsx")
      compositionId = comps[0].id
    }
    const tuned = pickTuned(tuning, profileKey(projectDir, compositionId))
    const profile = decideProfile(probe.input, override, tuned)
    const composition = await resolveComposition({
      libs,
      serveUrl: prepared.serveUrl,
      compositionId,
      inputProps,
      profile,
      browser: prepared.browser,
    })

    if (action === "bench") {
      const parsed = String(args.candidates ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
      // 默认候选（有效核数与其一半）：不显式指定也要有档可测，否则实测等于空跑
      const candidates = parsed.length ? parsed : defaultBenchCandidates(effectiveCpuCount())
      const range = parseFrameRange(args.frame_range ? String(args.frame_range) : undefined) ?? [0, Math.min(11, composition.durationInFrames - 1)]
      const job = createJob({ ctx, kind: "bench", project: projectDir, composition: compositionId })
      startJob(job, ctx, (log) =>
        runBench({
          ctx, libs, serveUrl: prepared.serveUrl, projectDir, entryPoint, profile: baseProfile, composition, inputProps,
          frameRange: [range[0], range[1] ?? null], candidates, browser: prepared.browser, job, log,
          binariesDirectory: binaries.path,
        }),
      )
      return {
        output: [
          `已启动实测调优作业：${job.id}（帧段 ${range[0]}-${range[1] ?? "片尾"} · 并发候选 ${candidates.join(", ")}）`,
          browserLine(browserState),
          `说明：bench 先用 hardware_acceleration=required 做硬件编码强制探针（实测本机原生编码器是否可用），再逐候选实测吞吐；最优档写入缓存供后续渲染自动采用。`,
          `查询进度：reel_render action=status job=${job.id}｜日志：action=log job=${job.id}`,
        ].join("\n"),
        data: { jobId: job.id, kind: "bench", composition: compositionId, profile },
      }
    }

    if (action === "still") {
      const frameArg = typeof args.frame === "number" ? args.frame : 0
      const frame = frameArg < 0 ? Math.max(0, composition.durationInFrames + frameArg) : frameArg
      const out = resolveOutputPath(projectDir, args.out, join("out", `${compositionId}-frame${frame}.png`))
      // png 帧图下不能携带质量参数（原生库会直接拒绝）
      const stillFormat = args.image_format ? String(args.image_format) : "png"
      const stillQuality = typeof args.jpeg_quality === "number" ? args.jpeg_quality : 82
      const job = createJob({ ctx, kind: "still", project: projectDir, composition: compositionId, output: out })
      startJob(job, ctx, (log) =>
        runStill({
          ctx, libs, serveUrl: prepared.serveUrl, composition, output: out, frame,
          imageFormat: stillFormat,
          ...(stillFormat === "jpeg" ? { jpegQuality: stillQuality } : {}),
          scale: typeof args.scale === "number" ? args.scale : 1,
          profile, browser: prepared.browser, inputProps, job, log,
          binariesDirectory: binaries.path,
        }),
      )
      return {
        output: [
          `已启动静帧渲染作业：${job.id}`,
          `输出：${out}`,
          `计划档位：${describeProfile(profile, probe.input)[0]} · 合成 ${compositionId}（${composition.width}×${composition.height} · ${composition.fps}fps）`,
          browserLine(browserState),
          `查询进度：reel_render action=status job=${job.id}｜日志：action=log job=${job.id}`,
        ].join("\n"),
        data: { jobId: job.id, kind: "still", output: out, composition: compositionId, profile },
      }
    }

    // preview / video
    const isVideo = action === "video"
    const range = parseFrameRange(args.frame_range ? String(args.frame_range) : undefined)
    const out = resolveOutputPath(projectDir, args.out, join("out", `${compositionId}-${isVideo ? "reel" : "preview"}.mp4`))
    const job = createJob({ ctx, kind: isVideo ? "video" : "preview", project: projectDir, composition: compositionId, output: out })
    startJob(job, ctx, (log) =>
      runMediaRender({
        ctx, libs, serveUrl: prepared.serveUrl, composition, output: out,
        frameRange: range, scale: typeof args.scale === "number" ? args.scale : isVideo ? 1 : 0.5,
        codec: args.codec ? String(args.codec) : "h264",
        videoBitrate: isVideo && args.video_bitrate ? String(args.video_bitrate) : profile.videoBitrate,
        crf: typeof args.crf === "number" ? args.crf : profile.crf,
        imageFormat: args.image_format ? String(args.image_format) : "jpeg",
        jpegQuality: typeof args.jpeg_quality === "number" ? args.jpeg_quality : 82,
        profile, browser: prepared.browser, inputProps, job, log,
        binariesDirectory: binaries.path,
      }),
    )
    return {
      output: [
        `已启动${isVideo ? "成片" : "预览"}渲染作业：${job.id}`,
        `输出：${out}`,
        `计划档位：${describeProfile(profile, probe.input).join(" · ")}`,
        `合成 ${compositionId}：${composition.width}×${composition.height} · ${composition.fps}fps · ${composition.durationInFrames} 帧${range ? ` · 帧段 ${range[0]}-${range[1] ?? "片尾"}` : " · 全片"}`,
        browserLine(browserState),
        `查询进度：reel_render action=status job=${job.id}｜日志：action=log job=${job.id}`,
      ].join("\n"),
      data: { jobId: job.id, kind: isVideo ? "video" : "preview", output: out, composition: compositionId, profile },
    }
  },
}
