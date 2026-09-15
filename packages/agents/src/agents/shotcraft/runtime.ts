/**
 * shotcraft 原生渲染运行时：进程内直连官方原生渲染库（`@remotion/renderer` + `@remotion/bundler`，
 * 内含 Rust 原生 compositor 与内置 ffmpeg 原生二进制），不经 CLI 外壳——参数直传、进度回调、
 * cancelSignal 中止、bundle 与浏览器实例跨调用复用（逐镜头出静帧的迭代从"每次冷启动"变为秒级发起）。
 *
 * 库从**视频项目自身的 node_modules** 解析导入（项目经目录联接复用共享运行时，故整机只有一份 Remotion）。
 * bundle 产物按内容签名持久化在库根 state/ 下，进程重启后仍可复用。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import type { ChromeMode, GlOption, RenderProfile } from "./profile"

/** 动态导入的原生库模块（结构最小化声明，避免对第三方类型产生编译期耦合）。 */
type NativeModule = Record<string, unknown>

export interface VideoConfig {
  id: string
  width: number
  height: number
  fps: number
  durationInFrames: number
  props?: Record<string, unknown>
  defaultProps?: Record<string, unknown>
}

export interface NativeBrowser {
  close(opts?: { silent?: boolean }): Promise<void>
}

export interface NativeLibs {
  /** 渲染库目录（@remotion/renderer 物理路径，Chrome/ffmpeg 落点即其所属 node_modules）。 */
  rendererDir: string
  version: string | null
  renderStill: (opts: Record<string, unknown>) => Promise<unknown>
  renderMedia: (opts: Record<string, unknown>) => Promise<unknown>
  getCompositions: (opts: Record<string, unknown>) => Promise<VideoConfig[]>
  selectComposition: (opts: Record<string, unknown>) => Promise<VideoConfig>
  openBrowser: (browser: string, opts?: Record<string, unknown>) => Promise<NativeBrowser>
  ensureBrowser: (opts?: Record<string, unknown>) => Promise<void>
  makeCancelSignal: () => { cancelSignal: unknown; cancel: () => void }
  bundle: (opts: Record<string, unknown>) => Promise<string>
}

function fnOf(mod: NativeModule, name: string): ((...args: never[]) => unknown) | null {
  const direct = mod[name]
  if (typeof direct === "function") return direct as (...args: never[]) => unknown
  const fallback = (mod.default as NativeModule | undefined)?.[name]
  return typeof fallback === "function" ? (fallback as (...args: never[]) => unknown) : null
}

/** 解析依赖包物理目录（经 realpath 归一，联接复用同一份运行时）。 */
function resolvePackageDir(projectDir: string, pkg: string): string | null {
  let dir = projectDir
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "node_modules", pkg)
    if (existsSync(join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate)
      } catch {
        return candidate
      }
    }
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 包入口解析（exports["."] 的 import/module/require 或 main）。 */
function packageEntry(dir: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    exports?: Record<string, unknown> | string
    main?: string
  }
  const ex = typeof pkg.exports === "object" && pkg.exports ? (pkg.exports["."] as unknown) : pkg.exports
  if (typeof ex === "string") return ex
  if (ex && typeof ex === "object") {
    const obj = ex as Record<string, string>
    return obj.import ?? obj.module ?? obj.require ?? pkg.main ?? "index.js"
  }
  return pkg.main ?? "index.js"
}

async function importModule(absFile: string): Promise<NativeModule> {
  return (await import(pathToFileURL(absFile).href)) as NativeModule
}

/**
 * 加载项目内的原生渲染库。缺依赖时给出明确修复动作（project install），不做静默降级——
 * 渲染链路唯一，避免"看起来成功实则走了另一条路"。
 */
