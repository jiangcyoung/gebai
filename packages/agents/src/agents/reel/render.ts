/**
 * reel_render：渲染与实测调优（进程内直连 @remotion/renderer，不经 CLI）。
 * - still 静帧（逐镜 QA 主力，秒级）/ preview 低清预览段 / video 成片（可帧段、可 props 变体）
 * - bench 实测并发与硬件编码探针（结论写入调优缓存，后续渲染自动采用）
 * - status / log / stop 查询与中止
 * 长任务一律后台作业：工具调用立即返回作业 ID，用 status 轮询，不必干等。
 * 例外是送审主帧：`still wait=true` 同步等这一帧渲完并把帧图直接附在结果里（用户当场可见、模型也可自查）——
 * 一次调用只给一帧，正好对上一次「一节一送」的确认动作。
 */
import { join } from "node:path"
import type { Tool, ToolResult } from "@gebai/sdk"
import { artifactBlocks, mimeFor, previewLogicalPath, schema } from "@gebai/sdk/node"
import { collectProbe, effectiveCpuCount } from "./detect"
import { browserReadiness, expectedChromeVersion, resolveBinariesDirectory, resolveBrowserExecutable, BROWSER_EXECUTABLE_ENV, BINARIES_DIR_ENV, type BrowserReadiness } from "./external"
import { DRAFT, X264_PRESETS, asX264Preset, resolveVideoSize } from "./output"
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
  waitJob,
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

/**
 * 准备阶段兜底时限（bundle + 浏览器启动/下载）。
 *
 * 为什么需要：prepareBundle 内部会拉起浏览器；**本地无缓存时 Remotion 会联网下载**
 * （chrome-headless-shell 约 150MB），在无代理/内网环境下这一步会**无限期挂住**，
 * 而且它发生在 createJob **之前** —— 于是既没有作业记录、也没有进度，外部只看到“工具没反应”。
 * 加一道时限把静默挂死变成可解释的失败。
 */
const PREPARE_TIMEOUT_MS = 6 * 60 * 1000

