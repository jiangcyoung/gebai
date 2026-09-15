/**
 * 主机与项目探测：采集渲染档决策所需事实（有效 CPU 数、内存、NVIDIA GPU、Linux DRI 渲染设备、
 * 项目内 Remotion 版本、项目是否含 WebGL/Three 内容、磁盘余量），把外部世界收敛成可注入的依赖；
 * 「怎么定档」留给 profile.ts 的纯函数（无 GPU 的开发机也能覆盖全部分支）。
 *
 * 有效 CPU 数必须与 Remotion 同规则 `min(nproc, os.availableParallelism())`——容器 cgroup 配额由此生效；
 * 并发超过该值 Remotion 直接拒绝（`Maximum for --concurrency is N`），故不能用 `os.cpus().length` 顶替。
 * 探测项失败一律只记 notes 不抛错：探测是尽力而为，渲染档决策要能在信息缺失时降级运行。
 */
import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs"
import { availableParallelism, cpus, totalmem } from "node:os"
import { dirname, join } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { libraryRoot } from "./paths"

/** 探测到的主机与项目事实（profile.ts 决策函数的唯一输入）。 */
export interface ProbeInput {
  platform: string
  arch: string
  cpuCount: number
  memoryMB: number
  /** NVIDIA GPU（未检测到为 null）。 */
  nvidia: { name: string; driver: string; memoryMB: number } | null
  /** Linux DRI 渲染设备（/dev/dri/renderD*；非 NVIDIA 的 GPU 存在性判据）。 */
  renderNodes: string[]
  /** macOS Apple Silicon（VideoToolbox 硬件编码可用）。 */
  appleSilicon: boolean
  /** 项目内已安装的 Remotion 版本（能力门控；未装为 null）。 */
  remotionVersion: string | null
  /** 项目是否含 WebGL/Three 内容（决定是否指定 gl 后端）。 */
  webglContent: boolean
}

export interface ProbeResult {
  input: ProbeInput
  /** 探测过程说明（降级原因、缺项提醒；不阻断渲染）。 */
  notes: string[]
  /** nvidia-smi 原始输出（排查用）。 */
  nvidiaSmiRaw?: string
}

/** 探测依赖（单测注入假实现，不读本机真实硬件）。 */
export interface DetectDeps {
  platform?: string
  arch?: string
  cpuCount?: () => number
  memoryMB?: () => number
  readDir?: (dir: string) => string[]
  exec?: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  freeDiskMB?: (path: string) => number | null
}

/** 项目侧事实（探测的返回值子集，供工具层只关心项目时单独调用）。 */
export interface ProjectFacts {
  remotionVersion: string | null
  webglContent: boolean
}

const SMI_QUERY = ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"]
const WEBGL_PACKAGES = ["three", "@react-three/fiber", "@remotion/three"]
const WEBGL_SOURCE_RE = /\bthree\b|@react-three\/fiber|@remotion\/three|\bCanvas\b|WebGL/i

/** nvidia-smi 调用：固定 5s 超时（驱动挂死时不能拖住整个探测）。 */
async function defaultExec(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 已退出 */
      }
    }, 5000)
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

/**
 * 有效 CPU 数 = min(nproc, 可并行度)。nproc 不可用（无该命令/非 Linux）时取可并行度；
 * 两者都取不到有效值时兜底 1（绝不让并发落到 0）。
 */
export function resolveCpuCount(nodeCount: number, nproc: number | null): number {
  const node = Number.isFinite(nodeCount) && nodeCount > 0 ? Math.floor(nodeCount) : 0
  if (nproc === null || !Number.isFinite(nproc) || nproc <= 0) return Math.max(1, node)
  return Math.max(1, Math.min(Math.floor(nproc), node))
}