export async function loadNativeLibs(projectDir: string): Promise<NativeLibs> {
  const rendererDir = resolvePackageDir(projectDir, "@remotion/renderer")
  const bundlerDir = resolvePackageDir(projectDir, "@remotion/bundler")
  if (!rendererDir || !bundlerDir) {
    throw new Error(
      `项目 ${projectDir} 未安装 Remotion（缺 ${!rendererDir ? "@remotion/renderer" : "@remotion/bundler"}）。请先执行 project action=install（或在该项目内 npm install）后重试。`,
    )
  }
  const rendererMod = await importModule(join(rendererDir, packageEntry(rendererDir)))
  const bundlerMod = await importModule(join(bundlerDir, packageEntry(bundlerDir)))

  const renderStill = fnOf(rendererMod, "renderStill")
  const renderMedia = fnOf(rendererMod, "renderMedia")
  const getCompositions = fnOf(rendererMod, "getCompositions")
  const selectComposition = fnOf(rendererMod, "selectComposition")
  const openBrowser = fnOf(rendererMod, "openBrowser")
  const ensureBrowser = fnOf(rendererMod, "ensureBrowser")
  const makeCancelSignal = fnOf(rendererMod, "makeCancelSignal")
  const bundle = fnOf(bundlerMod, "bundle")
  const missing = [
    ["renderStill", renderStill],
    ["renderMedia", renderMedia],
    ["getCompositions", getCompositions],
    ["selectComposition", selectComposition],
    ["openBrowser", openBrowser],
    ["makeCancelSignal", makeCancelSignal],
    ["bundle", bundle],
  ].filter(([, fn]) => !fn).map(([name]) => name as string)
  if (missing.length) throw new Error(`项目内 Remotion 渲染库缺少导出：${missing.join(", ")}（版本过旧或安装损坏，请重装依赖）`)

  let version: string | null = null
  try {
    version = (JSON.parse(readFileSync(join(rendererDir, "package.json"), "utf8")) as { version?: string }).version ?? null
  } catch {
    version = null
  }

  return {
    rendererDir,
    version,
    renderStill: renderStill as NativeLibs["renderStill"],
    renderMedia: renderMedia as NativeLibs["renderMedia"],
    getCompositions: getCompositions as NativeLibs["getCompositions"],
    selectComposition: selectComposition as NativeLibs["selectComposition"],
    openBrowser: openBrowser as NativeLibs["openBrowser"],
    ensureBrowser: (ensureBrowser ?? (async () => {})) as NativeLibs["ensureBrowser"],
    makeCancelSignal: makeCancelSignal as NativeLibs["makeCancelSignal"],
    bundle: bundle as NativeLibs["bundle"],
  }
}

/** 项目入口点探测：`.shotcraft.json` 记录 > 常规候选 > 含 registerRoot 的文件。 */
const ENTRY_CANDIDATES = ["src/index.ts", "src/index.tsx", "src/index.jsx", "src/index.js", "remotion/index.ts", "src/remotion/index.ts"]
export function detectEntryPoint(projectDir: string): string | null {
  const manifest = readProjectManifest(projectDir)
  if (manifest?.entryPoint && existsSync(join(projectDir, manifest.entryPoint))) return join(projectDir, manifest.entryPoint)
  for (const rel of ENTRY_CANDIDATES) {
    const abs = join(projectDir, rel)
    if (existsSync(abs)) return abs
  }
  for (const rel of ENTRY_CANDIDATES.map((c) => c.split("/").slice(0, -1).join("/"))) {
    const dir = join(projectDir, rel)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(name)) continue
      const file = join(dir, name)
      try {
        if (readFileSync(file, "utf8").includes("registerRoot(")) return file
      } catch {
        /* 忽略不可读文件 */
      }
    }
  }
  return null
}

export interface ProjectManifest {
  entryPoint?: string
  templateSignature?: string
  skillRevision?: string
  createdAt?: string
  source?: string
}

export function readProjectManifest(projectDir: string): ProjectManifest | null {
  try {
    return JSON.parse(readFileSync(join(projectDir, ".shotcraft.json"), "utf8")) as ProjectManifest
  } catch {
    return null
  }
}