/** 给不带超时的异步阶段加一道硬时限（超时抛带修复指引的错误）。 */
async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(onTimeout())), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
      height: { type: "number", description: "目标高度（按合成长宽比换算输出尺寸，如 720 / 540）：1080p 合成取 720 得 1280×720。与 scale 二选一（推荐它——自动满足 h264 的偶数尺寸要求）" },
      scale: { type: "number", description: "缩放比例（preview 默认 0.5；video 默认 1）。注意必须是能得出整数且偶数宽高的值：1080p 用 0.667 会得到 1281×720 而被编码器拒绝，请改用 height 或 2/3" },
      quality: { type: "string", description: "preview/video 画质档：final（默认，全质量交付）/ draft（快速草稿：半分辨率 + ultrafast 编码 + 帧图质量 70——只用于确认动效与节奏，不用于交付）" },
      codec: { type: "string", description: "视频编码：h264（默认）/ h265 / vp9 / prores" },
      x264_preset: { type: "string", description: `软件编码速度档：${X264_PRESETS.join(" / ")}（缺省 Remotion 内置 medium）；ultrafast 省约 80% 编码时间、体积约 +1.4 倍（合成画面近无损，实拍素材慎用）` },
      video_bitrate: { type: "string", description: "视频码率（硬件编码下必用其控质量，默认 8M；与 crf 互斥）" },
      crf: { type: "number", description: "软件编码质量因子（不传则用 Remotion 内置值）" },
      image_format: { type: "string", description: "帧图格式：still 默认 png；video 默认 jpeg（更快）" },
      jpeg_quality: { type: "number", description: "jpeg 质量 0-100（默认 82）" },
      props: { type: "string", description: "输入属性：JSON 文本或 JSON 文件路径（如 {\"bgm\":false} 渲无音乐版）" },
      out: { type: "string", description: "输出路径（默认 <工程>/out/<合成>-<类型>.<扩展名>；相对路径以工程目录为基准，绝对路径直通）" },
      wait: { type: "boolean", description: "同步等作业完成并把产物附在结果里（still 附帧图、preview/video 附视频文件；送审用，用户当场可见）；默认 false 保持后台作业语义（长片段建议仍走后台）" },
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
    const prepared = await withDeadline(
      prepareBundle({
        ctx,
        libs,
        projectDir,
        entryPoint,
        profile: baseProfile,
        browserExecutable: browserExec.path,
        onLog: () => {},
      }).catch((err: unknown) => {
        throw new Error(`打包/浏览器准备失败：${(err as Error).message}`)
      }),
      PREPARE_TIMEOUT_MS,
      () =>
        `打包/浏览器准备超时（${PREPARE_TIMEOUT_MS / 60000} 分钟）——最常见原因是浏览器未就绪且无法联网下载：${browserState.note}。` +
        `修复：配置 browser_executable（或 GEBAI_REEL_CHROME_EXECUTABLE / .reel.json 的 browserExecutable）指向本机 Chrome/Chromium，` +
        `或先执行 reel_setup install=true 准备依赖与浏览器。`,
    )

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
      if (args.height !== undefined && args.scale !== undefined) {
        return { output: "height 与 scale 二选一：height=<目标高>（按合成长宽比换算，推荐）或 scale=<比例>" }
      }
      // 帧图无 h264 的偶数尺寸约束，仍接受 height（换算成等价 scale）
      const stillScale = args.height !== undefined ? Number(args.height) / composition.height : typeof args.scale === "number" ? args.scale : 1
      if (!Number.isFinite(stillScale) || stillScale <= 0) {
        return { output: `输出尺寸参数非法：height=${String(args.height)} scale=${String(args.scale)}（都须为正数）` }
      }
      // png 帧图下不能携带质量参数（原生库会直接拒绝）
      const stillFormat = args.image_format ? String(args.image_format) : "png"
      const stillQuality = typeof args.jpeg_quality === "number" ? args.jpeg_quality : 82
      const job = createJob({ ctx, kind: "still", project: projectDir, composition: compositionId, output: out })
      startJob(job, ctx, (log) =>
        runStill({
          ctx, libs, serveUrl: prepared.serveUrl, composition, output: out, frame,
          imageFormat: stillFormat,
          ...(stillFormat === "jpeg" ? { jpegQuality: stillQuality } : {}),
          scale: stillScale,
          profile, browser: prepared.browser, inputProps, job, log,
          binariesDirectory: binaries.path,
        }),
      )
      const startLines = [
        `已启动静帧渲染作业：${job.id}`,
        `输出：${out}`,
        `计划档位：${describeProfile(profile, probe.input)[0]} · 合成 ${compositionId}（${composition.width}×${composition.height} · ${composition.fps}fps）`,
        browserLine(browserState),
      ]
      if (args.wait !== true) {
        return {
          output: [...startLines, `查询进度：reel_render action=status job=${job.id}｜日志：action=log job=${job.id}`].join("\n"),
          data: { jobId: job.id, kind: "still", output: out, composition: compositionId, profile },
        }
      }
      // 送审主帧：等这一帧落地，把图直接附进结果（blocks→UI 用户可见；images→模型多模态内联自查）
      const settled = await waitJob(job.id)
      if (!settled || settled.status !== "done") {
        const status = settled?.status ?? "unknown"
        return {
          output: [
            ...startLines,
            `⚠ 等待渲染未成功（状态 ${status}）：${settled?.error ?? "详见作业日志"}`,
            `排查：reel_render action=log job=${job.id}｜查询：action=status job=${job.id}`,
          ].join("\n"),
          data: { jobId: job.id, kind: "still", output: out, composition: compositionId, status },
        }
      }
      return {
        output: [
          ...startLines,
          `静帧已渲染：${out}（帧 ${frame}）—— 帧图已附在本条结果里，直接交给用户看，再用 ask 送审。`,
        ].join("\n"),
        data: { jobId: job.id, kind: "still", output: out, composition: compositionId, status: "done", frame },
        blocks: artifactBlocks(previewLogicalPath(out, ctx)),
        images: [{ path: out, display: out, mime: mimeFor(out) ?? "image/png" }],
      }
    }

    // preview / video
    const isVideo = action === "video"
    const range = parseFrameRange(args.frame_range ? String(args.frame_range) : undefined)
    if (args.quality !== undefined && args.quality !== "final" && args.quality !== "draft") {
      return { output: `quality 只支持 final / draft（收到 ${String(args.quality)}）——draft 是确认动效与节奏用的快速档，不用于交付` }
    }
    const draft = args.quality === "draft"
    if (args.height !== undefined && args.scale !== undefined) {
      return { output: "height 与 scale 二选一：height=<目标高>（按合成长宽比换算，推荐）或 scale=<比例>" }
    }
    const size = resolveVideoSize({
      width: composition.width,
      height: composition.height,
      scale: typeof args.scale === "number" ? args.scale : draft ? DRAFT.scale : isVideo ? 1 : 0.5,
      targetHeight: typeof args.height === "number" ? args.height : null,
    })
    if ("error" in size) return { output: size.error }
    if (args.x264_preset !== undefined && !asX264Preset(args.x264_preset)) {
      return { output: `x264_preset 非法：${String(args.x264_preset)}（可用：${X264_PRESETS.join(" / ")}）` }
    }
    const x264Preset = asX264Preset(args.x264_preset) ?? (draft ? DRAFT.x264Preset : null)
    const jpegQuality = typeof args.jpeg_quality === "number" ? args.jpeg_quality : draft ? DRAFT.jpegQuality : 82
    const out = resolveOutputPath(projectDir, args.out, join("out", `${compositionId}-${isVideo ? "reel" : "preview"}.mp4`))
    const job = createJob({ ctx, kind: isVideo ? "video" : "preview", project: projectDir, composition: compositionId, output: out })
    startJob(job, ctx, (log) =>
      runMediaRender({
        ctx, libs, serveUrl: prepared.serveUrl, composition, output: out,
        frameRange: range, scale: size.scale,
        codec: args.codec ? String(args.codec) : "h264",
        videoBitrate: isVideo && args.video_bitrate ? String(args.video_bitrate) : profile.videoBitrate,
        crf: typeof args.crf === "number" ? args.crf : profile.crf,
        imageFormat: args.image_format ? String(args.image_format) : "jpeg",
        jpegQuality,
        x264Preset,
        profile, browser: prepared.browser, inputProps, job, log,
        binariesDirectory: binaries.path,
      }),
    )
    const kind = isVideo ? "video" : "preview"
    const startLines = [
      `已启动${isVideo ? "成片" : "预览"}渲染作业：${job.id}`,
      `输出：${out}（${size.width}×${size.height}${draft ? " · 草稿档" : ""}${x264Preset ? ` · preset ${x264Preset}` : ""}）`,
      `计划档位：${describeProfile(profile, probe.input).join(" · ")}`,
      `合成 ${compositionId}：${composition.width}×${composition.height} · ${composition.fps}fps · ${composition.durationInFrames} 帧${range ? ` · 帧段 ${range[0]}-${range[1] ?? "片尾"}` : " · 全片"}`,
      browserLine(browserState),
    ]
    if (args.wait !== true) {
      return {
        output: [...startLines, `查询进度：reel_render action=status job=${job.id}｜日志：action=log job=${job.id}`].join("\n"),
        data: { jobId: job.id, kind, output: out, width: size.width, height: size.height, quality: draft ? "draft" : "final", composition: compositionId, profile },
      }
    }
    // 送审片段：等它渲完，把视频产物附进结果（成片时长不受工具超时约束，故给更长的等待窗口）
    const settled = await waitJob(job.id, isVideo ? 600_000 : 180_000)
    if (!settled || settled.status !== "done") {
      const status = settled?.status ?? "unknown"
      return {
        output: [
          ...startLines,
          `⚠ 等待渲染未成功（状态 ${status}）：${settled?.error ?? "详见作业日志"}`,
          `排查：reel_render action=log job=${job.id}｜查询：action=status job=${job.id}`,
        ].join("\n"),
        data: { jobId: job.id, kind, output: out, status },
      }
    }
    return {
      output: [
        ...startLines,
        `${isVideo ? "成片" : "预览"}已渲染：${out}——产物已附在本条结果里，直接交给用户看，再用 ask 送审。`,
      ].join("\n"),
      data: { jobId: job.id, kind, output: out, width: size.width, height: size.height, quality: draft ? "draft" : "final", status: "done", composition: compositionId },
      blocks: artifactBlocks(previewLogicalPath(out, ctx)),
    }
  },
}
