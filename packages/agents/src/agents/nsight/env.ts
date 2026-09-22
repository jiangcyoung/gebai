/**
 * Nsight 工具链解析与环境自检（nsight 专用基础层）。
 *
 * - 可执行文件定位：环境变量（NSIGHT_SYSTEMS_BIN / NSIGHT_COMPUTE_BIN）→ 常见安装目录（按版本倒序取最新）
 *   → PATH。解析结果进程级缓存（含 `--version` 探测），避免每次工具调用重复探测。
 * - 命令构造：宿主 runCommand 在 Windows 走 PowerShell、其余走 POSIX shell，两条通道的引用规则统一为
 *   单引号包裹（内嵌单引号按各自语法转义）——报告路径常含空格与括号，裸拼必失败。
 * - 权限诊断：ncu 采集需要 GPU 性能计数器访问权（NVIDIA 驱动的开发者设置），探测入口是
 *   `ncu --query-metrics --devices 0`——无权时立即返回 ERR_NVGPUCTRPERM，比采集失败后再排查快得多。
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { ToolContext } from "@gebai/sdk"

/**
 * Windows 命令解释器形态：宿主的 sh/子进程通道默认经 PowerShell（`GEBAI_SH_SHELL=cmd` 时回落 cmd.exe），
 * 两者引用与调用语法不同，命令串必须按实际形态构造。
 */
function winShellKind(): "powershell" | "cmd" {
  const override = (process.env.GEBAI_SH_SHELL ?? "").trim()
  if (!override) return "powershell"
  const name = override.replace(/[\\/]+/g, "/").split("/").pop() ?? override
  return /^cmd(\.exe)?$/i.test(name) ? "cmd" : "powershell"
}

