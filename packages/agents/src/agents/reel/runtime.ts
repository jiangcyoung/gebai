/**
 * 原生渲染库运行时：从**视频项目自身**的 node_modules 动态 import `@remotion/renderer` + `@remotion/bundler`，
 * 进程内直连官方渲染库——参数直传、进度回调、浏览器与 bundle 跨调用复用（逐镜头出静帧从"每次冷启动"变为秒级发起）。
 *
 * 落地四条真机经验：`binariesDirectory` 默认不传（Remotion 用项目内 `@remotion/compositor-*` 包里的 compositor
 * 与 ffmpeg，预置一个只有 ffmpeg 的目录会让 compositor 查找失败）——仅当调用方显式配置了含三件套的目录时才传；
 * `chromiumOptions` 由调用方按渲染档传入（非 WebGL 内容不传 gl）；浏览器可执行文件由调用方决定
 * （见 `external.ts`：未配置时 Remotion 走“本地缓存 → 无则联网下载”；本机已有缓存时由调用方显式继承路径，
 * 跳过 Remotion 的缓存/下载判定——它对版本不一致的缓存会先删再下）；
 * 打包与浏览器是**两个可分别设时限的阶段**（`bundleProject` / `openSharedBrowser`，`prepareBundle` 为二者组合）；
 * Chrome 缓存位置按 Remotion 规则解析（`chromeCacheDir`）；项目经目录联接复用共享运行时，故整机只有一份 Remotion。
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolContext } from "@gebai/sdk"
import type { RenderProfile } from "./profile"
import { bundleCacheDir, stateDir } from "./paths"

/** 动态导入的第三方模块（结构最小化声明，避免对第三方类型产生编译期耦合）。 */
type NativeModule = Record<string, unknown>
type NativeFn = (...args: never[]) => unknown

export interface NativeBrowser {
  close(opts?: { silent?: boolean }): Promise<void>
}

export interface VideoConfig {
  id: string
  width: number
  height: number
  fps: number
  durationInFrames: number
  defaultProps?: Record<string, unknown>
}

export interface NativeLibs {
  /** 渲染库物理路径（realpath 归一：项目目录联接也指向同一份依赖）。 */
  rendererDir: string
  version: string
  bundle: (opts: Record<string, unknown>) => Promise<string>
  /** 注意：原生库的 `getCompositions` 是**位置参数 + 配置对象**（`(serveUrl, config?)`），与其余单对象 API 不同。 */
  getCompositions: (serveUrl: string, config?: Record<string, unknown>) => Promise<VideoConfig[]>
  selectComposition: (opts: Record<string, unknown>) => Promise<VideoConfig>
  renderStill: (opts: Record<string, unknown>) => Promise<unknown>
  renderMedia: (opts: Record<string, unknown>) => Promise<unknown>
  /** 打开浏览器；chromeMode/chromiumOptions/browserExecutable 由调用方传入（未指定可执行文件则按 Remotion 缓存/下载规则）。 */
  openBrowser: (opts: Record<string, unknown>) => Promise<NativeBrowser>
  ensureBrowser: (opts: Record<string, unknown>) => Promise<unknown>
  makeCancelSignal: () => { cancelSignal: unknown; cancel: () => void }
}

function fnOf(mod: NativeModule, name: string): NativeFn | null {
  const direct = mod[name]
  if (typeof direct === "function") return direct as NativeFn
  const fallback = (mod.default as NativeModule | undefined)?.[name]
  return typeof fallback === "function" ? (fallback as NativeFn) : null
}

/** 项目自身 node_modules 内的依赖包目录（经 realpath 归一，联接复用同一份运行时）。 */
function resolvePackageDir(projectDir: string, pkg: string): string | null {
  const candidate = join(projectDir, "node_modules", pkg)
  if (!existsSync(join(candidate, "package.json"))) return null
  try {
    return realpathSync(candidate)
  } catch {
    return candidate
  }
}

