/** runtime.ts 测试：原生库解析 / 入口点探测 / 清单 / bundle 签名与缓存命中 / 浏览器复用 / Chrome 缓存目录 / 目录统计。 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { bundleCacheDir, stateDir } from "./paths"
import type { RenderProfile } from "./profile"
import {
  chromeCacheDir,
  detectEntryPoint,
  dirStats,
  listCompositions,
  loadNativeLibs,
  prepareBundle,
  readProjectManifest,
  resolveComposition,
  sourceSignature,
  writeProjectManifest,
} from "./runtime"
import { clearReelEnv, makeCtx } from "./test-ctx"

const roots: string[] = []
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
const tempProject = () => tempRoot("reel-proj-")

beforeAll(() => clearReelEnv())
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

// —— 假原生库（真实文件 + ESM 动态 import，不联网、无 GPU） ——

const RENDERER_MOD = `export const calls = []
export async function renderStill(o) { calls.push(["renderStill", o]); return { ok: true } }
export async function renderMedia(o) { calls.push(["renderMedia", o]); return { ok: true } }
export async function getCompositions(serveUrl, config) { calls.push(["getCompositions", serveUrl, config]); return [{ id: "Reel", width: 1920, height: 1080, fps: 30, durationInFrames: 120 }] }
export async function selectComposition(o) { calls.push(["selectComposition", o]); return { id: o.id, width: 1920, height: 1080, fps: 30, durationInFrames: 120, defaultProps: {} } }
export async function openBrowser(browser, opts) { calls.push(["openBrowser", browser, opts]); return { close: async (o) => { calls.push(["close", o]) } } }
export async function ensureBrowser(o) { calls.push(["ensureBrowser", o]) }
export function makeCancelSignal() { return { cancelSignal: {}, cancel: () => {} } }
`

const BUNDLER_MOD = `export const calls = []
export async function bundle(o) {
  calls.push(["bundle", o])
  const fs = await import("node:fs")
  fs.mkdirSync(o.outDir, { recursive: true })
  fs.writeFileSync(o.outDir + "/index.html", "<!doctype html>")
  return o.outDir
}
`

function installFakeRemotion(projectDir: string, rendererSource: string = RENDERER_MOD): { rendererFile: string; bundlerFile: string } {
  const nm = join(projectDir, "node_modules")
  const rendererDir = join(nm, "@remotion", "renderer")
  const bundlerDir = join(nm, "@remotion", "bundler")
  mkdirSync(join(rendererDir, "dist"), { recursive: true })
  mkdirSync(join(bundlerDir, "dist"), { recursive: true })
  const pkg = (name: string) => `${JSON.stringify({ name, version: "4.0.484", exports: { ".": { import: "./dist/index.mjs" } } }, null, 2)}\n`
  writeFileSync(join(rendererDir, "package.json"), pkg("@remotion/renderer"))
  writeFileSync(join(rendererDir, "dist", "index.mjs"), rendererSource)
  writeFileSync(join(bundlerDir, "package.json"), pkg("@remotion/bundler"))
  writeFileSync(join(bundlerDir, "dist", "index.mjs"), BUNDLER_MOD)
  return { rendererFile: join(rendererDir, "dist", "index.mjs"), bundlerFile: join(bundlerDir, "dist", "index.mjs") }
}

/** 假原生库模块（与 loadNativeLibs 解析到的同一模块实例，可直接读它的调用记录）。 */
async function fakeCalls(file: string): Promise<unknown[][]> {
  const mod = (await import(pathToFileURL(realpathSync(file)).href)) as { calls: unknown[][] }
  return mod.calls
}

function writeEntry(projectDir: string, rel = "src/index.ts"): string {
  const abs = join(projectDir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `import { registerRoot } from "remotion"\nregisterRoot(Root)\n`)
  return abs
}

function profileOf(overrides: Partial<RenderProfile> = {}): RenderProfile {
  return {
    concurrency: 4,
    gl: null,
    chromeMode: "headless-shell",
    hardwareAcceleration: "disable",
    videoBitrate: null,
    crf: null,
    reasons: [],
    unavailable: [],
    source: { concurrency: "auto", hardware: "auto" },
    ...overrides,
  }
}

// —— 原生库加载 ——