/** 项目内容签名：源码/公共资源/配置的文件名 + 大小 + mtime（源码一变即失效，否则复用持久化 bundle）。 */
export function projectSourceSignature(projectDir: string): string {
  const hash = createHash("sha256")
  const roots = ["src", "public"]
  let files = 0
  const walk = (dir: string) => {
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
        walk(abs)
        continue
      }
      hash.update(`${relative(projectDir, abs)}:${st.size}:${st.mtimeMs}`)
      files++
    }
  }
  for (const root of roots) walk(join(projectDir, root))
  for (const cfg of ["package.json", "remotion.config.ts", "tsconfig.json"]) {
    const abs = join(projectDir, cfg)
    if (!existsSync(abs)) continue
    const st = statSync(abs)
    hash.update(`${cfg}:${st.size}:${st.mtimeMs}`)
  }
  return `${hash.digest("hex").slice(0, 16)}-${files}`
}

export interface BundleResult {
  serveUrl: string
  signature: string
  cached: boolean
  ms: number
  /** 本次新产出的 bundle 目录（供清理/汇报）。 */
  outDir: string
}

const memoryBundles = new Map<string, { serveUrl: string; signature: string }>()

/** 确保 bundle 就绪：内存命中 → 磁盘签名命中 → 重新打包（写库根 state/bundles/<签名>，跨进程复用）。 */
export async function ensureBundle(opts: {
  projectDir: string
  libs: NativeLibs
  stateRoot: string
  entryPoint: string
  force?: boolean
  onProgress?: (percent: number) => void
  onLog?: (line: string) => void
}): Promise<BundleResult> {
  const started = Date.now()
  const signature = projectSourceSignature(opts.projectDir)
  const persistent = join(opts.stateRoot, "state", "bundles", signature)
  const mem = memoryBundles.get(opts.projectDir)
  if (!opts.force && mem && mem.signature === signature && existsSync(join(mem.serveUrl, "index.html"))) {
    return { serveUrl: mem.serveUrl, signature, cached: true, ms: Date.now() - started, outDir: mem.serveUrl }
  }
  if (!opts.force && existsSync(join(persistent, "index.html"))) {
    memoryBundles.set(opts.projectDir, { serveUrl: persistent, signature })
    opts.onLog?.(`复用已打包产物（跨进程持久化）：${persistent}`)
    return { serveUrl: persistent, signature, cached: true, ms: Date.now() - started, outDir: persistent }
  }
  const publicDir = join(opts.projectDir, "public")
  opts.onLog?.(`打包项目（${signature}）…`)
  const serveUrl = await opts.libs.bundle({
    entryPoint: opts.entryPoint,
    rootDir: opts.projectDir,
    outDir: persistent,
    publicDir: existsSync(publicDir) ? publicDir : null,
    onProgress: (percent: number) => opts.onProgress?.(percent),
    onPublicDirCopyProgress: (bytes: number) => opts.onLog?.(`复制 public/：${(bytes / 1024 / 1024).toFixed(1)}MB`),
    enableCaching: true,
  })
  memoryBundles.set(opts.projectDir, { serveUrl, signature })
  pruneBundles(opts.stateRoot, 2)
  return { serveUrl, signature, cached: false, ms: Date.now() - started, outDir: serveUrl }
}