/** 依赖包入口文件：package.json 的 exports["."]/main 优先，其次常见 dist 布局。 */
function packageEntryFile(dir: string): string {
  let entry: string | null = null
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: unknown; main?: string }
    const ex = pkg.exports && typeof pkg.exports === "object" ? (pkg.exports as Record<string, unknown>)["."] : pkg.exports
    if (typeof ex === "string") entry = ex
    else if (ex && typeof ex === "object") {
      const obj = ex as Record<string, string>
      entry = obj.import ?? obj.module ?? obj.require ?? pkg.main ?? null
    } else entry = pkg.main ?? null
  } catch {
    entry = null
  }
  for (const rel of [entry, "dist/index.mjs", "dist/index.js", "index.mjs", "index.js"]) {
    if (!rel) continue
    const abs = isAbsolute(rel) ? rel : join(dir, rel)
    if (existsSync(abs)) return abs
  }
  throw new Error(`无法定位依赖包入口（${dir}）：package.json 的 exports/main 指向 ${entry ?? "空"}，安装可能不完整，请在项目内重装依赖`)
}

async function importModule(absFile: string): Promise<NativeModule> {
  return (await import(pathToFileURL(absFile).href)) as NativeModule
}

/**
 * 加载项目内的原生渲染库。缺依赖时给出明确修复动作，不做 CLI 降级——渲染链路唯一，
 * 避免"看起来成功实则走了另一条路"。
 */
export async function loadNativeLibs(projectDir: string): Promise<NativeLibs> {
  const rendererDir = resolvePackageDir(projectDir, "@remotion/renderer")
  const bundlerDir = resolvePackageDir(projectDir, "@remotion/bundler")
  if (!rendererDir || !bundlerDir) {
    const missing = !rendererDir ? "@remotion/renderer" : "@remotion/bundler"
    throw new Error(`项目 ${projectDir} 内未安装 Remotion（缺 ${missing}）：请先执行 reel_project action=install（或在项目目录内 npm install）后重试`)
  }
  const rendererMod = await importModule(packageEntryFile(rendererDir))
  const bundlerMod = await importModule(packageEntryFile(bundlerDir))

  const resolved = {
    renderStill: fnOf(rendererMod, "renderStill"),
    renderMedia: fnOf(rendererMod, "renderMedia"),
    getCompositions: fnOf(rendererMod, "getCompositions"),
    selectComposition: fnOf(rendererMod, "selectComposition"),
    openBrowser: fnOf(rendererMod, "openBrowser"),
    makeCancelSignal: fnOf(rendererMod, "makeCancelSignal"),
    bundle: fnOf(bundlerMod, "bundle"),
  }
  const missing = Object.entries(resolved)
    .filter(([, fn]) => !fn)
    .map(([name]) => name)
  if (missing.length) throw new Error(`项目内 Remotion 渲染库缺少导出：${missing.join("、")}（版本过旧或安装损坏，请在项目内重装依赖后重试）`)

  const nativeOpenBrowser = resolved.openBrowser as unknown as (browser: string, opts: Record<string, unknown>) => Promise<NativeBrowser>
  let version = "unknown"
  try {
    version = (JSON.parse(readFileSync(join(rendererDir, "package.json"), "utf8")) as { version?: string }).version ?? "unknown"
  } catch {
    version = "unknown"
  }

  return {
    rendererDir,
    version,
    bundle: resolved.bundle as NativeLibs["bundle"],
    getCompositions: resolved.getCompositions as NativeLibs["getCompositions"],
    selectComposition: resolved.selectComposition as NativeLibs["selectComposition"],
    renderStill: resolved.renderStill as NativeLibs["renderStill"],
    renderMedia: resolved.renderMedia as NativeLibs["renderMedia"],
    openBrowser: (opts) => nativeOpenBrowser("chrome", opts),
    ensureBrowser: (fnOf(rendererMod, "ensureBrowser") ?? (async () => undefined)) as NativeLibs["ensureBrowser"],
    makeCancelSignal: resolved.makeCancelSignal as NativeLibs["makeCancelSignal"],
  }
}

// —— 项目清单与入口点 ——

export interface ProjectManifest {
  /** 入口点相对路径（未设置时按常规候选探测）。 */
  entryPoint?: string
  /** 浏览器可执行文件（Chrome/Chromium 路径；未设置则按 Remotion 缓存/下载规则）。 */
  browserExecutable?: string
  /** 原生二进制目录（内含 remotion/ffmpeg/ffprobe；用于替换内置 ffmpeg，如带硬件编码器的构建）。 */
  binariesDirectory?: string
  source?: string
  templateSignature?: string
  createdAt?: string
}

