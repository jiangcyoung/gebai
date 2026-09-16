/**
 * 路径与环境：库根（共享 Remotion 运行时 + 运行状态）与视频工程目录解析。
 *
 * 创作能力（设计 token、镜头原语、2.5D 相机、模板工程）内置在包内，落位时展开成真实文件，
 * **不依赖任何外部库载荷**；库根只承载"较重的、与项目无关的"东西：预装 Remotion 运行时
 * （各项目目录联接复用，依赖整机只装一次）与本机运行状态（实测调优、渲染作业）。
 */
import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"

/** 内置模板锁定的 Remotion 版本（原生渲染库与 compositor 二进制随项目依赖提供）。 */
export const TEMPLATE_REMOTION_VERSION = "4.0.484"

/** 共享运行时依赖是否就绪的判定路径（相对 runtime 目录）。 */
export const RUNTIME_READY_MARKER = join("node_modules", "remotion", "package.json")

/** 库根：`REEL_LIBRARY_DIR`（绝对路径或相对会话工作目录）> `{GEBAI_HOME}/vendor/reel`。 */
export function libraryRoot(ctx: ToolContext): string {
  const custom = envGet(ctx, "REEL_LIBRARY_DIR")
  if (custom) return isAbsolute(custom) ? custom : resolve(ctx.workdir, custom)
  return join(ctx.home ?? homedir(), "vendor", "reel")
}

/** 共享 Remotion 运行时（预装模板工程 + node_modules；各视频项目目录联接复用）。 */
export function runtimeDir(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "runtime")
}

/** 本机运行状态根（实测调优缓存与渲染作业日志）。 */
export function stateDir(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "state")
}
export function tuningPath(ctx: ToolContext): string {
  return join(stateDir(ctx), "tuning.json")
}
export function jobsDir(ctx: ToolContext): string {
  return join(stateDir(ctx), "jobs")
}
export function jobLogPath(ctx: ToolContext, id: string): string {
  return join(jobsDir(ctx), `${id}.log`)
}
export function jobIndexPath(ctx: ToolContext): string {
  return join(jobsDir(ctx), "index.jsonl")
}
/** 持久化打包产物（按内容签名复用，跨进程免重打包）。 */
export function bundleCacheDir(ctx: ToolContext, signature: string): string {
  return join(stateDir(ctx), "bundles", signature)
}

/** 运行时就绪判定：node_modules 内有 remotion 本体即视为可用（版本细节由 readRuntimeVersion 读）。 */
export function isRuntimeReady(ctx: ToolContext): boolean {
  return existsSync(join(runtimeDir(ctx), RUNTIME_READY_MARKER))
}

/** 读取共享运行时的 Remotion 版本（未安装返回 null）。 */
export function readRuntimeVersion(ctx: ToolContext): string | null {
  try {
    const raw = Bun.file(join(runtimeDir(ctx), RUNTIME_READY_MARKER))
    void raw
  } catch {
    return null
  }
  try {
    const text = require("node:fs").readFileSync(join(runtimeDir(ctx), RUNTIME_READY_MARKER), "utf8") as string
    return (JSON.parse(text) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/** 环境变量读取：ctx.env（会话级）优先，其次进程环境。 */
export function envGet(ctx: ToolContext, key: string): string | undefined {
  const fromCtx = ctx.env?.[key]
  if (typeof fromCtx === "string" && fromCtx.trim()) return fromCtx.trim()
  const fromProc = process.env[key]
  return typeof fromProc === "string" && fromProc.trim() ? fromProc.trim() : undefined
}

/**
 * 视频工程目录解析：`REEL_PROJECT` 环境变量为默认根；参数为绝对路径直用、相对路径以会话工作目录为基准。
 * 沙箱模式下限定在用户数据目录与会话工作目录内。
 */
export function resolveProjectDir(ctx: ToolContext, arg?: string): string {
  const base = arg && arg.trim() ? arg.trim() : envGet(ctx, "REEL_PROJECT")
  if (!base) throw new Error("未指定视频工程目录：传 project 参数，或设置 REEL_PROJECT 环境变量")
  const abs = isAbsolute(base) ? base : resolve(ctx.workdir, base)
  if (ctx.sandboxed) {
    const roots = [ctx.workdir, ctx.home].filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => resolve(v))
    const inside = roots.some((root) => {
      const rel = relative(root, abs)
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
    })
    if (!inside) throw new Error(`路径沙箱：视频工程目录须位于会话工作目录或用户数据目录内（${abs}）`)
  }
  return abs
}

/**
 * 渲染输出路径解析：绝对路径直通，相对路径一律以**视频工程目录**为基准——与默认落点 `<工程>/out/` 同一坐标系。
 * 相对路径若按服务进程 cwd 解析，`out/qa/x.png` 会落到与工程无关的目录，读作「产物失踪」。
 */
export function resolveOutputPath(projectDir: string, out: unknown, defaultRelative: string): string {
  const raw = typeof out === "string" ? out.trim() : ""
  if (!raw) return join(projectDir, defaultRelative)
  return isAbsolute(raw) ? raw : resolve(projectDir, raw)
}

/** 路径是否可写目录（不存在也算可用——由调用方创建）。 */
export function isWritableDir(path: string): boolean {
  if (!existsSync(path)) return true
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 真实路径（用于识别目录联接/符号链接的指向；失败时回落到原路径）。 */
export function realPathOf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
