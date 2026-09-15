/**
 * 主机与项目探测：采集渲染档决策所需事实（CPU/内存、NVIDIA GPU（nvidia-smi）、Linux DRI 设备、
 * 项目内 Remotion 版本、项目是否含 WebGL/Three 内容、磁盘余量），把外部世界收敛成可注入的依赖，
 * 决策本身仍在 profile.ts 的纯函数里完成（便于单测覆盖 GPU 分支）。
 */
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs"
import { execSync } from "node:child_process"
import { availableParallelism, cpus, totalmem } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { readInstalledRemotionVersion } from "./library"
import { hasWebglDependencies, hasWebglImports, parseNvidiaSmi, type GpuInfo, type ProbeInput, type TuningEntry } from "./profile"
import { detectEntryPoint, readProjectManifest } from "./runtime"
import { gpuPolicy } from "./paths"

export interface DetectDeps {
  platform?: string
  arch?: string
  cpuCount?: () => number
  memoryMB?: () => number
  exec?: (cmd: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>
  exists?: (p: string) => boolean
  readDir?: (p: string) => string[]
  readFile?: (p: string) => string
  freeDiskMB?: (p: string) => number | null
}

async function defaultExec(cmd: string[], timeoutMs = 4000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 已退出 */
      }
    }, timeoutMs)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    return { code, stdout, stderr }
  } catch (err) {
    return { code: -1, stdout: "", stderr: (err as Error).message }
  }
}

export interface DetectResult {
  input: ProbeInput
  notes: string[]
  nvidiaSmiRaw?: string
}

/** 项目侧事实：Remotion 版本 + WebGL 内容判定（依赖声明或源码直引）。 */
export function detectProjectFacts(projectDir: string | null | undefined, deps: DetectDeps = {}): {
  remotionVersion: string | null
  webglContent: boolean
  source: string | null
} {
  if (!projectDir || !existsSync(projectDir)) return { remotionVersion: null, webglContent: false, source: null }
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"))
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p))
  const remotionVersion = readInstalledRemotionVersion(projectDir)
  const snippets: string[] = []
  let packageText = ""
  try {
    packageText = readFile(join(projectDir, "package.json"))
  } catch {
    packageText = ""
  }
  const srcDir = join(projectDir, "src")
  if (existsSync(srcDir)) {
    for (const name of readDir(srcDir)) {
      if (!/\.(ts|tsx|js|jsx)$/.test(name)) continue
      try {
        snippets.push(readFile(join(srcDir, name)))
      } catch {
        /* 忽略不可读文件 */
      }
    }
  }
  const manifest = readProjectManifest(projectDir)
  const entry = detectEntryPoint(projectDir)
  return {
    remotionVersion,
    webglContent: hasWebglDependencies(packageText) || hasWebglImports(snippets),
    source: manifest?.source ?? (entry ? join(projectDir, "src") : null),
  }
}

/**
 * 有效 CPU 数：与 Remotion `getCpuCount` 同规则（`min(nproc, os.availableParallelism())`，容器 cgroup 配额由此生效）——
 * 并发超上限 Remotion 直接拒绝（`Maximum for --concurrency is N`），故必须用同一口径而非 `os.cpus().length`。
 */
export function resolveCpuCount(nodeCount: number, nproc: number | null): number {
  if (nproc === null || !Number.isFinite(nproc) || nproc <= 0) return Math.max(1, Math.floor(nodeCount))
  return Math.max(1, Math.min(Math.floor(nproc), Math.floor(nodeCount)))
}

export function effectiveCpuCount(): number {
  const nodeCount = typeof availableParallelism === "function" ? availableParallelism() : cpus().length
  let nproc: number | null = null
  try {
    nproc = parseInt(execSync("nproc", { stdio: "pipe" }).toString().trim(), 10)
  } catch {
    nproc = null
  }
  return resolveCpuCount(nodeCount, nproc)
}

/** 采集探测事实（GPU 查询失败不抛错，降级为"未检测到"并记录说明）。 */
export async function collectProbe(
  ctx: ToolContext,
  opts: { projectDir?: string | null; tuning?: TuningEntry | null },
  deps: DetectDeps = {},
): Promise<DetectResult> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const cpuCount = (deps.cpuCount ?? (() => effectiveCpuCount()))()
  const memoryMB = Math.round((deps.memoryMB ?? (() => totalmem() / 1024 / 1024))())
  const exec = deps.exec ?? defaultExec
  const readDir = deps.readDir ?? ((p: string) => readdirSync(p))
  const notes: string[] = []

  let nvidia: GpuInfo | null = null
  let nvidiaSmiRaw: string | undefined
  const smi = await exec(["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"])
  if (smi.code === 0) {
    nvidiaSmiRaw = smi.stdout.trim()
    nvidia = parseNvidiaSmi(smi.stdout)
    if (!nvidia) notes.push("nvidia-smi 有输出但未能解析出 GPU 信息")
  } else {
    notes.push(`nvidia-smi 不可用或未检测到 NVIDIA GPU（${smi.stderr.trim().split("\n")[0] || `exit ${smi.code}`}）`)
  }

  let renderNodes: string[] = []
  if (platform === "linux") {
    try {
      renderNodes = readDir("/dev/dri").filter((n) => n.startsWith("renderD")).map((n) => `/dev/dri/${n}`)
    } catch {
      renderNodes = []
    }
    if (!renderNodes.length && !nvidia) notes.push("无 /dev/dri 渲染设备（容器/无 GPU 宿主的常见形态）")
  }

  const projectFacts = detectProjectFacts(opts.projectDir, deps)
  const freeDisk = (deps.freeDiskMB ?? defaultFreeDiskMB)(ctx.home)
  if (freeDisk !== null && freeDisk < 20_000) notes.push(`可用磁盘空间偏低（${(freeDisk / 1024).toFixed(1)}GB）——渲染产物与 Chrome 需数 GB 空间`)
  if (opts.projectDir && !projectFacts.remotionVersion) notes.push("项目内未检测到已安装的 Remotion（先执行 project action=install）")

  const input: ProbeInput = {
    platform,
    arch,
    cpuCount,
    memoryMB,
    nvidia,
    renderNodes,
    appleSilicon: platform === "darwin" && arch === "arm64",
    remotionVersion: projectFacts.remotionVersion,
    webglContent: projectFacts.webglContent,
    gpuPolicy: gpuPolicy(ctx),
    tuning: opts.tuning ?? null,
  }
  return { input, notes, nvidiaSmiRaw }
}

function defaultFreeDiskMB(path: string): number | null {
  try {
    const st = statfsSync(path)
    return Math.round((Number(st.bavail) * Number(st.bsize)) / 1024 / 1024)
  } catch {
    return null
  }
}