export function readProjectManifest(projectDir: string): ProjectManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDir, ".reel.json"), "utf8")) as ProjectManifest
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function writeProjectManifest(projectDir: string, manifest: ProjectManifest): void {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, ".reel.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** 常规入口点候选（按序探测）。 */
const ENTRY_CANDIDATES = ["src/index.ts", "src/index.tsx", "src/index.jsx", "src/index.js", "remotion/index.ts", "src/remotion/index.ts"]
/** registerRoot 扫描目录。 */
const ENTRY_SCAN_DIRS = ["src", "remotion", "src/remotion", "src/film"]

/**
 * 入口点探测：项目清单（`.reel.json` 的 entryPoint）> 常规候选 > registerRoot 扫描。
 * 返回绝对路径；均未命中时抛错（错误信息给出修复动作）。
 */
export function detectEntryPoint(projectDir: string): string {
  const declared = readProjectManifest(projectDir)?.entryPoint?.trim()
  if (declared) {
    const abs = isAbsolute(declared) ? declared : join(projectDir, declared)
    if (existsSync(abs)) return abs
  }
  for (const rel of ENTRY_CANDIDATES) {
    const abs = join(projectDir, rel)
    if (existsSync(abs)) return abs
  }
  for (const rel of ENTRY_SCAN_DIRS) {
    const scanDir = join(projectDir, rel)
    if (!existsSync(scanDir)) continue
    for (const name of readdirSync(scanDir).sort()) {
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(name)) continue
      const file = join(scanDir, name)
      try {
        if (readFileSync(file, "utf8").includes("registerRoot(")) return file
      } catch {
        /* 忽略不可读文件 */
      }
    }
  }
  throw new Error(`未找到视频工程入口点（${projectDir}）：需含 src/index.ts 一类入口，或在 .reel.json 的 entryPoint 指定相对路径（用 reel_project action=init 生成标准工程）`)
}

// —— bundle 签名与持久化缓存 ——

/** 遍历统计目录（跳过依赖与产物目录），用于签名与体积汇报。 */
function walkFiles(dir: string, onFile: (abs: string, size: number, mtimeMs: number) => void): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names.sort()) {
    if (name === "node_modules" || name === ".remotion" || name === "out") continue
    const abs = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkFiles(abs, onFile)
      continue
    }
    onFile(abs, st.size, st.mtimeMs)
  }
}

/** bundle 缓存签名：`src/` 与 `public/` 各文件（路径 + 大小 + mtime）与模板签名的稳定哈希（源码一变即失效）。 */
export function sourceSignature(projectDir: string, templateSig: string): string {
  const hash = createHash("sha256")
  hash.update(`template:${templateSig}`)
  let files = 0
  for (const root of ["src", "public"]) {
    walkFiles(join(projectDir, root), (abs, size, mtimeMs) => {
      hash.update(`${relative(projectDir, abs)}:${size}:${Math.round(mtimeMs)}`)
      files++
    })
  }
  return `${hash.digest("hex").slice(0, 16)}-${files}`
}

