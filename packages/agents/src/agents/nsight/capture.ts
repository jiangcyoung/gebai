/**
 * nsight 采集工具：驱动 nsys / ncu 对被分析程序做性能采集，产出报告供分析层使用。
 *
 * - 需审批（会执行任意被分析程序，属宿主进程执行面）；
 * - 采集完成即尝试导入并给出「分析已就绪」的下一步提示（避免「采集完不知道下一步」）；
 * - 失败分类诊断：计数器权限（ERR_NVGPUCTRPERM）、注入失败（平台/权限/目标进程早退）、
 *   trace 项非法、路径不存在——每类给出确切的修复动作，不做无信息量的重试。
 */
import type { Tool, ToolResult } from "@gebai/sdk"
import { statReport, importNsys, importNcu } from "./report"
import { missingToolchainNote, resolveNsightEnv, probeCounterPermission, buildCommand } from "./env"
import { schema } from "./tools"
import { withTiming } from "../../core/perf/timing"
import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

/** 采集默认超时（毫秒）：被分析程序可能要跑一段时间，但不至于无限挂起。 */
const DEFAULT_CAPTURE_TIMEOUT_MS = 8 * 60_000

/** nsys 支持的 trace 项（用于参数校验，避免 Illegal --trace argument 这类往返）。 */
const NSYS_TRACES = ["cuda", "cuda-hw", "nvtx", "cublas", "cublas-verbose", "cusolver", "cusolver-verbose", "cusparse", "cusparse-verbose", "nvvideo", "opengl", "opengl-annotations", "vulkan", "vulkan-annotations", "dx11", "dx11-annotations", "dx12", "dx12-annotations", "openxr", "openxr-annotations", "wddm", "none"]