/** 单个参数引用（按宿主 shell 语法）：PowerShell 单引号（内嵌单引号双写）、cmd 双引号（内嵌双引号双写）、POSIX 单引号。 */
export function shellQuote(arg: string): string {
  if (process.platform === "win32") {
    if (winShellKind() === "cmd") return `"${arg.replace(/"/g, '""')}"`
    return `'${arg.replace(/'/g, "''")}'`
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * 可执行文件 + 参数数组 → 宿主 shell 可直接执行的命令行。
 * Windows PowerShell 下带空格/括号的路径必须以调用运算符 `&` 前缀（否则被当作字符串字面量），
 * 而 `nsys`/`ncu` 的安装路径恰好恒含空格——这是本层存在的主要理由。
 */
export function buildCommand(bin: string, args: string[]): string {
  if (process.platform === "win32" && winShellKind() === "powershell") {
    return ["&", shellQuote(bin), ...args.map(shellQuote)].join(" ")
  }
  return [bin, ...args].map(shellQuote).join(" ")
}

export interface NsightBinary {
  /** 可执行文件绝对路径（PATH 命中时为其解析结果）。 */
  path: string
  /** `--version` 输出首行（探测失败为空）。 */
  version: string
  /** 定位来源：env=环境变量显式指定、scan=安装目录扫描、path=PATH 命中。 */
  source: "env" | "scan" | "path"
}

export interface NsightEnvState {
  nsys?: NsightBinary
  ncu?: NsightBinary
  /** 报告导入缓存根（NSIGHT_CACHE_DIR 覆盖，缺省 {GEBAI_HOME}/cache/nsight）。 */
  cacheDir: string
  /** 定位过程产生的问题（缺工具链、扫描异常等），供 doctor 原样呈现。 */
  issues: string[]
}

const ENV_NSYS = "NSIGHT_SYSTEMS_BIN"
const ENV_NCU = "NSIGHT_COMPUTE_BIN"

/** 版本倒序候选目录：按目录名中的数字段比较，取最高版本优先探测。 */
function byVersionDesc(a: string, b: string): number {
  const nums = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number)
  const na = nums(a)
  const nb = nums(b)
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (nb[i] ?? 0) - (na[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 在各安装根下按子目录（版本号命名）倒序查找目标可执行文件的相对位置。 */
function scanInstallRoots(roots: string[], relCandidates: string[]): string | null {
  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = existsSync(root) ? readdirSync(root) : []
    } catch {
      continue
    }
    for (const dir of entries.slice().sort(byVersionDesc)) {
      for (const rel of relCandidates) {
        const candidate = join(root, dir, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

function nsysScanTargets(): { roots: string[]; rel: string[] } {
  if (process.platform === "win32") {
    return {
      roots: [
        "C:\\Program Files\\NVIDIA Corporation",
        "C:\\Program Files (x86)\\NVIDIA Corporation",
        process.env.ProgramData ? join(process.env.ProgramData, "NVIDIA Corporation") : "",
      ].filter(Boolean),
      // 2025.x 的 nsys.exe 落在 target-<platform>-<arch> 下（无 bin/ 目录）；旧版有 bin/
      rel: ["target-windows-x64\\nsys.exe", "bin\\nsys.exe", "nsys.exe"],
    }
  }
  if (process.platform === "darwin") {
    return {
      roots: ["/opt/nvidia", "/Applications/NVIDIA Nsight Systems.app/Contents", "/usr/local", "/opt/homebrew"],
      rel: ["bin/nsys", "MacOS/nsys", "nsight-systems/bin/nsys"],
    }
  }
  return {
    roots: ["/opt/nvidia/nsight-systems", "/opt/nvidia", "/usr/local/cuda", "/usr/local", "/usr"],
    rel: ["bin/nsys", "nsight-systems/bin/nsys", "nsys"],
  }
}

function ncuScanTargets(): { roots: string[]; rel: string[] } {
  if (process.platform === "win32") {
    return {
      roots: [
        "C:\\Program Files\\NVIDIA Corporation",
        "C:\\Program Files (x86)\\NVIDIA Corporation",
        process.env.ProgramData ? join(process.env.ProgramData, "NVIDIA Corporation") : "",
      ].filter(Boolean),
      rel: ["ncu.exe", "windows-desktop\\ncu.exe", "bin\\ncu.exe", "windows-desktop\\ncu.bat"],
    }
  }
  if (process.platform === "darwin") {
    return {
      roots: ["/opt/nvidia", "/Applications/NVIDIA Nsight Compute.app/Contents", "/usr/local", "/opt/homebrew"],
      rel: ["bin/ncu", "MacOS/ncu", "nsight-compute/ncu"],
    }
  }
  return {
    roots: ["/opt/nvidia/nsight-compute", "/opt/nvidia", "/usr/local/cuda", "/usr/local", "/usr"],
    rel: ["ncu", "bin/ncu", "nsight-compute/ncu"],
  }
}

/** 经 PATH 解析可执行文件（Windows 用 where.exe，其余用 command -v）。 */
async function resolveFromPath(ctx: ToolContext, name: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? buildCommand("where.exe", [name]) : `command -v ${shellQuote(name)}`
  const r = await ctx.runCommand(cmd, { timeoutMs: 10_000 }).catch(() => null)
  if (!r || r.code !== 0) return null
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
  return first && existsSync(first) ? first : null
}

interface CacheEntry {
  binary: NsightBinary | null
  probeKey: string
}

const binaryCache = new Map<string, CacheEntry>()

async function probeVersion(ctx: ToolContext, bin: string): Promise<string> {
  const r = await ctx.runCommand(buildCommand(bin, ["--version"]), { timeoutMs: 20_000 }).catch(() => null)
  if (!r) return ""
  const text = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return text[0] ?? ""
}

/**
 * 定位 nsys / ncu 可执行文件并探测版本（进程级缓存）。
 * 探测键含环境变量取值——用户在会话内改配置后下一次调用即重新解析。
 */
export async function resolveNsightEnv(ctx: ToolContext): Promise<NsightEnvState> {
  const issues: string[] = []
  const cacheDir = ctx.env.NSIGHT_CACHE_DIR?.trim() || join(ctx.home, "cache", "nsight")

  const resolveOne = async (
    kind: "nsys" | "ncu",
    envName: string,
    scanTargets: () => { roots: string[]; rel: string[] },
  ): Promise<NsightBinary | undefined> => {
    const explicit = ctx.env[envName]?.trim()
    const probeKey = `${explicit ?? ""}|${process.platform}`
    const cached = binaryCache.get(kind)
    if (cached && cached.probeKey === probeKey) {
      return cached.binary ?? undefined
    }
    let found: { path: string; source: NsightBinary["source"] } | null = null
    if (explicit) {
      if (existsSync(explicit)) found = { path: explicit, source: "env" }
      else issues.push(`${envName}=${explicit} 指向的文件不存在，已回退自动探测`)
    }
    if (!found) {
      const scanned = scanInstallRoots(scanTargets().roots, scanTargets().rel)
      if (scanned) found = { path: scanned, source: "scan" }
    }
    if (!found) {
      const onPath = await resolveFromPath(ctx, kind === "nsys" ? "nsys" : "ncu")
      if (onPath) found = { path: onPath, source: "path" }
    }
    const binary: NsightBinary | null = found
      ? { path: found.path, version: await probeVersion(ctx, found.path), source: found.source }
      : null
    binaryCache.set(kind, { binary, probeKey })
    return binary ?? undefined
  }

  const nsys = await resolveOne("nsys", ENV_NSYS, nsysScanTargets)
  const ncu = await resolveOne("ncu", ENV_NCU, ncuScanTargets)
  return { nsys, ncu, cacheDir, issues }
}

/** 工具执行前的工具链前置检查：缺失时返回可直接作为工具结果的说明文本。 */
export function missingToolchainNote(env: NsightEnvState, need: "nsys" | "ncu" | "both"): string | null {
  const miss: string[] = []
  if ((need === "nsys" || need === "both") && !env.nsys) miss.push("Nsight Systems（nsys）")
  if ((need === "ncu" || need === "both") && !env.ncu) miss.push("Nsight Compute（ncu）")
  if (!miss.length) return null
  const envNames = miss.map((m) => (m.includes("Systems") ? ENV_NSYS : ENV_NCU)).join(" / ")
  return [
    `未找到 ${miss.join("、")} 命令行工具——本能力依赖 NVIDIA Nsight 工具链的命令行可执行文件。`,
    `安装 Nsight Systems / Nsight Compute 后可用环境变量显式指定路径（${envNames}），或将其加入 PATH。`,
    "安装位置参考：Windows `C:\\Program Files\\NVIDIA Corporation\\Nsight Systems <版本>\\target-windows-x64\\nsys.exe`、`Nsight Compute <版本>\\ncu.exe`；Linux `/opt/nvidia/nsight-systems/<版本>/bin/nsys`、`/opt/nvidia/nsight-compute/<版本>/ncu`。",
    "环境自检：调用 nsight_doctor 查看完整探测结果。",
  ].join("\n")
}

export interface GpuInfo {
  name: string
  driver: string
  computeCap: string
  /**
   * 驱动模型：Windows 上为 `WDDM`（显示驱动模型）或 `TCC`；其他平台通常查不到。
   *
   * 用途：WDDM 会对计算命令引入额外延迟，且会让 nsys 的内核**时长**失真——
   * 此时不能用内核耗时下结论，需用**调用计数/网格配置**交叉验证。
   */
  driverModel?: string
}

/**
 * 驱动模型探测（探测不到时返回 undefined，不报错）。
 *
 * `--query-gpu` 不支持该字段，只能从 `nvidia-smi -q` 的 `Driver Model / Current` 段提取。
 */
async function queryDriverModel(ctx: ToolContext): Promise<string | undefined> {
  const r = await ctx.runCommand(buildCommand("nvidia-smi", ["-q"]), { timeoutMs: 20_000 }).catch(() => null)
  if (!r || r.code !== 0) return undefined
  const m = r.stdout.match(/^\s*Driver Model\s*\r?\n\s*Current\s*:\s*(\S+)/m)
  return m?.[1]
}

/** GPU 概况（nvidia-smi 查询；不可用时返回 undefined 而非报错——无 GPU 机器上测报告分析仍应可用）。 */
export async function queryGpu(ctx: ToolContext): Promise<GpuInfo[] | undefined> {
  const cmd = buildCommand("nvidia-smi", ["--query-gpu=name,driver_version,compute_cap", "--format=csv,noheader"])
  const [r, driverModel] = await Promise.all([
    ctx.runCommand(cmd, { timeoutMs: 15_000 }).catch(() => null),
    queryDriverModel(ctx),
  ])
  if (!r || r.code !== 0) return undefined
  const out: GpuInfo[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.split(",").map((s) => s.trim())
    if (parts.length >= 3 && parts[0]) {
      out.push({ name: parts[0], driver: parts[1] ?? "", computeCap: parts[2] ?? "", driverModel })
    }
  }
  return out.length ? out : undefined
}

export interface CounterPermission {
  state: "granted" | "denied" | "unknown"
  detail: string
}

/**
 * GPU 性能计数器权限探测（ncu 采集的硬前置）：`ncu --query-metrics` 在无权时立即以
 * ERR_NVGPUCTRPERM 失败。探测失败区分权限问题与其它错误（无 ncu / 无设备）。
 */
export async function probeCounterPermission(ctx: ToolContext, ncuPath: string): Promise<CounterPermission> {
  const r = await ctx.runCommand(buildCommand(ncuPath, ["--query-metrics", "--devices", "0"]), { timeoutMs: 90_000 }).catch(() => null)
  if (!r) return { state: "unknown", detail: "权限探测命令未能执行（进程启动失败或超时）" }
  const text = `${r.stdout}\n${r.stderr}`
  if (text.includes("ERR_NVGPUCTRPERM")) {
    return {
      state: "denied",
      detail:
        "驱动拒绝访问 GPU 性能计数器（ERR_NVGPUCTRPERM）：ncu 采集需要管理员权限，或在 NVIDIA 控制面板开启「开发者 → 管理 GPU 性能计数器 → 允许访问 GPU 性能计数器（所有用户）」。nsys 采集与全部报告分析不受此限制。",
    }
  }
  if (r.code === 0) return { state: "granted", detail: "GPU 性能计数器访问权限正常（ncu 采集可用）" }
  return { state: "unknown", detail: text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 3).join(" / ") }
}
