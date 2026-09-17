/**
 * reel_setup：开工就绪（每次任务第一件事）——报告共享运行时状态、探测本机渲染能力、给出本机最优渲染档
 * 与下一步动作。默认**只做静态探测**（快）：运行时依赖的安装发生在首次 `reel_project init`
 * （会自动准备）；需要提前准备时传 `install=true`。
 */
import type { Tool, ToolResult } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import { ensureRuntime, readRuntimeLock } from "./library"
import { collectProbe } from "./detect"
import { browserReadiness, expectedChromeVersion, resolveBinariesDirectory, resolveBrowserExecutable, BROWSER_EXECUTABLE_ENV } from "./external"
import { decideProfile, describeProfile } from "./profile"
import { chromeCacheDir, dirStats, detectEntryPoint } from "./runtime"
import { readTuning } from "./jobs"
import { libraryRoot, resolveProjectDir, runtimeDir, stateDir } from "./paths"
import { TEMPLATE_SIGNATURE } from "./template.generated"

export const setupTool: Tool = {
  name: "setup",
  description:
    "开工就绪（每次任务第一件事）：报告共享 Remotion 运行时状态、探测本机渲染能力（GPU/编码器/Chrome/并发），返回本机最优渲染档与下一步动作；传入 project 时一并检查该视频工程的入口点与依赖。幂等：已就绪秒回。默认不安装依赖（首次 reel_project init 会自动准备）。",
  parameters: schema(
    {
      project: { type: "string", description: "可选：视频工程目录（检查入口点与依赖联接状态）" },
      install: { type: "boolean", description: "true 时立即准备共享运行时依赖（首次使用或依赖损坏时；通常不必——project init 会自动做）" },
    },
    [],
  ),
  outputSchema: {
    type: "object",
    properties: {
      libraryRoot: { type: "string" },
      runtimeReady: { type: "boolean" },
      remotionVersion: { type: "string" },
      runtimeSource: { type: "string" },
      profile: { type: "object" },
      chromeCacheDir: { type: "string" },
      browser: { type: "object" },
      actions: { type: "array", items: { type: "string" } },
    },
  },
  requiresApproval: true,
  async execute(args, ctx): Promise<ToolResult> {
    const actions: string[] = []
    if (args.install === true) {
      const ensured = await ensureRuntime(ctx)
      actions.push(...ensured.actions)
      if (!ensured.ok) return { output: `共享运行时准备失败：${ensured.error ?? "未知原因"}\n\n${actions.join("\n")}` }
    }

    let projectDir: string | null = null
    try {
      projectDir = args.project ? resolveProjectDir(ctx, String(args.project)) : null
    } catch (err) {
      actions.push(`工程目录解析失败（忽略）：${(err as Error).message}`)
    }

    const probe = await collectProbe(ctx, { projectDir })
    const tuning = readTuning(ctx)
    const profile = decideProfile(
      probe.input,
      { gpu: process.env.REEL_GPU === "off" ? "off" : undefined },
      null,
    )
    const runtimeLock = readRuntimeLock(ctx)
    const chrome = chromeCacheDir()
    const chromeStats = chrome.exists ? dirStats(chrome.dir) : { bytes: 0, files: 0 }
    const state = dirStats(stateDir(ctx))
    // 外部件（浏览器可执行文件 / 原生二进制目录）：配置有误时不抛错，报出问题与修复动作（本工具是诊断入口）
    const externalNotes: string[] = []
    let browserExec: string | null = null
    let binariesDir: string | null = null
    try {
      browserExec = resolveBrowserExecutable({ ctx, projectDir }).path
    } catch (err) {
      externalNotes.push((err as Error).message)
    }
    try {
      binariesDir = resolveBinariesDirectory({ ctx, projectDir }).path
    } catch (err) {
      externalNotes.push((err as Error).message)
    }
    const browser = browserReadiness({
      mode: profile.chromeMode,
      browserExecutable: browserExec,
      expectedVersion: expectedChromeVersion(runtimeDir(ctx)),
    })

    const lines: string[] = []
    lines.push(`库根：${libraryRoot(ctx)}（runtime/ 共享运行时 · state/ 调优与作业）`)
    lines.push(`模板签名：${TEMPLATE_SIGNATURE}`)
    if (!projectDir) lines.push("工程：未指定（未传 project：不检查入口点/依赖，也不读工程内的 Remotion 版本）")
    if (runtimeLock?.status === "ready") {
      const src = runtimeLock.source === "shared" ? `复用既有安装（${runtimeLock.linkedFrom ?? "?"}）` : "内置模板安装"
      lines.push(`共享运行时：已就绪（运行时 Remotion ${runtimeLock.remotionVersion ?? "?"} · ${runtimeLock.packageManager ?? "?"} · ${src}）`)
    } else if (runtimeLock?.status === "failed") {
      lines.push(`共享运行时：上次安装失败 —— ${runtimeLock.error ?? "未知错误"}`)
      lines.push(`  → 修复：reel_project action=install（或 reel_setup install=true 重试）`)
    } else {
      lines.push(`共享运行时：未安装（${runtimeDir(ctx)}）—— 首次 reel_project init 会自动准备（也可传 install=true 立即准备）`)
    }
    lines.push(`运行状态：${state.files} 个文件（实测调优与渲染作业日志）`)
    lines.push("")
    lines.push("本机渲染档：")
    for (const line of describeProfile(profile, probe.input)) lines.push(`  ${line}`)
    const encoder = tuning.encoderProbe
    if (encoder) {
      lines.push(`  编码器实测：${encoder.hardware ? "通过（硬件编码可用）" : `未通过（${encoder.error ?? "原因未记录"}）`} · ${encoder.checkedAt}`)
    } else {
      lines.push("  编码器实测：尚无记录（reel_render action=bench 可实测并发与硬件编码探针）")
    }
    lines.push(`  实测调优缓存：${Object.keys(tuning.entries).length} 条`)
    lines.push(`  浏览器（${browser.mode}）：${browser.ready ? "就绪" : "未就绪"} —— ${browser.note}`)
    if (!browser.ready && !browserExec) lines.push(`    → 修复：配置浏览器可执行文件（reel_render 的 chrome_executable 参数 / ${BROWSER_EXECUTABLE_ENV} / .reel.json 的 browserExecutable）`)
    lines.push(
      binariesDir
        ? `  原生二进制目录：${binariesDir}（替换内置 compositor/ffmpeg）`
        : "  原生二进制目录：未配置（用项目内 @remotion/compositor-* 的 compositor 与 ffmpeg）",
    )
    for (const note of externalNotes) lines.push(`  ⚠ ${note}`)
    if (probe.notes.length) lines.push(`探测说明：${probe.notes.join("；")}`)

    if (projectDir) {
      lines.push("")
      const entry = (() => {
        try {
          return detectEntryPoint(projectDir)
        } catch (err) {
          return `（入口点探测失败：${(err as Error).message}）`
        }
      })()
      const linked = (() => {
        try {
          const st = require("node:fs").lstatSync(require("node:path").join(projectDir, "node_modules"))
          return st.isSymbolicLink() ? "目录联接（复用共享运行时）" : "独立安装"
        } catch {
          return "未接入（先执行 reel_project action=init）"
        }
      })()
      lines.push(`工程：${projectDir}`)
      lines.push(`  入口点：${entry}`)
      lines.push(`  依赖：${linked}`)
    }
    lines.push("")
    lines.push("下一步：")
    lines.push("  1) 建工程：reel_project action=init path=<工程目录>（落位模板 + 复用共享依赖，自带可渲染示例片）")
    lines.push("  2) 逐镜自检：reel_render action=still frame=<帧号>；看节奏：action=preview；出成片：action=video")
    lines.push("  3) 产品视频的制作流程与九条纪律见本子Agent系统提示词（模式判断 → 阶段 0–7 → 终检）")
    if (actions.length) {
      lines.push("")
      lines.push("本次动作：")
      for (const a of actions) lines.push(`  - ${a}`)
    }

    return {
      output: lines.join("\n"),
      data: {
        libraryRoot: libraryRoot(ctx),
        runtimeReady: runtimeLock?.status === "ready",
        remotionVersion: runtimeLock?.remotionVersion ?? "",
        runtimeSource: runtimeLock?.source ?? "",
        profile,
        chromeCacheDir: chrome.dir,
        chromeCacheBytes: chromeStats.bytes,
        browser,
        actions,
      },
    }
  },
}