/** 本机有效 CPU 数（Remotion 同规则；`availableParallelism` 已含容器 cgroup 配额）。 */
export function effectiveCpuCount(): number {
  let nodeCount: number
  try {
    nodeCount = typeof availableParallelism === "function" ? availableParallelism() : cpus().length
  } catch {
    nodeCount = cpus().length
  }
  let nproc: number | null = null
  try {
    const parsed = Number.parseInt(execSync("nproc", { stdio: "pipe" }).toString().trim(), 10)
    nproc = Number.isFinite(parsed) ? parsed : null
  } catch {
    nproc = null
  }
  return resolveCpuCount(nodeCount, nproc)
}

/** 解析 nvidia-smi `name, driver_version, memory.total`（nounits 时内存为纯数字）；无设备返回 null。 */
export function parseNvidiaSmi(stdout: string): ProbeInput["nvidia"] {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const cells = line.split(",").map((c) => c.trim())
  const name = cells[0] ?? ""
  if (!name || /^(not found|no devices|command not found)/i.test(name)) return null
  const memory = /(\d+)/.exec(cells[2] ?? "")
  return { name, driver: cells[1] ?? "", memoryMB: memory ? Number(memory[1]) : 0 }
}

/** 项目侧事实：Remotion 版本取自项目 `node_modules/remotion/package.json`；WebGL 内容看依赖或 src 源码直引。 */
export function detectProjectFacts(projectDir: string | null | undefined, deps: DetectDeps = {}): ProjectFacts {
  if (!projectDir || !existsSync(projectDir)) return { remotionVersion: null, webglContent: false }
  const readFile = (p: string): string | null => {
    try {
      return readFileSync(p, "utf8")
    } catch {
      return null
    }
  }
  let remotionVersion: string | null = null
  const remotionPkg = readFile(join(projectDir, "node_modules", "remotion", "package.json"))
  if (remotionPkg) {
    try {
      const version = (JSON.parse(remotionPkg) as { version?: unknown }).version
      remotionVersion = typeof version === "string" ? version : null
    } catch {
      remotionVersion = null
    }
  }

  let webglContent = false
  const packageText = readFile(join(projectDir, "package.json"))
  if (packageText) {
    try {
      const pkg = JSON.parse(packageText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
      webglContent = WEBGL_PACKAGES.some((name) => names.has(name))
    } catch {
      webglContent = false
    }
  }
  if (!webglContent) {
    const srcDir = join(projectDir, "src")
    let entries: string[] = []
    try {
      entries = (deps.readDir ?? ((dir: string) => readdirSync(dir)))(srcDir)
    } catch {
      entries = []
    }
    for (const name of entries) {
      if (!/\.(ts|tsx|js|jsx)$/.test(name)) continue
      const text = readFile(join(srcDir, name))
      if (text && WEBGL_SOURCE_RE.test(text)) {
        webglContent = true
        break
      }
    }
  }
  return { remotionVersion, webglContent }
}

/**
 * 采集探测事实：每一项都在自己的 try 里，失败写 notes 并落最保守的取值（null/0/空数组），绝不抛错。
 * 项目目录存在但没装 Remotion 时给出可操作提示（先装依赖再渲染）。
 */
export async function collectProbe(
  ctx: ToolContext,
  opts: { projectDir?: string | null } = {},
  deps: DetectDeps = {},
): Promise<ProbeResult> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const notes: string[] = []

  let cpuCount = 1
  try {
    cpuCount = Math.max(1, Math.floor((deps.cpuCount ?? effectiveCpuCount)()))
  } catch (err) {
    notes.push(`CPU 核数探测失败（${(err as Error).message}），按 1 核计算`)
  }

  let memoryMB = 0
  try {
    memoryMB = Math.max(0, Math.round((deps.memoryMB ?? (() => totalmem() / 1024 / 1024))()))
  } catch (err) {
    notes.push(`内存探测失败（${(err as Error).message}），按未知处理`)
  }

  let nvidia: ProbeInput["nvidia"] = null
  let nvidiaSmiRaw: string | undefined
  const exec = deps.exec ?? defaultExec
  try {
    const smi = await exec(SMI_QUERY)
    if (smi.code === 0) {
      nvidiaSmiRaw = smi.stdout.trim()
      nvidia = parseNvidiaSmi(smi.stdout)
      if (!nvidia) notes.push("nvidia-smi 有输出但未能解析出 GPU 信息")
    } else {
      const detail = smi.stderr.trim().split("\n")[0] || `退出码 ${smi.code}`
      notes.push(`未检测到 NVIDIA GPU（nvidia-smi：${detail}）`)
    }
  } catch (err) {
    notes.push(`nvidia-smi 执行失败（${(err as Error).message}）——按无 NVIDIA GPU 处理`)
  }

  let renderNodes: string[] = []
  if (platform === "linux") {
    try {
      renderNodes = (deps.readDir ?? ((dir: string) => readdirSync(dir)))("/dev/dri")
        .filter((name) => name.startsWith("renderD"))
        .map((name) => `/dev/dri/${name}`)
    } catch {
      renderNodes = []
    }
    if (!renderNodes.length && !nvidia) notes.push("无 /dev/dri 渲染设备：按无 GPU 处理（容器/无 GPU 宿主机的常见形态）")
  }

  let facts: ProjectFacts = { remotionVersion: null, webglContent: false }
  try {
    facts = detectProjectFacts(opts.projectDir, deps)
  } catch (err) {
    notes.push(`项目事实探测失败（${(err as Error).message}）`)
  }
  if (opts.projectDir && !facts.remotionVersion) notes.push("项目内未检测到 Remotion（先执行 reel_project action=install）")

  try {
    const freeDiskMB = (deps.freeDiskMB ?? defaultFreeDiskMB)(libraryRoot(ctx))
    if (freeDiskMB !== null && freeDiskMB < 20_000) {
      notes.push(`可用磁盘空间偏低（${(freeDiskMB / 1024).toFixed(1)}GB）——渲染产物与 Chrome 需数 GB 空间`)
    }
  } catch (err) {
    notes.push(`磁盘余量探测失败（${(err as Error).message}）`)
  }

  const input: ProbeInput = {
    platform,
    arch,
    cpuCount,
    memoryMB,
    nvidia,
    renderNodes,
    appleSilicon: platform === "darwin" && arch === "arm64",
    remotionVersion: facts.remotionVersion,
    webglContent: facts.webglContent,
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

/**
 * Chrome 下载缓存目录：Remotion 的 `getDownloadsCacheDir()` 规则——自 `process.cwd()` 向上找到
 * 最近的 `package.json` 所在目录，取该目录下 `node_modules/.remotion`（报告体积时按此如实展示）。
 */
/**
 * Chrome 缓存目录：与 Remotion `getDownloadsCacheDir` 同规则——自起点（默认进程 cwd）向上找最近的
 * `package.json` 所在目录，取其 `node_modules/.remotion`；一路上都没有则回落 `<起点>/.remotion`。
 * Remotion 首次渲染时把 Chrome 下载到这里，同实例各项目共用一份。起点可注入，便于测试。
 */
export function chromeCacheDir(from: string = process.cwd()): { dir: string; exists: boolean } {
  let dir: string | null = from
  while (dir) {
    try {
      if (statSync(join(dir, "package.json")).isFile()) break
    } catch {
      /* 继续向上 */
    }
    const parent = dirname(dir)
    if (parent === dir) {
      dir = null
      break
    }
    dir = parent
  }
  if (!dir) {
    const fallback = join(from, ".remotion")
    return { dir: fallback, exists: existsSync(fallback) }
  }
  const cache = join(dir, "node_modules", ".remotion")
  return { dir: cache, exists: existsSync(cache) }
}

/** 目录体积统计（递归；目录不存在/不可读按 0 计，不抛错）。 */
export function dirStats(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (path: string): void => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      try {
        bytes += statSync(full).size
        files++
      } catch {
        /* 不可读条目跳过 */
      }
    }
  }
  walk(dir)
  return { bytes, files }
}