export const captureTool: Tool = {
  name: "capture",
  description:
    "采集性能报告（需审批）：kind=nsys 用 Nsight Systems 采集时间线（CUDA/NVTX 等 trace，无需管理员权限）；kind=ncu 用 Nsight Compute 采集单内核硬件计数器（需 GPU 性能计数器权限，受限时工具会给出开启方法）。采集完成后自动尝试导入并提示下一步分析。",
  parameters: schema(
    {
      kind: { type: "string", enum: ["nsys", "ncu"], description: "采集器（默认 nsys）" },
      command: { type: "string", description: "被分析程序的完整命令行（含参数；相对路径以当前工作目录为基准）" },
      output: { type: "string", description: "报告输出路径（不含扩展名或含扩展名皆可；默认写入当前工作目录）" },
      trace: { type: "string", description: "nsys trace 项（逗号分隔，默认 cuda,nvtx；可选 nvtx/cuda/cuda-hw/cublas/opengl/dx12 等）" },
      graph_trace: {
        type: "string",
        enum: ["graph", "node"],
        description:
          "nsys 图跟踪级别：不传=nsys 默认（仅记录图启动，看不到图内节点）；node=记录图内节点（分析 CUDA Graph 内阶段**必须**用它，否则内核统计只反映图外/prefill）。若目标程序用图（有 cudaGraphLaunch）且要分析解码/稳态阶段，请显式传 node。",
      },
      set: { type: "string", description: "ncu 指标集（默认 full；也可用 basic/detailed 或 --section 组合）" },
      kernel: { type: "string", description: "ncu 内核筛选（正则，如 regex:myKernel）" },
      launch_count: { type: "number", description: "ncu 采集的内核次数上限（默认 1，避免长程序采集耗时过大）" },
      import_source: { type: "boolean", description: "ncu 是否导入源码关联（需要 --source-folders；开启后报告中带源码行）" },
      source_folders: { type: "string", description: "ncu 源码搜索目录（逗号分隔；配合 import_source 使用）" },
      timeout: { type: "number", description: "采集超时秒数（默认 480）" },
    },
    ["command"],
  ),
  outputSchema: schema({
    report: { type: "string", description: "生成的报告路径" },
    ready: { type: "boolean", description: "报告是否已导入，可直接分析" },
    analysisMs: { type: "number" },
  }),
  requiresApproval: true,
  async execute(args, ctx): Promise<ToolResult> {
    const kind = String(args.kind ?? "nsys") === "ncu" ? "ncu" : "nsys"
    const env = await resolveNsightEnv(ctx)
    const missing = missingToolchainNote(env, kind)
    if (missing) return { output: missing, data: {} }
    const target = String(args.command ?? "").trim()
    if (!target) return { output: "需要 command 参数（被分析程序的完整命令行）。", data: {} }

    // 输出路径：相对路径以工作目录为基准（不依赖进程 cwd）
    const rawOut = args.output ? String(args.output) : `nsight-${kind}-${Date.now()}`
    const outBase = isAbsolute(rawOut) ? rawOut : resolve(ctx.resolvePath("."), rawOut)
    const outPath = outBase.replace(/\.(nsys-rep|ncu-rep)$/i, "")
    const timeoutMs = Math.max(10_000, Number(args.timeout ?? DEFAULT_CAPTURE_TIMEOUT_MS / 1000) * 1000)

    const cmd =
      kind === "nsys"
        ? buildCommand(env.nsys!.path, [
            "profile",
            "-o",
            outPath,
            "--force-overwrite",
            "true",
            "--trace",
            validateTrace(String(args.trace ?? "cuda,nvtx")),
            ...(args.graph_trace && ["graph", "node"].includes(String(args.graph_trace))
              ? ["--cuda-graph-trace", String(args.graph_trace)]
              : []),
            ...(process.platform === "win32" ? ["--cuda-event-trace", "false"] : []),
            target,
          ])
        : buildCommand(env.ncu!.path, [
            "--target-processes",
            "all",
            "--set",
            String(args.set ?? "full"),
            "--launch-count",
            String(Math.max(1, Math.min(1000, Number(args.launch_count ?? 1)))),
            ...(args.kernel ? ["--kernel-name", String(args.kernel)] : []),
            ...(args.import_source === true ? ["--import-source", "on"] : []),
            ...(args.source_folders ? ["--source-folders", String(args.source_folders)] : []),
            "-o",
            outPath,
            "--force-overwrite",
            "true",
            target,
          ])

    // ncu 采集前先探权限：无权时立即给出修复动作，不消耗采集时间
    if (kind === "ncu") {
      const perm = await probeCounterPermission(ctx, env.ncu!.path)
      if (perm.state === "denied") {
        return {
          output: [
            "ncu 采集不可用：GPU 性能计数器访问被拒绝（ERR_NVGPUCTRPERM）。",
            perm.detail,
            "",
            "可选路径：",
            "  1) 以管理员权限运行歌白后重试（Windows：以管理员身份启动；Linux：sudo 或为 ncu 配置 capabilities）；",
            "  2) 或在 NVIDIA 控制面板开启「开发者 → 管理 GPU 性能计数器 → 允许访问 GPU 性能计数器（所有用户）」；",
            "  3) 若已有他人采集的 .ncu-rep，可直接用 nsight_kernel_detail 分析（无需本机权限）。",
            "此时仍可用 nsys 采集时间线（不需要性能计数器权限）。",
          ].join("\n"),
          data: { blocked: "counter-permission" },
        }
      }
    }

    const t = withTiming()
    const r = await ctx.runCommand(cmd, { timeoutMs })
    const captureMs = t()
    const produced = findReport(outPath, kind)
    const lines: string[] = []
    lines.push(`采集命令：${cmd}`)
    lines.push(`耗时 ${(captureMs / 1000).toFixed(1)}s，退出码 ${r.code}`)
    if (!produced) {
      lines.push("")
      lines.push("未生成报告——按错误信息定位：")
      const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-12).join("\n")
      if (tail) lines.push(tail)
      lines.push("")
      lines.push(...diagnoseFailure(`${r.stdout}\n${r.stderr}`, kind))
      return { output: lines.join("\n"), data: { report: undefined, ready: false } }
    }

    lines.push(`报告：${produced}`)
    const imported = await (kind === "nsys" ? importNsys(ctx, env, await statReport(ctx, produced)) : importNcu(ctx, env, await statReport(ctx, produced), ["details", "raw", "source"]))
    lines.push(imported.note)
    if (imported.pending) lines.push(`（导入未完成，报告体积较大；可在后台执行：${imported.command ?? "见 note"}）`)
    lines.push("")
    lines.push(
      kind === "nsys"
        ? "下一步：nsight_findings（问题清单，含根因与修复方向）→ nsight_timeline（空闲缝与串行化细节）→ nsight_locate（落到源码 文件:行）。"
        : "下一步：nsight_kernel_detail（SOL/占用率/停顿分解/官方规则）→ nsight_locate（把内核符号落到源码）。",
    )
    return { output: lines.join("\n"), data: { report: produced, ready: !imported.pending, analysisMs: captureMs } }
  },
}

