/**
 * 渲染外部件：浏览器可执行文件（`browserExecutable`）与原生二进制目录（`binariesDirectory`），
 * 以及「本机有/无可用浏览器」的就绪判定。
 *
 * 存在的理由（Remotion 的默认行为与离线环境的冲突）：
 * - 浏览器：`openBrowser` 在未指定 `browserExecutable` 时按「本地缓存 → 无则联网下载」推进
 *   （缓存位置由 `getDownloadsCacheDir` 从**进程 cwd** 向上最近的 package.json 推出），且缓存 VERSION
 *   与当前 Remotion 期望不一致时**先删掉缓存再联网下载**。内网/离线机器上这一步必然挂住或失败，
 *   且发生在渲染发起之后；指定可执行文件即完全绕开缓存与下载——故就绪判定把本机已有的缓存
 *   可执行文件（**含版本不一致**）也当作可用并交出路径，由调用方显式指定（见 `browserReadiness`）。
 * - 原生二进制：Remotion 的 ffmpeg 来自 `@remotion/compositor-*` 包，`binariesDirectory` 可整体替换
 *   （目录内需含 `remotion`/`ffmpeg`/`ffprobe`），用于指定带硬件编码器的 ffmpeg 构建。
 *
 * 两条通道的取值优先级一致：**调用参数 > 环境变量 > 工程清单（`.reel.json` 同名字段）**；
 * 相对路径按工程目录解析。配置了但不存在时**明确报错**，绝不静默回落下载——把外部依赖问题
 * 暴露在渲染发起之前。环境变量是 reel 自身的契约（Remotion 不读这些变量）。
 *
 * `binariesDirectory` 是整体替换：Remotion 在只有一个目录源（`getExecutableDir` 或它）下解析
 * `remotion`（compositor）/`ffmpeg`/`ffprobe` 三个可执行文件，只给一个 ffmpeg 会让 compositor 找不到——
 * 因此目录内三件套缺一即报错。
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { chromeCacheDir } from "./detect"
import { envGet } from "./paths"
import type { ChromeMode } from "./profile"
import { readProjectManifest } from "./runtime"

/** 浏览器可执行文件的环境变量名（绝对路径或相对工程目录）。 */
export const BROWSER_EXECUTABLE_ENV = "GEBAI_REEL_CHROME_EXECUTABLE"
/** 原生二进制目录的环境变量名（内含 `remotion`/`ffmpeg`/`ffprobe`）。 */
export const BINARIES_DIR_ENV = "GEBAI_REEL_BINARIES_DIR"

export type ExternalSource = "arg" | "env" | "manifest" | "none"

export interface ResolvedExternal {
  /** 解析并校验后的绝对路径；未配置为 null。 */
  path: string | null
  source: ExternalSource
}

const SOURCE_LABEL: Record<ExternalSource, string> = {
  arg: "调用参数",
  env: "环境变量",
  manifest: "工程清单 .reel.json",
  none: "未配置",
}

interface ResolveOpts {
  ctx: ToolContext
  projectDir?: string | null
  arg?: unknown
  envKey: string
  manifestField: "browserExecutable" | "binariesDirectory"
  /** 报错文案中的中文名（如「浏览器可执行文件」）。 */
  label: string
  /** 期望形态：目录（binariesDirectory）或文件/应用包（浏览器可执行文件）。 */
  kind: "file" | "dir"
  /** kind=dir 时必须存在的条目（缺一即报错，避免渲染时才发现 compositor 找不到）。 */
  requiredEntries?: string[]
}

function resolveExternal(opts: ResolveOpts): ResolvedExternal {
  const ordered: Array<[ExternalSource, string | undefined]> = [
    ["arg", typeof opts.arg === "string" && opts.arg.trim() ? opts.arg.trim() : undefined],
    ["env", envGet(opts.ctx, opts.envKey)],
    ["manifest", opts.projectDir ? readProjectManifest(opts.projectDir)?.[opts.manifestField] : undefined],
  ]
  for (const [source, raw] of ordered) {
    if (!raw) continue
    const abs = isAbsolute(raw) ? raw : resolve(opts.projectDir ?? opts.ctx.workdir, raw)
    if (!existsSync(abs)) {
      throw new Error(`${opts.label}不存在：${abs}（来自${SOURCE_LABEL[source]}）——修正路径或移除该配置，留着会让渲染失败`)
    }
    if (opts.kind === "dir") {
      if (!statSync(abs).isDirectory()) {
        throw new Error(`${opts.label}不是目录：${abs}（来自${SOURCE_LABEL[source]}）——该路径需指向含 ${(opts.requiredEntries ?? []).join("/")} 的目录`)
      }
      const missing = (opts.requiredEntries ?? []).filter((name) => !existsSync(join(abs, name)))
      if (missing.length) {
        throw new Error(`${opts.label}缺 ${missing.join("、")}：${abs}（来自${SOURCE_LABEL[source]}）——Remotion 在该目录内解析 compositor 与 ffmpeg，三件套必须齐全`)
      }
    }
    return { path: abs, source }
  }
  return { path: null, source: "none" }
}