/** 清理过旧的持久化 bundle（保留最近 keep 份，按 mtime）。 */
function pruneBundles(ctx: ToolContext, keep: number): void {
  const dir = join(stateDir(ctx), "bundles")
  if (!existsSync(dir)) return
  const entries = readdirSync(dir)
    .map((name) => ({ abs: join(dir, name), mtime: mtimeOf(join(dir, name)) }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const stale of entries.slice(keep)) rmSync(stale.abs, { recursive: true, force: true })
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

// —— 热浏览器池 ——

/** 空闲回收阈值（10 分钟）：同键浏览器复用，空闲超时即关闭释放内存与 Chrome 进程。 */
const BROWSER_IDLE_MS = 10 * 60 * 1000
const browserPool = new Map<string, { browser: NativeBrowser; lastUsed: number }>()

function closeQuietly(browser: NativeBrowser): void {
  try {
    void browser.close({ silent: true }).catch(() => undefined)
  } catch {
    /* 浏览器可能已退出 */
  }
}

function reapIdleBrowsers(now: number): void {
  for (const [key, entry] of browserPool) {
    if (now - entry.lastUsed < BROWSER_IDLE_MS) continue
    browserPool.delete(key)
    closeQuietly(entry.browser)
  }
}

/**
 * 打开一个**独立**浏览器（不进热池）：分片并行渲染每片要一个自己的浏览器进程，
 * 池化会复用同一个而失去并行。用完由调用方关闭。
 * chromiumOptions 按渲染档传入（gl 由档位决策/实测调优给出，未指定则不传、由 Chrome 自选后端）。
 */
export async function openDetachedBrowser(opts: {
  libs: NativeLibs
  profile: RenderProfile
  /** 浏览器可执行文件绝对路径；null = 交给 Remotion（本地缓存优先，缺失则下载）。 */
  browserExecutable: string | null
  onDownloadProgress?: (percent: number) => void
}): Promise<NativeBrowser> {
  return opts.libs.openBrowser({
    chromeMode: opts.profile.chromeMode,
    chromiumOptions: opts.profile.gl ? { gl: opts.profile.gl } : {},
    ...(opts.browserExecutable ? { browserExecutable: opts.browserExecutable } : {}),
    logLevel: "error",
    onBrowserDownload: () => ({
      onProgress: ({ percent }: { percent?: number }) => opts.onDownloadProgress?.(percent ?? 0),
    }),
  })
}

/**
 * 取热浏览器：按 `${项目}|${chromeMode}|${gl ?? "default"}|${可执行文件 ?? "auto"}` 复用，空闲超时回收后重建。
 * 与打包分离（档位 gl/chromeMode 换档只需换浏览器，bundle 与档位无关可继续复用），调用方也因此能
 * 给「浏览器阶段」单独设时限与失败提示。
 */
export async function openSharedBrowser(opts: {
  libs: NativeLibs
  projectDir: string
  profile: RenderProfile
  /** 浏览器可执行文件绝对路径；null = 交给 Remotion（本地缓存优先，缺失则下载）。 */
  browserExecutable: string | null
  onLog: (line: string) => void
  onDownloadProgress?: (percent: number) => void
}): Promise<NativeBrowser> {
  const key = `${opts.projectDir}|${opts.profile.chromeMode}|${opts.profile.gl ?? "default"}|${opts.browserExecutable ?? "auto"}`
  const now = Date.now()
  const existing = browserPool.get(key)
  if (existing) {
    if (now - existing.lastUsed < BROWSER_IDLE_MS) {
      existing.lastUsed = now
      return existing.browser
    }
    browserPool.delete(key)
    closeQuietly(existing.browser)
  }
  reapIdleBrowsers(now)
  opts.onLog(
    `启动 Chrome（${opts.profile.chromeMode}${opts.profile.gl ? `，gl=${opts.profile.gl}` : ""}${opts.browserExecutable ? `，可执行文件 ${opts.browserExecutable}` : ""}）`,
  )
  const browser = await openDetachedBrowser({
    libs: opts.libs,
    profile: opts.profile,
    browserExecutable: opts.browserExecutable,
    onDownloadProgress: opts.onDownloadProgress,
  })
  browserPool.set(key, { browser, lastUsed: Date.now() })
  return browser
}

export interface PrepareBundleArgs {
  ctx: ToolContext
  libs: NativeLibs
  projectDir: string
  entryPoint: string
  profile: RenderProfile
  /** 浏览器可执行文件绝对路径；null/缺省 = 交给 Remotion 的缓存与下载规则。 */
  browserExecutable?: string | null
  onLog: (line: string) => void
  onBundleProgress?: (percent: number) => void
  onDownloadProgress?: (percent: number) => void
}

export interface BundleProjectArgs {
  ctx: ToolContext
  libs: NativeLibs
  projectDir: string
  entryPoint: string
  onLog: (line: string) => void
  onBundleProgress?: (percent: number) => void
}

/**
 * 打包工程到持久化缓存（签名命中即复用，跨进程）；只做打包，不碰浏览器。
 * 签名由 `src/`+`public/` 的文件（路径/大小/mtime）与模板签名哈希而成——源码一变即失效重打。
 */
export async function bundleProject(args: BundleProjectArgs): Promise<{ serveUrl: string; bundleCached: boolean; bundleMs: number }> {
  const templateSig = readProjectManifest(args.projectDir)?.templateSignature ?? ""
  const signature = sourceSignature(args.projectDir, templateSig)
  const outDir = bundleCacheDir(args.ctx, signature)
  if (existsSync(join(outDir, "index.html"))) {
    args.onLog(`复用已打包产物（跨进程持久化，签名 ${signature}）：${outDir}`)
    touch(outDir)
    return { serveUrl: outDir, bundleCached: true, bundleMs: 0 }
  }

  const publicDir = join(args.projectDir, "public")
  args.onLog(`打包工程（签名 ${signature}）→ ${outDir}`)
  const started = Date.now()
  const serveUrl = await args.libs.bundle({
    entryPoint: args.entryPoint,
    rootDir: args.projectDir,
    outDir,
    publicDir: existsSync(publicDir) ? publicDir : null,
    onProgress: (percent: number) => args.onBundleProgress?.(percent),
    onPublicDirCopyProgress: (bytes: number) => args.onLog(`复制 public/：${(bytes / 1024 / 1024).toFixed(1)}MB`),
    enableCaching: true,
  })
  pruneBundles(args.ctx, 2)
  const bundleMs = Date.now() - started
  args.onLog(`打包完成：${bundleMs}ms → ${serveUrl}`)
  return { serveUrl, bundleCached: false, bundleMs }
}

/**
 * 就绪 bundle 与热浏览器：`bundleProject` + `openSharedBrowser` 的组合（两步各有自己的时限与报错时用那两个）。
 */
export async function prepareBundle(args: PrepareBundleArgs): Promise<{ serveUrl: string; browser: NativeBrowser; bundleCached: boolean; bundleMs: number }> {
  const bundled = await bundleProject({
    ctx: args.ctx,
    libs: args.libs,
    projectDir: args.projectDir,
    entryPoint: args.entryPoint,
    onLog: args.onLog,
    onBundleProgress: args.onBundleProgress,
  })
  const browser = await openSharedBrowser({
    libs: args.libs,
    projectDir: args.projectDir,
    profile: args.profile,
    browserExecutable: args.browserExecutable ?? null,
    onLog: args.onLog,
    onDownloadProgress: args.onDownloadProgress,
  })
  return { ...bundled, browser }
}

function touch(path: string): void {
  try {
    const now = new Date()
    utimesSync(path, now, now)
  } catch {
    /* 续期失败不影响复用 */
  }
}

// —— 合成解析 ——

const compositionCache = new Map<string, VideoConfig>()

function chromiumOptionsOf(profile: RenderProfile): Record<string, unknown> {
  return profile.gl ? { gl: profile.gl } : {}
}

/** 合成定义（serveUrl + 合成 id + props 组合内存缓存）。 */
export async function resolveComposition(opts: {
  libs: NativeLibs
  serveUrl: string
  compositionId: string
  inputProps: Record<string, unknown>
  profile: RenderProfile
  browser: NativeBrowser
}): Promise<VideoConfig> {
  const key = `${opts.serveUrl}|${opts.compositionId}|${JSON.stringify(opts.inputProps)}`
  const cached = compositionCache.get(key)
  if (cached) return cached
  const config = await opts.libs.selectComposition({
    serveUrl: opts.serveUrl,
    id: opts.compositionId,
    inputProps: opts.inputProps,
    puppeteerInstance: opts.browser,
    chromeMode: opts.profile.chromeMode,
    chromiumOptions: chromiumOptionsOf(opts.profile),
    logLevel: "error",
  })
  compositionCache.set(key, config)
  return config
}

/** 列出项目内全部合成。 */
export async function listCompositions(opts: {
  libs: NativeLibs
  serveUrl: string
  profile: RenderProfile
  browser: NativeBrowser
}): Promise<VideoConfig[]> {
  return opts.libs.getCompositions(opts.serveUrl, {
    inputProps: {},
    puppeteerInstance: opts.browser,
    chromeMode: opts.profile.chromeMode,
    chromiumOptions: chromiumOptionsOf(opts.profile),
    logLevel: "error",
  })
}

/**
 * Chrome 缓存目录与目录体积统计：实现归探测层（`detect.ts`），此处原样转发——
 * 调用方（setup/project）从本模块取用即可，全包只有一份实现。
 */
export { chromeCacheDir, dirStats } from "./detect"
