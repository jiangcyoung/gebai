/**
 * shotcraft_project：视频工程脚手架与运行时。
 * - init：从技能库模板（或最小空白工程）落位项目源码，并把共享运行时的 node_modules 以**目录联接**接入
 *   （Windows junction / POSIX symlink，均免管理员）——依赖整机只装一次，项目初始化近乎瞬时。
 * - install：（重）建共享运行时依赖；isolated=true 时改为在项目内独立安装（需要不同 Remotion 版本时用）。
 * - status：项目/运行时/Chrome 缓存/调优缓存/最近渲染作业一览。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"
import type { Tool, ToolResult } from "@gebai/sdk"
import { schema } from "@gebai/sdk/node"
import {
  copyTemplate,
  dirStats,
  ensureRuntime,
  ensureSkill,
  readInstalledRemotionVersion,
  readRuntimeLock,
  readSkillLock,
  resolveSkillDir,
  templateSignature,
} from "./library"
import { detectEntryPoint, readProjectManifest, remotionCacheDir } from "./runtime"
import { listJobs, readTuning } from "./jobs"
import { libraryRoot, resolveProjectDir, runtimeDir } from "./paths"

/** 把共享运行时的 node_modules 以目录联接接入项目（已存在独立 node_modules 时保留不动）。 */
export function linkNodeModules(projectDir: string, runtimeRoot: string): { linked: boolean; note: string } {
  const source = join(runtimeRoot, "node_modules")
  const target = join(projectDir, "node_modules")
  if (!existsSync(source)) return { linked: false, note: `共享运行时尚未安装依赖（${source} 不存在）` }
  if (existsSync(target) || isSymlink(target)) {
    if (isSymlink(target)) return { linked: true, note: `已联接共享运行时：${safeReadlink(target)}` }
    return { linked: false, note: "项目已有独立 node_modules（保留，未被覆盖）" }
  }
  try {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir")
    return { linked: true, note: `已联接共享运行时 node_modules（${process.platform === "win32" ? "junction" : "symlink"} → ${source}）` }
  } catch (err) {
    return { linked: false, note: `目录联接失败（${(err as Error).message}）；改用 project action=install isolated=true 在项目内独立安装` }
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function safeReadlink(p: string): string {
  try {
    return readlinkSync(p)
  } catch {
    return p
  }
}

/** 空白工程脚手架（自主自由创作路线从零搭片时用）：依赖版本取自技能库模板，保证与共享运行时同版本。 */
export function scaffoldBlank(skill: string, target: string): string[] {
  const templatePkg = JSON.parse(readFileSync(join(skill, "template/package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const deps = {
    ...(templatePkg.dependencies ?? {}),
  }
  const devDeps = { ...(templatePkg.devDependencies ?? {}) }
  const written: string[] = []
  const write = (rel: string, content: string) => {
    const abs = join(target, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
    written.push(rel)
  }
  write(
    "package.json",
    `${JSON.stringify(
      {
        name: basename(target) || "shotcraft-video",
        version: "1.0.0",
        private: true,
        scripts: { dev: "remotion studio src/index.ts", render: "remotion render src/index.ts Promo out/promo.mp4", still: "remotion still src/index.ts Promo" },
        dependencies: deps,
        devDependencies: devDeps,
      },
      null,
      2,
    )}\n`,
  )
  write(
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          noEmit: true,
          lib: ["DOM", "ES2022"],
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  )
  write("remotion.config.ts", "import { Config } from '@remotion/cli/config';\n\nConfig.setVideoImageFormat('jpeg');\nConfig.setOverwriteOutput(true);\n")
  write("src/index.ts", "import { registerRoot } from 'remotion';\nimport { Root } from './Root';\n\nregisterRoot(Root);\n")
  write(
    "src/Root.tsx",
    [
      "import { AbsoluteFill, Composition } from 'remotion';",
      "",
      "export const Promo: React.FC = () => {",
      "  return <AbsoluteFill style={{ backgroundColor: '#0b0b0f' }} />;",
      "};",
      "",
      "export const Root: React.FC = () => {",
      "  return (",
      "    <Composition id=\"Promo\" component={Promo} durationInFrames={300} fps={30} width={1920} height={1080} />",
      "  );",
      "};",
      "",
    ].join("\n"),
  )
  makedirsPublic(target)
  return written
}

function makedirsPublic(target: string): void {
  const pub = join(target, "public")
  mkdirSync(pub, { recursive: true })
  const keep = join(pub, ".gitkeep")
  if (!existsSync(keep)) writeFileSync(keep, "")
}

export const projectTool: Tool = {
  name: "project",
  description:
    "视频工程脚手架与运行时：init 建项目（技能库模板或最小空白工程，自动接入共享运行时依赖——目录联接复用，免每个项目重复安装）、install（重）建运行时依赖或项目内独立安装、status 查看项目/运行时/Chrome 缓存/调优与最近渲染作业状态。",
  parameters: schema(
    {
      action: { type: "string", enum: ["init", "install", "status"], description: "init=建项目 / install=（重）建依赖 / status=状态一览" },
      path: { type: "string", description: "项目目录（默认 SHOTCRAFT_PROJECT 或会话工作目录；不存在则创建）" },
      template: { type: "string", enum: ["ink-press", "blank"], description: "init 脚手架来源：ink-press（技能库已验收宣传片模板，默认）/ blank（最小空白工程）" },
      force: { type: "boolean", description: "init：目标目录已有工程时强制覆盖模板文件；install：忽略签名强制重装" },
      isolated: { type: "boolean", description: "install：true 时在项目内独立安装依赖（需要与共享运行时不同的 Remotion 版本时用），默认复用共享运行时" },
      install: { type: "boolean", description: "init：是否顺带安装共享运行时依赖（默认 true）" },
    },
    ["action"],
  ),
  outputSchema: {
    type: "object",
    properties: { projectDir: { type: "string" }, entryPoint: { type: "string" }, actions: { type: "array", items: { type: "string" } } },
  },
  requiresApproval: (args) => String(args.action ?? "") !== "status",
  async execute(args, ctx): Promise<ToolResult> {
    const action = String(args.action ?? "status")
    const actions: string[] = []

    if (action === "install") {
      const skill = resolveSkillDir(ctx)
      if (!skill) return { output: "技能库尚未就绪：请先执行 setup。" }
      if (args.isolated === true) {
        const projectDir = resolveProjectDir(ctx, args.path ? String(args.path) : undefined)
        const npm = Bun.which("npm")
        const bun = Bun.which("bun")
        const cmd = npm ? [npm, "install", "--no-audit", "--no-fund"] : bun ? [bun, "install"] : null
        if (!cmd) return { output: "宿主机既无 npm 也无 bun，无法安装依赖。" }
        const proc = Bun.spawn(cmd, { cwd: projectDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } })
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
          new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        ])
        const code = await proc.exited
        const tail = `${stdout}\n${stderr}`.trim().slice(-1200)
        return {
          output:
            code === 0
              ? `已在 ${projectDir} 内独立安装依赖（与共享运行时解耦，Remotion ${readInstalledRemotionVersion(projectDir) ?? "?"}）。`
              : `独立安装失败（${cmd.join(" ")} 退出码 ${code}）：\n${tail}`,
          data: { projectDir, exitCode: code },
        }
      }
      const runtime = await ensureRuntime(ctx, { force: args.force === true, skill })
      return {
        output: [`共享运行时目录：${runtime.runtimeDir}`, ...runtime.actions, runtime.error ?? ""].filter(Boolean).join("\n"),
        data: { runtimeDir: runtime.runtimeDir, ok: runtime.ok, lock: runtime.lock },
      }
    }

    if (action === "status") {
      const projectDir = resolveProjectDir(ctx, args.path ? String(args.path) : undefined)
      const skill = resolveSkillDir(ctx)
      const lock = readSkillLock(ctx)
      const runtimeLock = readRuntimeLock(ctx)
      const manifest = readProjectManifest(projectDir)
      const entry = detectEntryPoint(projectDir)
      const nodeModules = join(projectDir, "node_modules")
      const linkNote = isSymlink(nodeModules) ? `目录联接 → ${safeReadlink(nodeModules)}` : existsSync(nodeModules) ? "独立安装" : "缺失（渲染前需 project action=install）"
      const chromeCache = remotionCacheDir()
      const bins = chromeCache.exists ? dirStats(chromeCache.dir) : { bytes: 0, files: 0 }
      const tuning = readTuning(ctx)
      const jobs = listJobs().slice(0, 5)
      const lines = [
        `项目：${projectDir}${existsSync(projectDir) ? "" : "（尚未创建）"}`,
        `  来源模板：${manifest?.source ?? "未知（非 init 创建的项目）"}${manifest?.templateSignature ? `（模板签名 ${manifest.templateSignature}）` : ""}`,
        `  入口点：${entry ?? "未探测到（含 registerRoot 的入口文件）"}`,
        `  依赖：${linkNote}`,
        `  Remotion：${readInstalledRemotionVersion(projectDir) ?? "未安装"}`,
        `技能库：${skill ?? "未就绪"}${lock?.upstreamRevision ? ` · revision ${lock.upstreamRevision}` : ""}`,
        `共享运行时：${runtimeLock ? `${runtimeLock.status}（Remotion ${runtimeLock.remotionVersion ?? "?"} · ${runtimeLock.packageManager ?? "?"}）` : "未安装"}`,
        `Chrome 缓存：${bins.files ? `已就绪 ${(bins.bytes / 1024 / 1024).toFixed(1)}MB（${chromeCache.dir}）` : `未下载（首次渲染自动下载到 ${chromeCache.dir}）`}`,
        `原生 compositor/ffmpeg：随项目依赖（@remotion/compositor-*）提供`,
        `调优缓存：${Object.keys(tuning.entries).length} 条实测${tuning.encoderProbe ? ` · 硬件编码实测：${tuning.encoderProbe.hardware ? "通过" : `未通过（${tuning.encoderProbe.error ?? ""}）`}` : ""}`,
      ]
      if (jobs.length) {
        lines.push("最近渲染作业：")
        for (const job of jobs) lines.push(`  ${job.id} · ${job.kind} · ${job.status} · ${job.composition}${job.summary ? ` · ${job.summary.split("\n")[0]}` : ""}`)
      }
      return { output: lines.join("\n"), data: { projectDir, entryPoint: entry, manifest, runtime: runtimeLock, libraryRoot: libraryRoot(ctx) } }
    }

    // init
    const ensured = await ensureSkill(ctx, {})
    actions.push(...ensured.actions)
    if (!ensured.ok || !ensured.skillDir) return { output: `${ensured.error ?? "技能库准备失败"}\n${actions.join("\n")}` }
    const skill = ensured.skillDir
    const projectDir = resolveProjectDir(ctx, args.path ? String(args.path) : undefined)
    const existing = existsSync(join(projectDir, "package.json")) || existsSync(join(projectDir, "src"))
    if (existing && args.force !== true) {
      return {
        output: `目标目录 ${projectDir} 已存在工程（package.json 或 src/）。换目录，或传 force=true 覆盖模板文件（会覆盖同名的模板文件）。`,
      }
    }
    const template = String(args.template ?? "ink-press")
    mkdirSync(projectDir, { recursive: true })

    const runtime = args.install === false ? null : await ensureRuntime(ctx, { skill })
    if (runtime) {
      actions.push(...runtime.actions)
      if (!runtime.ok && runtime.error) actions.push(`运行时未就绪：${runtime.error}`)
    } else {
      actions.push("按 install=false 跳过依赖安装（渲染前需先 project action=install）")
    }

    const copied = template === "blank" ? scaffoldBlank(skill, projectDir) : copyTemplate(skill, projectDir)
    actions.push(`${template === "blank" ? "空白工程脚手架" : "模板工程"}落位：${copied.join(", ")} → ${projectDir}`)

    const link = linkNodeModules(projectDir, runtimeDir(ctx))
    actions.push(link.note)
    const entry = detectEntryPoint(projectDir)
    const entryRel = entry ? relative(projectDir, entry).split(sep).join("/") : "src/index.ts"
    writeFileSync(
      join(projectDir, ".shotcraft.json"),
      JSON.stringify(
        {
          entryPoint: entryRel,
          templateSignature: templateSignature(skill),
          skillRevision: readSkillLock(ctx)?.upstreamRevision,
          source: template,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
    actions.push(`项目清单：.shotcraft.json（入口点 ${entryRel}、模板来源 ${template}）`)

    const lines = [`项目已就绪：${projectDir}`, ...actions.map((a) => `  - ${a}`), "", "下一步：渲染用 render action=still / preview / video（首次会打包并下载 Chrome，之后热复用）。"]
    return { output: lines.join("\n"), data: { projectDir, entryPoint: join(projectDir, entryRel), template, nodeModulesLinked: link.linked } }
  },
}