/** 浏览器可执行文件：调用参数 > `GEBAI_REEL_CHROME_EXECUTABLE` > `.reel.json` 的 `browserExecutable`。 */
export function resolveBrowserExecutable(opts: { ctx: ToolContext; projectDir?: string | null; arg?: unknown }): ResolvedExternal {
  return resolveExternal({
    ...opts,
    envKey: BROWSER_EXECUTABLE_ENV,
    manifestField: "browserExecutable",
    label: "浏览器可执行文件",
    kind: "file",
  })
}

/** 原生二进制目录：调用参数 > `GEBAI_REEL_BINARIES_DIR` > `.reel.json` 的 `binariesDirectory`。 */
export function resolveBinariesDirectory(opts: { ctx: ToolContext; projectDir?: string | null; arg?: unknown }): ResolvedExternal {
  return resolveExternal({
    ...opts,
    envKey: BINARIES_DIR_ENV,
    manifestField: "binariesDirectory",
    label: "原生二进制目录",
    kind: "dir",
    requiredEntries: process.platform === "win32" ? ["remotion.exe", "ffmpeg.exe", "ffprobe.exe"] : ["remotion", "ffmpeg", "ffprobe"],
  })
}

// —— 浏览器就绪判定（复用 Remotion 的目录与版本规则） ——

/** Remotion 平台标识（与 `BrowserFetcher.getPlatform` 同规则）。 */
function platformTag(platform: string, arch: string): string {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64"
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux64"
  if (platform === "win32") return "win64"
  return `${platform}-${arch}`
}

/** Amazon Linux 2023 的 headless-shell 可执行名不同（与 Remotion 同判定）。 */
function isAmazonLinux2023(platform: string): boolean {
  if (platform !== "linux") return false
  try {
    const release = readFileSync("/etc/os-release", "utf8")
    return release.includes("Amazon Linux") && release.includes('VERSION="2023"')
  } catch {
    return false
  }
}

/** 形态子目录（Remotion 把两种 Chrome 分目录存放在 `.remotion/` 下）。 */
export function browserModeDir(cacheRoot: string, mode: ChromeMode): string {
  return join(cacheRoot, mode === "headless-shell" ? "chrome-headless-shell" : "chrome-for-testing")
}

/**
 * Remotion 在缓存根下期望的浏览器可执行文件路径：
 * `<缓存根>/<形态目录>/<平台>/<平台内层目录>/<可执行文件>`（与 `BrowserFetcher.getExecutablePath` 同规则）。
 */