test("loadNativeLibs 从项目自身 node_modules 动态导入，并把 openBrowser 归一为 chrome", async () => {
  const projectDir = tempProject()
  const files = installFakeRemotion(projectDir)
  const libs = await loadNativeLibs(projectDir)

  expect(libs.version).toBe("4.0.484")
  expect(libs.rendererDir).toBe(realpathSync(join(projectDir, "node_modules", "@remotion", "renderer")))
  expect(typeof libs.bundle).toBe("function")
  expect(typeof libs.renderStill).toBe("function")
  expect(typeof libs.renderMedia).toBe("function")
  expect(typeof libs.getCompositions).toBe("function")
  expect(typeof libs.selectComposition).toBe("function")
  expect(typeof libs.ensureBrowser).toBe("function")
  expect(libs.makeCancelSignal().cancel).toBeTypeOf("function")

  const browser = await libs.openBrowser({ chromeMode: "headless-shell", chromiumOptions: {} })
  const calls = await fakeCalls(files.rendererFile)
  expect(calls.at(-1)).toEqual(["openBrowser", "chrome", { chromeMode: "headless-shell", chromiumOptions: {} }])
  await browser.close({ silent: true })
  expect((await fakeCalls(files.rendererFile)).at(-1)).toEqual(["close", { silent: true }])
})

test("loadNativeLibs：缺依赖 / 缺导出都给出可操作报错（不做 CLI 降级）", async () => {
  const bare = tempProject()
  await expect(loadNativeLibs(bare)).rejects.toThrow(/reel_project action=install/)

  const projectDir = tempProject()
  installFakeRemotion(projectDir, `export async function renderStill() {}\nexport async function bundle() {}\n`)
  await expect(loadNativeLibs(projectDir)).rejects.toThrow(/缺少导出：renderMedia/)
})

// —— 入口点与清单 ——

test("入口点探测：清单 > 常规候选 > registerRoot 扫描；均未命中则报错", () => {
  const projectDir = tempProject()
  const fallback = writeEntry(projectDir)

  // 清单指向不存在的文件 → 回落常规候选
  writeProjectManifest(projectDir, { entryPoint: "custom/entry.ts" })
  expect(detectEntryPoint(projectDir)).toBe(fallback)

  // 清单命中优先
  const custom = writeEntry(projectDir, "custom/entry.ts")
  expect(detectEntryPoint(projectDir)).toBe(custom)

  // 无清单、无常规候选 → registerRoot 扫描（目录内按名字排序）
  const scanned = tempProject()
  mkdirSync(join(scanned, "src"), { recursive: true })
  writeFileSync(join(scanned, "src", "Opener.tsx"), `import { registerRoot } from "remotion"\nregisterRoot(Root)\n`)
  writeFileSync(join(scanned, "src", "helpers.ts"), "export const x = 1\n")
  expect(detectEntryPoint(scanned)).toBe(join(scanned, "src", "Opener.tsx"))

  // 都没有 → 明确报错
  expect(() => detectEntryPoint(tempProject())).toThrow(/未找到视频工程入口点/)
})

test("项目清单读写：缺失/损坏返回 null，写入后可读回", () => {
  const projectDir = tempProject()
  expect(readProjectManifest(projectDir)).toBeNull()
  writeProjectManifest(projectDir, { entryPoint: "src/index.ts", source: "template", templateSignature: "sig-1", createdAt: "2024-01-01T00:00:00.000Z" })
  expect(readProjectManifest(projectDir)).toEqual({
    entryPoint: "src/index.ts",
    source: "template",
    templateSignature: "sig-1",
    createdAt: "2024-01-01T00:00:00.000Z",
  })
  writeFileSync(join(projectDir, ".reel.json"), "{ 坏 JSON")
  expect(readProjectManifest(projectDir)).toBeNull()
})

// —— bundle 签名与缓存 ——

test("bundle 签名随源码/模板签名变化，未变化则稳定", () => {
  const projectDir = tempProject()
  mkdirSync(join(projectDir, "src"), { recursive: true })
  writeFileSync(join(projectDir, "src", "a.ts"), "a")
  const s1 = sourceSignature(projectDir, "tpl-1")
  expect(sourceSignature(projectDir, "tpl-1")).toBe(s1)

  writeFileSync(join(projectDir, "src", "a.ts"), "abcdefgh")
  const s2 = sourceSignature(projectDir, "tpl-1")
  expect(s2).not.toBe(s1)

  expect(sourceSignature(projectDir, "tpl-2")).not.toBe(s2)

  const s3 = sourceSignature(projectDir, "tpl-2")
  mkdirSync(join(projectDir, "public"), { recursive: true })
  writeFileSync(join(projectDir, "public", "bg.png"), "png")
  expect(sourceSignature(projectDir, "tpl-2")).not.toBe(s3)
})

