/**
 * shotcraft_setup：一次调用完成"开工就绪"——技能库载荷（下载/镜像/离线源 + 结构校验 + 幂等复用）
 * 与主机/GPU 探测（渲染档决策），返回关键路径清单、本机最优渲染档与下一步动作。
 * 只做静态探测与载荷准备（快，不含依赖安装与浏览器下载——那两项分别在 project install 与首次渲染作业里发生）。
 */
import type { Tool, ToolResult } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import { dirStats, ensureSkill, readRuntimeLock, readSkillLock } from "./library"
import { collectProbe } from "./detect"
import { decideProfile, describeProfile } from "./profile"
import { remotionCacheDir } from "./runtime"
import { readTuning } from "./jobs"
import { SKILL_LAYOUT, UPSTREAM_REPO, libraryRoot, resolveProjectDir, runtimeDir, stateDir } from "./paths"

function bytesText(bytes: number): string {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export const setupTool: Tool = {
  name: "setup",
  description:
    "开工就绪（每次任务第一件事）：获取/校验视频制作技能库（video-shotcraft 载荷：157 张镜头配方卡、已验收模板、共享组件、音效资产、动效工作台）并探测本机渲染能力，返回技能库路径、关键文件位置与本机最优渲染档（GPU 硬件编码档、Chrome 光栅化后端、并发数）。幂等：已就绪则秒回。",
  parameters: schema(
    {
      update: { type: "boolean", description: "强制重新获取技能库载荷（上游有更新时用；默认复用已就绪的本地副本）" },
      project: { type: "string", description: "可选：视频项目目录（用于读取项目内 Remotion 版本与是否含 WebGL/Three 内容，据此细化渲染档）" },
    },
    [],
  ),
  outputSchema: {
    type: "object",
    properties: {
      skillDir: { type: "string" },
      libraryRoot: { type: "string" },
      cards: { type: "number" },
      styles: { type: "number" },
      upstreamRevision: { type: "string" },
      profile: { type: "object" },
      actions: { type: "array", items: { type: "string" } },
    },
  },
  requiresApproval: true,
  async execute(args, ctx): Promise<ToolResult> {
    const actions: string[] = []
    const ensured = await ensureSkill(ctx, { update: args.update === true })
    actions.push(...ensured.actions)
    if (!ensured.ok || !ensured.skillDir) {
      return { output: `${ensured.error ?? "技能库准备失败"}\n\n${actions.join("\n")}` }
    }
    const skill = ensured.skillDir
    const lock = ensured.lock ?? readSkillLock(ctx)

    let projectDir: string | null = null
    try {
      projectDir = args.project ? resolveProjectDir(ctx, String(args.project)) : null
    } catch (err) {
      actions.push(`项目目录解析失败（忽略）：${(err as Error).message}`)
    }

    const probe = await collectProbe(ctx, { projectDir })
    const profile = decideProfile(probe.input)
    const runtimeLock = readRuntimeLock(ctx)
    const chromeCache = remotionCacheDir()
    const bins = chromeCache.exists ? dirStats(chromeCache.dir) : { bytes: 0, files: 0 }
    const state = dirStats(stateDir(ctx))
    const tuningFile = readTuning(ctx)
    const encoder = tuningFile.encoderProbe

    const lines: string[] = []
    lines.push(`技能库：${skill}`)
    lines.push(
      `  来源 ${lock?.source ?? "未知"}${lock?.upstreamRevision ? ` · 内容 revision ${lock.upstreamRevision}` : ""} · ${lock?.cards ?? "?"} 张配方卡 / ${lock?.styles ?? "?"} 条样式 · ${lock?.installedAt ?? ""}`,
    )
    lines.push(`库根：${libraryRoot(ctx)}（skill/ 载荷 · runtime/ 共享运行时 · state/ 调优与作业；Chrome 缓存位置见下）`)
    lines.push(
      `共享运行时：${runtimeLock?.status === "ready" ? `已就绪（Remotion ${runtimeLock.remotionVersion ?? "?"} · ${runtimeLock.packageManager ?? "?"}）` : runtimeLock ? `${runtimeLock.status}（project action=install 可（重）建）` : "未安装（project action=init 会自动安装，各项目以目录联接复用）"}`,
    )
    lines.push(
      `Chrome 缓存：${bins.files ? `已就绪 ${bytesText(bins.bytes)}（${chromeCache.dir}）` : `未下载（首次渲染时由 Remotion 下载到 ${chromeCache.dir}，同实例各项目共用一份）`}`,
    )
    lines.push(`原生 compositor 与 ffmpeg：取自项目内 @remotion/compositor-* 包（随依赖一次安装，无需额外下载）`)
    lines.push(`运行状态：${state.files} 个文件（调优缓存与渲染作业日志）`)
    lines.push("")
    lines.push("本机最优渲染档：")
    lines.push(
      describeProfile(profile)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    )
    lines.push(`  编码器实测：${encoder ? (encoder.hardware ? `通过（硬件编码可用，${encoder.checkedAt}）` : `未通过（${encoder.error ?? "未知"}）`) : "未实测（render action=bench 会做强制探针与并发实测）"}`)
    const tuningCount = Object.keys(tuningFile.entries).length
    lines.push(`  实测调优缓存：${tuningCount ? `${tuningCount} 条（同项目同合成渲染时自动套用）` : "空（未做过 bench）"}`)
    if (probe.notes.length) {
      lines.push("")
      lines.push(`探测说明：${probe.notes.join("；")}`)
    }
    lines.push("")
    lines.push("技能库关键路径：")
    for (const [rel, desc] of SKILL_LAYOUT) lines.push(`  ${skill}/${rel} — ${desc}`)
    lines.push("")
    lines.push("下一步：")
    lines.push("  1) 读 SKILL.md（模式判断与八条理念）与 references/pipeline.md 等对应文档；卡片检索用 grep/js 读 gallery/api/library.json，卡片全文与「参考实现」指向的 demo 源码用 read 直读（路径前缀即上面的技能库路径）")
    lines.push("  2) 无项目时先 project action=init 建工程（自动安装共享运行时并以目录联接复用，免每个项目重复装依赖）")
    lines.push("  3) 渲染走 render 工具的 still/preview/video（进程内直连原生渲染库，热 bundle + 热浏览器复用；首次渲染会下载 Chrome）")
    lines.push("  4) 需要 GPU 实测数据时 render action=bench（并发候选实测 + 硬件编码强制探针，结论自动写缓存并用于后续渲染）")
    if (actions.length) {
      lines.push("")
      lines.push("本次动作：")
      for (const a of actions) lines.push(`  - ${a}`)
    }

    return {
      output: lines.join("\n"),
      data: {
        skillDir: skill,
        libraryRoot: libraryRoot(ctx),
        runtimeDir: runtimeDir(ctx),
        chromeCacheDir: chromeCache.dir,
        cards: lock?.cards,
        styles: lock?.styles,
        upstreamRevision: lock?.upstreamRevision,
        profile,
        encoderProbe: encoder ?? null,
        upstreamRepo: UPSTREAM_REPO,
      },
    }
  },
}