export function expectedBrowserExecutablePath(opts: {
  cacheRoot: string
  mode: ChromeMode
  platform?: string
  arch?: string
  amazonLinux2023?: boolean
}): string {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const tag = platformTag(platform, arch)
  const folder = join(browserModeDir(opts.cacheRoot, opts.mode), tag)
  const amazon = opts.amazonLinux2023 ?? isAmazonLinux2023(platform)
  if (opts.mode === "chrome-for-testing") {
    if (tag === "mac-arm64" || tag === "mac-x64") return join(folder, `chrome-${tag}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
    if (tag === "win64") return join(folder, "chrome-win64", "chrome.exe")
    return join(folder, "chrome-linux64", "chrome")
  }
  const bin = tag === "win64" ? "chrome-headless-shell.exe" : tag === "linux-arm64" || amazon ? "headless_shell" : "chrome-headless-shell"
  return join(folder, `chrome-headless-shell-${tag}`, bin)
}

/** 该形态已安装的 Chrome 版本（Remotion 写在 `<缓存根>/<形态目录>/VERSION`；无则 null）。 */
export function readCachedChromeVersion(cacheRoot: string, mode: ChromeMode): string | null {
  try {
    return readFileSync(join(browserModeDir(cacheRoot, mode), "VERSION"), "utf8").trim() || null
  } catch {
    return null
  }
}

/**
 * 当前 Remotion 期望的 Chrome 版本（`TESTED_VERSION`）。读共享运行时内 renderer 包的同名常量，
 * 读不到返回 null（此时不做版本比对，只按可执行文件是否存在判定）。
 */
export function expectedChromeVersion(runtimeRoot: string | null | undefined): string | null {
  if (!runtimeRoot) return null
  const file = join(runtimeRoot, "node_modules", "@remotion", "renderer", "dist", "browser", "get-chrome-download-url.js")
  try {
    const m = /TESTED_VERSION\s*=\s*["']([^"']+)["']/.exec(readFileSync(file, "utf8"))
    return m?.[1] ?? null
  } catch {
    return null
  }
}

export interface BrowserReadiness {
  mode: ChromeMode
  /** true = 本机已有可用浏览器（配置的可执行文件或本地缓存），本次渲染不会触发联网下载。 */
  ready: boolean
  /** configured=用配置的可执行文件；local-cache=用本地缓存；none=无可用浏览器。 */
  source: "configured" | "local-cache" | "none"
  /** 可直接使用的可执行文件（配置的或缓存的）；无则 null。 */
  executablePath: string | null
  /** 缓存 VERSION 与当前 Remotion 期望版本不一致：仍直接可用，但如实报出。 */
  versionMismatch: boolean
  /** 命中缓存的根（`<起点>/node_modules/.remotion`）；未命中时为 Remotion 规则根。 */
  cacheRoot: string
  /** 该形态的缓存目录（`<缓存根>/<形态目录>`）。 */
  cacheDir: string
  installedVersion: string | null
  expectedVersion: string | null
  /** 人读结论（含"会发生什么"与修复动作）。 */
  note: string
}

/**
 * 就绪判定：配置的可执行文件存在 → 直接可用；否则在候选缓存根里找该形态的可执行文件。
 * **找到即可用，版本不一致也算**——Remotion 自行判定时对版本不一致的缓存会「先删掉再联网下载」，
 * 内网等于自毁一份可用的浏览器；故由调用方显式指定该可执行文件、跳过它的判定。
 * 只有真的没有可执行文件时才落到「首次渲染会联网下载」。
 */
export function browserReadiness(opts: {
  mode: ChromeMode
  browserExecutable?: string | null
  expectedVersion?: string | null
  /** 主缓存起点（默认进程 cwd，与 Remotion `getDownloadsCacheDir` 同规则；测试可注入）。 */
  cacheFrom?: string
  /** 补充起点（工程目录、共享运行时）：Remotion 自身不查这些位置，但本机已有即可直接继承。 */
  alsoFrom?: string[]
  platform?: string
  arch?: string
  amazonLinux2023?: boolean
}): BrowserReadiness {
  const expectedVersion = opts.expectedVersion ?? null
  const cacheRoots: string[] = []
  for (const from of [opts.cacheFrom ?? process.cwd(), ...(opts.alsoFrom ?? [])]) {
    const root = chromeCacheDir(from).dir
    if (!cacheRoots.includes(root)) cacheRoots.push(root)
  }
  const primaryRoot = cacheRoots[0] ?? join(opts.cacheFrom ?? process.cwd(), ".remotion")
  const executablePathOf = (cacheRoot: string): string =>
    expectedBrowserExecutablePath({
      cacheRoot,
      mode: opts.mode,
      platform: opts.platform,
      arch: opts.arch,
      amazonLinux2023: opts.amazonLinux2023,
    })
  if (opts.browserExecutable) {
    const exists = existsSync(opts.browserExecutable)
    return {
      mode: opts.mode,
      ready: exists,
      source: exists ? "configured" : "none",
      executablePath: exists ? opts.browserExecutable : null,
      versionMismatch: false,
      cacheRoot: primaryRoot,
      cacheDir: browserModeDir(primaryRoot, opts.mode),
      installedVersion: readCachedChromeVersion(primaryRoot, opts.mode),
      expectedVersion,
      note: exists
        ? `使用配置的浏览器（${opts.browserExecutable}），不查缓存、不下载`
        : `配置的浏览器路径不存在：${opts.browserExecutable}——渲染会直接失败，请修正 chrome_executable / ${BROWSER_EXECUTABLE_ENV}`,
    }
  }
  for (const cacheRoot of cacheRoots) {
    const executablePath = executablePathOf(cacheRoot)
    if (!existsSync(executablePath)) continue
    const installedVersion = readCachedChromeVersion(cacheRoot, opts.mode)
    const versionMismatch = installedVersion !== null && expectedVersion !== null && installedVersion !== expectedVersion
    return {
      mode: opts.mode,
      ready: true,
      source: "local-cache",
      executablePath,
      versionMismatch,
      cacheRoot,
      cacheDir: browserModeDir(cacheRoot, opts.mode),
      installedVersion,
      expectedVersion,
      note: versionMismatch
        ? `本地缓存可用但版本不一致（已装 ${installedVersion}，当前 Remotion 期望 ${expectedVersion}）：渲染直接指定该可执行文件、跳过联网下载；若浏览器启动报错，请配置 chrome_executable / ${BROWSER_EXECUTABLE_ENV} 指向匹配版本`
        : `本地缓存可用（${executablePath}${installedVersion ? ` · ${installedVersion}` : ""}）`,
    }
  }
  const cacheDir = browserModeDir(primaryRoot, opts.mode)
  const modeDirExists = existsSync(cacheDir)
  return {
    mode: opts.mode,
    ready: false,
    source: "none",
    executablePath: null,
    versionMismatch: false,
    cacheRoot: primaryRoot,
    cacheDir,
    installedVersion: readCachedChromeVersion(primaryRoot, opts.mode),
    expectedVersion,
    note: modeDirExists
      ? `缓存目录存在但缺 ${opts.mode} 可执行文件（${executablePathOf(primaryRoot)}）——首次渲染会联网下载；内网请配置浏览器可执行文件`
      : `本地无 ${opts.mode} 缓存（${cacheDir}）——首次渲染会联网下载；内网请配置浏览器可执行文件`,
  }
}