test("prepareBundle：首次打包 → 二次命中持久化缓存（bundleMs=0），浏览器热复用", async () => {
  const home = tempRoot("reel-home-")
  const { ctx } = makeCtx(home)
  const projectDir = tempProject()
  const entryPoint = writeEntry(projectDir)
  writeProjectManifest(projectDir, { entryPoint: "src/index.ts", templateSignature: "tpl-x" })
  const files = installFakeRemotion(projectDir)
  const libs = await loadNativeLibs(projectDir)
  const profile = profileOf()
  const logs: string[] = []

  const first = await prepareBundle({ ctx, libs, projectDir, entryPoint, profile, onLog: (l) => logs.push(l) })
  expect(first.bundleCached).toBe(false)
  expect(first.serveUrl).toBe(bundleCacheDir(ctx, sourceSignature(projectDir, "tpl-x")))
  expect(existsSync(join(first.serveUrl, "index.html"))).toBe(true)

  const bundleCalls = (await fakeCalls(files.bundlerFile)).filter((c) => c[0] === "bundle")
  expect(bundleCalls.length).toBe(1)
  const opts = bundleCalls[0]?.[1] as Record<string, unknown>
  expect(opts.entryPoint).toBe(entryPoint)
  expect(opts.outDir).toBe(first.serveUrl)
  // 不传 binariesDirectory（自建空目录会让 compositor 查找失败）
  expect("binariesDirectory" in opts).toBe(false)

  const second = await prepareBundle({ ctx, libs, projectDir, entryPoint, profile, onLog: (l) => logs.push(l) })
  expect(second.bundleCached).toBe(true)
  expect(second.bundleMs).toBe(0)
  expect(second.serveUrl).toBe(first.serveUrl)
  // 热浏览器池：同（项目|chromeMode|gl）复用同一实例
  expect(second.browser).toBe(first.browser)
  expect((await fakeCalls(files.bundlerFile)).filter((c) => c[0] === "bundle").length).toBe(1)
  expect((await fakeCalls(files.rendererFile)).filter((c) => c[0] === "openBrowser").length).toBe(1)
  expect(logs.join("\n")).toContain("复用已打包产物")
})

test("prepareBundle：持久化 bundle 只保留最近 2 份", async () => {
  const home = tempRoot("reel-home-")
  const { ctx } = makeCtx(home)
  const projectDir = tempProject()
  const entryPoint = writeEntry(projectDir)
  installFakeRemotion(projectDir)
  const libs = await loadNativeLibs(projectDir)

  const bundlesRoot = join(stateDir(ctx), "bundles")
  const base = Date.now() - 600_000
  const existing = ["oldest", "middle", "newest"]
  for (const [i, name] of existing.entries()) {
    const dir = join(bundlesRoot, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "index.html"), "<!doctype html>")
    utimesSync(dir, new Date(base + i * 1000), new Date(base + i * 1000))
  }

  await prepareBundle({ ctx, libs, projectDir, entryPoint, profile: profileOf(), onLog: () => {} })

  const left = readdirSync(bundlesRoot).sort()
  expect(left.length).toBe(2)
  expect(left).not.toContain("oldest")
  expect(left).not.toContain("middle")
  expect(left).toContain("newest")
})

// —— 合成解析 ——

test("resolveComposition 缓存命中，chromiumOptions 按渲染档传递", async () => {
  const projectDir = tempProject()
  const files = installFakeRemotion(projectDir)
  const libs = await loadNativeLibs(projectDir)
  const profile = profileOf({ chromeMode: "chrome-for-testing", gl: "vulkan" })
  const browser = await libs.openBrowser({})

  const a = await resolveComposition({ libs, serveUrl: "file:///tmp/serve", compositionId: "Reel", inputProps: { title: "t" }, profile, browser })
  const b = await resolveComposition({ libs, serveUrl: "file:///tmp/serve", compositionId: "Reel", inputProps: { title: "t" }, profile, browser })
  expect(a.id).toBe("Reel")
  expect(a).toBe(b)

  const selects = (await fakeCalls(files.rendererFile)).filter((c) => c[0] === "selectComposition")
  expect(selects.length).toBe(1)
  const opts = selects[0]?.[1] as Record<string, unknown>
  expect(opts.chromiumOptions).toEqual({ gl: "vulkan" })
  expect(opts.puppeteerInstance).toBe(browser)
  expect("binariesDirectory" in opts).toBe(false)

  const list = await listCompositions({ libs, serveUrl: "file:///tmp/serve", profile, browser })
  expect(list[0]?.id).toBe("Reel")
  const gets = (await fakeCalls(files.rendererFile)).filter((c) => c[0] === "getCompositions")
  // 位置参数：第一个是 serveUrl，第二个是配置对象
  expect(gets[0]?.[1]).toBe("file:///tmp/serve")
  expect((gets[0]?.[2] as Record<string, unknown>).chromeMode).toBe("chrome-for-testing")
})

test("非 WebGL 内容不传 gl（chromiumOptions 为空对象）", async () => {
  const projectDir = tempProject()
  const files = installFakeRemotion(projectDir)
  const libs = await loadNativeLibs(projectDir)
  const browser = await libs.openBrowser({})
  await resolveComposition({ libs, serveUrl: "file:///tmp/serve2", compositionId: "Reel", inputProps: {}, profile: profileOf(), browser })
  const selects = (await fakeCalls(files.rendererFile)).filter((c) => c[0] === "selectComposition")
  expect((selects[0]?.[1] as Record<string, unknown>).chromiumOptions).toEqual({})
})

