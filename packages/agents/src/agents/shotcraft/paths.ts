/**
 * shotcraft 路径与环境解析：四级布局全部集中在一个可迁移的库根下（默认 `{GEBAI_HOME}/vendor/video-shotcraft`）——
 * `skill/`（上游 video-shotcraft 载荷：配方卡/模板/资产/demo/工作台）、`runtime/`（预装 Remotion 运行时，各视频项目以目录联接复用）、
 * `state/`（调优缓存、渲染作业、持久化 bundle）。Chrome 由 Remotion 自行下载到进程 cwd 的 node_modules/.remotion（同实例共用，见 runtime.ts remotionCacheDir）。
 * 环境变量（ctx.env 优先、进程 env 兜底）：SHOTCRAFT_LIBRARY_DIR / SHOTCRAFT_SOURCE / SHOTCRAFT_PROJECT / SHOTCRAFT_GPU。
 */
import { isAbsolute, join, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { resolveInSandbox } from "@gebai/sdk/node"

export const AGENT_NAME = "shotcraft"
/** 上游技能库仓库（载荷来源与文档引用）。 */
export const UPSTREAM_REPO = "Vincentwei1021/video-shotcraft"
/** 载荷来源（按序尝试，前一源失败换后一源）：GitHub codeload 主源 + AtomGit 镜像备源。
 *  两者均为上游 main 分支 zip 快照；离线/固定版本用 SHOTCRAFT_SOURCE 指定本地目录或自定义 URL。 */
export const DEFAULT_SOURCES = [
  { kind: "github", url: `https://codeload.github.com/${UPSTREAM_REPO}/zip/refs/heads/main` },
  { kind: "atomgit", url: "https://atomgit.com/VincentWei/video-shotcraft/archive/refs/heads/main.zip" },
]
/** 载荷结构校验必需项（缺失即视为损坏/半包，拒绝登记为就绪）。 */
export const REQUIRED_ENTRIES = [
  "SKILL.md",
  "references/shots",
  "references/pipeline.md",
  "references/aesthetic-rules.md",
  "gallery/api/library.json",
  "template/package.json",
  "template/src/index.ts",
  "demos",
  "assets/lib",
  "assets/audio",
  "assets/scripts",
  "workbench/package.json",
  "jianying-export",
]
/** 载荷内关键位置（工具输出与提示词引用，避免模型猜路径）。 */
export const SKILL_LAYOUT: Array<[string, string]> = [
  ["SKILL.md", "技能库权威入口：模式判断、八条理念、阶段工作流、交付收尾"],
  ["references/pipeline.md", "自主自由创作流水线（阶段 0–7）"],
  ["references/guided-free-creation.md", "共同创作（逐阶段确认）"],
  ["references/shots/", "157 张镜头配方卡（按 camera/data/effects/interaction/opening/outro/rhythm/transition/typography/ui-entrance 分类）"],
  ["gallery/api/library.json", "卡片索引（卡名/style-key/摘要/能量/类别，检索入口）"],
  ["demos/", "各卡参考实现源码（卡片「参考实现」段指向此处）"],
  ["assets/lib/", "可复制进项目的共享组件（PageCam/ClipCard/DigitRoll/FlashCut/Caption/FlatPanel/VerticalTicker/helpers）"],
  ["assets/audio/", "BGM 与 16 类音效（免费商用授权）"],
  ["assets/scripts/", "页面采集脚本与 demo 冒烟脚本"],
  ["template/", "已验收的完整宣传片模板工程（Ink Press 路线）"],
  ["workbench/", "动效工作台（浏览器内改片，可选交付步骤）"],
  ["jianying-export/", "剪映工程导出（可选交付步骤）"],
]

/** 环境变量读取：任务级 ctx.env 优先，进程 env 兜底（空串视为未设置）。 */
export function envGet(ctx: ToolContext, key: string): string | undefined {
  const v = ctx.env?.[key]
  if (v !== undefined && v !== "") return v
  const p = process.env[key]
  return p === undefined || p === "" ? undefined : p
}

/** 库根：SHOTCRAFT_LIBRARY_DIR（绝对路径或相对会话工作目录）> {GEBAI_HOME}/vendor/video-shotcraft。 */
export function libraryRoot(ctx: ToolContext): string {
  const custom = envGet(ctx, "SHOTCRAFT_LIBRARY_DIR")
  if (custom) return isAbsolute(custom) ? custom : resolve(ctx.workdir, custom)
  return join(ctx.home, "vendor", "video-shotcraft")
}

/** 技能库载荷目录（上游仓库内容原样落于此，只读来源——资产先复制进项目再改）。 */
export function skillDir(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "skill")
}
/** 载荷安装锁（来源、时间、归档 sha256、结构校验与上游内容 revision）。 */
export function lockPath(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "skill.lock.json")
}
/** 预装 Remotion 运行时（各项目以目录联接复用其 node_modules，依赖整机只装一次）。 */
export function runtimeDir(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "runtime")
}
/** 运行状态根（调优缓存与渲染作业日志）。 */
export function stateDir(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "state")
}
/** 调优缓存（bench 实测的并发/GL/chrome-mode/硬件编码实测结果）。 */
export function tuningPath(ctx: ToolContext): string {
  return join(stateDir(ctx), "tuning.json")
}
/** 渲染作业目录（每作业一份日志 + 一份历史索引）。 */
export function jobsDir(ctx: ToolContext): string {
  return join(stateDir(ctx), "jobs")
}
export function jobLogPath(ctx: ToolContext, id: string): string {
  return join(jobsDir(ctx), `${id}.log`)
}
export function jobIndexPath(ctx: ToolContext): string {
  return join(jobsDir(ctx), "index.jsonl")
}

/** 视频项目目录解析：绝对路径直用；相对路径以会话工作目录为基准；沙箱模式限定用户数据目录内。 */
export function resolveProjectDir(ctx: ToolContext, p?: string): string {
  const input = (p ?? "").trim()
  if (!input) return defaultProjectDir(ctx)
  if (isAbsolute(input)) return ctx.sandboxed ? resolveInSandbox(join(ctx.home, "users", ctx.user), input) : input
  if (ctx.sandboxed) return resolveInSandbox(join(ctx.home, "users", ctx.user), input)
  return resolve(ctx.workdir, input)
}

/** 默认项目目录：SHOTCRAFT_PROJECT > 会话绑定项目根 > 会话工作目录。 */
export function defaultProjectDir(ctx: ToolContext): string {
  const bound = envGet(ctx, "SHOTCRAFT_PROJECT")
  if (bound) return isAbsolute(bound) ? bound : resolve(ctx.workdir, bound)
  if (ctx.boundProjectRoot) return ctx.boundProjectRoot
  return ctx.workdir
}

/** GPU 策略：off = 强制软件档（不启用硬件编码/GPU 光栅化）；auto（默认）= 探测到可用 GPU 即启用。 */
export function gpuPolicy(ctx: ToolContext): "auto" | "off" {
  const v = envGet(ctx, "SHOTCRAFT_GPU")?.trim().toLowerCase()
  return v === "off" || v === "false" || v === "0" || v === "disable" ? "off" : "auto"
}