/** 清理过旧的持久化 bundle（保留最近 N 份）。 */
export function pruneBundles(stateRoot: string, keep: number): void {
  const dir = join(stateRoot, "state", "bundles")
  if (!existsSync(dir)) return
  const entries = readdirSync(dir)
    .map((name) => ({ name, abs: join(dir, name) }))
    .map((e) => {
      try {
        return { ...e, mtime: statSync(e.abs).mtimeMs }
      } catch {
        return { ...e, mtime: 0 }
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
  for (const stale of entries.slice(keep)) rmSync(stale.abs, { recursive: true, force: true })
}

interface PoolEntry {
  browser: NativeBrowser
  key: string
  lastUsed: number
}

const browserPool = new Map<string, PoolEntry>()

/** 热浏览器：同（项目/Chrome 模式/GL 后端）复用实例，避免每次渲染重启 Chrome。 */
export async function acquireBrowser(opts: {
  libs: NativeLibs
  projectDir: string
  chromeMode: ChromeMode
  gl: GlOption | null
  onLog?: (line: string) => void
  onDownloadProgress?: (percent: number) => void
}): Promise<NativeBrowser> {
  const key = `${opts.projectDir}|${opts.chromeMode}|${opts.gl ?? "default"}`
  const existing = browserPool.get(key)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.browser
  }
  await reapIdleBrowsers()
  opts.onLog?.(`启动 Chrome（${opts.chromeMode}${opts.gl ? `，gl=${opts.gl}` : ""}）`)
  const browser = await opts.libs.openBrowser("chrome", {
    chromeMode: opts.chromeMode,
    chromiumOptions: opts.gl ? { gl: opts.gl } : {},
    logLevel: "error",
    onBrowserDownload: () => ({
      onProgress: ({ percent }: { percent: number }) => opts.onDownloadProgress?.(percent),
    }),
  })
  browserPool.set(key, { browser, key, lastUsed: Date.now() })
  return browser
}

/** 回收空闲浏览器（默认 10 分钟），释放内存与 Chrome 进程。 */
export async function reapIdleBrowsers(maxIdleMs = 10 * 60 * 1000): Promise<number> {
  const now = Date.now()
  let closed = 0
  for (const [key, entry] of browserPool) {
    if (now - entry.lastUsed < maxIdleMs) continue
    browserPool.delete(key)
    try {
      await entry.browser.close({ silent: true })
      closed++
    } catch {
      /* 浏览器可能已退出 */
    }
  }
  return closed
}

/** 合成配置解析（内存缓存：serveUrl + 合成 id + props 组合）。 */
const compositionCache = new Map<string, VideoConfig>()

export async function resolveComposition(opts: {
  libs: NativeLibs
  serveUrl: string
  compositionId: string
  inputProps: Record<string, unknown>
  profile: RenderProfile
  browser: NativeBrowser
}): Promise<VideoConfig> {
  const key = `${opts.serveUrl}|${opts.compositionId}|${createHash("sha256").update(JSON.stringify(opts.inputProps)).digest("hex").slice(0, 8)}`
  const cached = compositionCache.get(key)
  if (cached) return cached
  const config = await opts.libs.selectComposition({
    serveUrl: opts.serveUrl,
    id: opts.compositionId,
    inputProps: opts.inputProps,
    puppeteerInstance: opts.browser,
    chromeMode: opts.profile.chromeMode,
    chromiumOptions: opts.profile.gl ? { gl: opts.profile.gl } : {},
    logLevel: "error",
  })
  compositionCache.set(key, config)
  return config
}

/** 列出合成（未打包时按需打包）。 */
export async function listCompositions(opts: {
  libs: NativeLibs
  serveUrl: string
  profile: RenderProfile
  browser: NativeBrowser
}): Promise<VideoConfig[]> {
  return opts.libs.getCompositions({
    serveUrl: opts.serveUrl,
    inputProps: {},
    puppeteerInstance: opts.browser,
    chromeMode: opts.profile.chromeMode,
    chromiumOptions: opts.profile.gl ? { gl: opts.profile.gl } : {},
    logLevel: "error",
  })
}

/** 进程 cwd 下的 Chrome 缓存目录（与 Remotion `getDownloadsCacheDir` 同规则：自 cwd 向上取最近含
 *  package.json 的目录 → 其 `node_modules/.remotion`；无则 `cwd/.remotion`）。Chrome 由 Remotion 自行下载并存于此，
 *  同一实例的多个视频项目共用一份（原生 compositor 与 ffmpeg 取自项目内 `@remotion/compositor-*` 包，无需重复下载）。 */
export function remotionCacheDir(): { dir: string; exists: boolean } {
  let dir: string | undefined = process.cwd()
  for (;;) {
    try {
      if (statSync(join(dir, "package.json")).isFile()) break
    } catch {
      /* 继续向上 */
    }
    const parent = join(dir, "..")
    if (parent === dir) {
      dir = undefined
      break
    }
    dir = parent
  }
  if (!dir) return { dir: join(process.cwd(), ".remotion"), exists: false }
  const cache = join(dir, "node_modules", ".remotion")
  return { dir: cache, exists: existsSync(cache) }
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