test("prepareBundle：浏览器可执行文件透传给 openBrowser，并参与热浏览器复用键", async () => {
  const home = tempRoot("reel-home-")
  const { ctx } = makeCtx(home)
  const projectDir = tempProject()
  const entryPoint = writeEntry(projectDir)
  const files = installFakeRemotion(projectDir)
  const libs = await loadNativeLibs(projectDir)
  const chrome = join(projectDir, "chrome")
  const opens = async () => (await fakeCalls(files.rendererFile)).filter((c) => c[0] === "openBrowser")

  const first = await prepareBundle({ ctx, libs, projectDir, entryPoint, profile: profileOf(), browserExecutable: chrome, onLog: () => {} })
  const firstOpens = await opens()
  expect(firstOpens.length).toBe(1)
  expect((firstOpens[0]?.[2] as Record<string, unknown>).browserExecutable).toBe(chrome)

  // 同一可执行文件：热复用，不再开第二个浏览器
  const again = await prepareBundle({ ctx, libs, projectDir, entryPoint, profile: profileOf(), browserExecutable: chrome, onLog: () => {} })
  expect(again.browser).toBe(first.browser)
  expect((await opens()).length).toBe(1)

  // 换可执行文件：池键不同 → 另开一个（不会拿错浏览器）
  const other = await prepareBundle({ ctx, libs, projectDir, entryPoint, profile: profileOf(), browserExecutable: `${chrome}-2`, onLog: () => {} })
  expect(other.browser).not.toBe(first.browser)
  const bothOpens = await opens()
  expect(bothOpens.length).toBe(2)
  expect((bothOpens[1]?.[2] as Record<string, unknown>).browserExecutable).toBe(`${chrome}-2`)

  // 未配置：不带该键，交给 Remotion 的缓存/下载规则
  const auto = await prepareBundle({ ctx, libs, projectDir, entryPoint, profile: profileOf(), onLog: () => {} })
  const autoOpens = await opens()
  expect(autoOpens.length).toBe(3)
  expect("browserExecutable" in (autoOpens[2]?.[2] as Record<string, unknown>)).toBe(false)
  expect(auto.browser).not.toBe(first.browser)
})

// —— Chrome 缓存目录与目录统计 ——
test("chromeCacheDir：自起点向上取最近 package.json 所在目录的 node_modules/.remotion", () => {
  const root = tempRoot("reel-cache-")
  mkdirSync(join(root, "proj", "sub"), { recursive: true })
  writeFileSync(join(root, "proj", "package.json"), "{}\n")
  mkdirSync(join(root, "proj", "node_modules", ".remotion"), { recursive: true })

  expect(chromeCacheDir(join(root, "proj", "sub"))).toEqual({ dir: join(root, "proj", "node_modules", ".remotion"), exists: true })

  // 更近的 package.json 优先
  mkdirSync(join(root, "proj", "sub", "node_modules", ".remotion"), { recursive: true })
  writeFileSync(join(root, "proj", "sub", "package.json"), "{}\n")
  expect(chromeCacheDir(join(root, "proj", "sub"))).toEqual({ dir: join(root, "proj", "sub", "node_modules", ".remotion"), exists: true })

  // 目录存在但缓存未下载 → exists=false
  const other = tempRoot("reel-cache-")
  writeFileSync(join(other, "package.json"), "{}\n")
  expect(chromeCacheDir(other)).toEqual({ dir: join(other, "node_modules", ".remotion"), exists: false })
})

test("chromeCacheDir：一路上都没有 package.json 则回落 <起点>/.remotion", () => {
  const bare = tempRoot("reel-bare-")
  let dir: string | null = bare
  let hasAncestor = false
  while (dir) {
    if (existsSync(join(dir, "package.json"))) {
      hasAncestor = true
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (hasAncestor) return // 宿主临时目录上层恰有 package.json 时该分支不适用（上一用例已覆盖主规则）
  expect(chromeCacheDir(bare)).toEqual({ dir: join(bare, ".remotion"), exists: false })
})

test("dirStats 统计体积与文件数（目录不存在返回 0）", () => {
  const dir = tempRoot("reel-stats-")
  mkdirSync(join(dir, "sub", "deep"), { recursive: true })
  writeFileSync(join(dir, "a.txt"), "12345")
  writeFileSync(join(dir, "sub", "b.txt"), "123")
  writeFileSync(join(dir, "sub", "deep", "c.txt"), "1")
  expect(dirStats(dir)).toEqual({ bytes: 9, files: 3 })
  expect(dirStats(join(dir, "nope"))).toEqual({ bytes: 0, files: 0 })
})