/** trace 项校验：非法项立即报错并给出合法清单（nsys 会直接拒绝并打印可选值，提前拦下省一次往返）。 */
function validateTrace(input: string): string {
  const items = input.split(",").map((s) => s.trim()).filter(Boolean)
  const bad = items.filter((i) => !NSYS_TRACES.includes(i))
  if (bad.length) {
    throw new Error(`nsys trace 项非法：${bad.join("、")}（可选：${NSYS_TRACES.join("、")}）`)
  }
  return items.join(",")
}

/** 采集产物探测（nsys 可能补 .nsys-rep 后缀，ncu 可能补 .ncu-rep）。 */
function findReport(outBase: string, kind: "nsys" | "ncu"): string | undefined {
  const ext = kind === "nsys" ? ".nsys-rep" : ".ncu-rep"
  const candidates = [outBase + ext, outBase, `${outBase}.qdstrm`]
  return candidates.find((p) => existsSync(p))
}

/** 采集失败分类：把常见失败模式映射到确切修复动作。 */
function diagnoseFailure(output: string, kind: "nsys" | "ncu"): string[] {
  const out: string[] = []
  if (/ERR_NVGPUCTRPERM/.test(output)) {
    out.push("· 性能计数器权限不足：以管理员权限运行，或在 NVIDIA 控制面板开启「允许访问 GPU 性能计数器」。")
  }
  if (/Illegal --trace|Possible --trace values/.test(output)) {
    out.push(`· trace 项非法：改用合法项（${NSYS_TRACES.slice(0, 8).join("、")}…）。`)
  }
  if (/cannot find|No such file|not found|系统找不到/.test(output)) {
    out.push("· 目标程序路径不存在：确认 command 参数（含参数）与工作目录，相对路径以当前工作目录为基准。")
  }
  if (/permission denied|Access is denied|拒绝访问/.test(output)) {
    out.push("· 权限被拒：目标程序可能需更高完整性级别，或杀毒/EDR 拦截了注入——以管理员权限运行或为该进程加白。")
  }
  if (/injection|failed to|attach/i.test(output)) {
    out.push("· 注入/附加失败：目标进程可能过早退出（把被测工作放到程序后段）、被反作弊/沙箱阻拦，或平台不支持（ncu 在 Windows 上对部分进程模型受限）。")
  }
  if (!out.length) out.push("· 未见已知错误模式：请核对上面 stderr 原文；可先用 nsys（无需计数器权限）确认工具链可用。")
  if (kind === "nsys") out.push("· 提示：nsys 采集需要 CUDA 注入（Windows 上无需管理员权限即可追踪 CUDA），若目标程序未使用 CUDA，时间线上将没有 GPU 活动。")
  return out
}
