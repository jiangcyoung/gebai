/**
 * external.ts 测试：两条外部件通道（浏览器可执行文件 / 原生二进制目录）的取值优先级与校验、
 * 浏览器就绪判定（配置 / 本地缓存 / 版本不一致 / 无缓存）、Remotion 期望路径与版本读取。
 * 全部走临时目录与注入参数：不联网、不碰本机真实 Chrome 缓存。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BINARIES_DIR_ENV,
  BROWSER_EXECUTABLE_ENV,
  browserModeDir,
  browserReadiness,
  expectedBrowserExecutablePath,
  expectedChromeVersion,
  readCachedChromeVersion,
  resolveBinariesDirectory,
  resolveBrowserExecutable,
} from "./external"
import { writeProjectManifest } from "./runtime"
import { clearReelEnv, makeCtx } from "./test-ctx"

const roots: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** 造一个可执行文件占位（内容无关，只要存在）。 */
function touchFile(abs: string): string {
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, "#!/bin/sh\n")
  return abs
}

/** 造一个含 remotion/ffmpeg/ffprobe 三件套的目录。 */
function makeBinariesDir(): string {
  const dir = tempDir("reel-bin-")
  for (const name of ["remotion", "ffmpeg", "ffprobe"]) writeFileSync(join(dir, name), "")
  return dir
}

/** 造 Remotion 的浏览器缓存布局：<root>/node_modules/.remotion/<形态目录>/<平台>/...（chromeCacheDir 按 package.json 定位）。 */
function makeChromeCache(opts: { mode: "headless-shell" | "chrome-for-testing"; version?: string }): { root: string; executablePath: string } {
  const root = tempDir("reel-cache-")
  writeFileSync(join(root, "package.json"), "{}")
  const cacheRoot = join(root, "node_modules", ".remotion")
  const executablePath = expectedBrowserExecutablePath({ cacheRoot, mode: opts.mode, platform: "linux", arch: "x64", amazonLinux2023: false })
  mkdirSync(join(executablePath, ".."), { recursive: true })
  writeFileSync(executablePath, "")
  if (opts.version) writeFileSync(join(browserModeDir(cacheRoot, opts.mode), "VERSION"), opts.version)
  return { root, executablePath }
}

function cleanup(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  clearReelEnv()
}

describe("外部件取值优先级：参数 > 环境变量 > 工程清单", () => {
  test("调用参数最优先；相对路径按工程目录解析", () => {
    const home = tempDir("reel-home-")
    const projectDir = tempDir("reel-proj-")
    const fromArg = touchFile(join(projectDir, "bin", "chrome"))
    writeProjectManifest(projectDir, { entryPoint: "src/index.ts", browserExecutable: touchFile(join(projectDir, "manifest-chrome")) })
    const { ctx } = makeCtx(home, { [BROWSER_EXECUTABLE_ENV]: touchFile(join(projectDir, "env-chrome")) })

    try {
      expect(resolveBrowserExecutable({ ctx, projectDir, arg: "bin/chrome" })).toEqual({ path: fromArg, source: "arg" })
    } finally {
      cleanup()
    }
  })

  test("环境变量次之（绝对路径直通），工程清单兜底", () => {
    const home = tempDir("reel-home-")
    const projectDir = tempDir("reel-proj-")
    const fromEnv = touchFile(join(projectDir, "env-chrome"))
    const fromManifest = touchFile(join(projectDir, "manifest-chrome"))
    const { ctx } = makeCtx(home, { [BROWSER_EXECUTABLE_ENV]: fromEnv })

    try {
      expect(resolveBrowserExecutable({ ctx, projectDir }).path).toBe(fromEnv)

      const bare = makeCtx(tempDir("reel-home2-"), {}).ctx
      writeProjectManifest(projectDir, { entryPoint: "src/index.ts", browserExecutable: fromManifest })
      expect(resolveBrowserExecutable({ ctx: bare, projectDir })).toEqual({ path: fromManifest, source: "manifest" })
      expect(resolveBrowserExecutable({ ctx: bare, projectDir: tempDir("reel-proj2-") })).toEqual({ path: null, source: "none" })
    } finally {
      cleanup()
    }
  })

  test("配置了但路径不存在 → 明确报错（含来源与路径），不静默回落", () => {
    const home = tempDir("reel-home-")
    const projectDir = tempDir("reel-proj-")
    const { ctx } = makeCtx(home, { [BROWSER_EXECUTABLE_ENV]: join(projectDir, "missing-chrome") })

    try {
      expect(() => resolveBrowserExecutable({ ctx, projectDir })).toThrow(/浏览器可执行文件不存在/)
      expect(() => resolveBrowserExecutable({ ctx, projectDir })).toThrow(/环境变量/)
      expect(() => resolveBrowserExecutable({ ctx, projectDir, arg: join(projectDir, "also-missing") })).toThrow(/调用参数/)
    } finally {
      cleanup()
    }
  })
})

describe("原生二进制目录：必须是含三件套的目录", () => {
  test("三件套齐备 → 通过；缺件 / 不是目录 → 报错", () => {
    const home = tempDir("reel-home-")
    const projectDir = tempDir("reel-proj-")
    const complete = makeBinariesDir()
    const incomplete = tempDir("reel-bin-bad-")
    writeFileSync(join(incomplete, "ffmpeg"), "")
    const asFile = touchFile(join(projectDir, "not-a-dir"))
    const { ctx } = makeCtx(home, { [BINARIES_DIR_ENV]: complete })

    try {
      expect(resolveBinariesDirectory({ ctx, projectDir })).toEqual({ path: complete, source: "env" })
      expect(() => resolveBinariesDirectory({ ctx, projectDir, arg: incomplete })).toThrow(/原生二进制目录缺 remotion、ffprobe/)
      expect(() => resolveBinariesDirectory({ ctx, projectDir, arg: asFile })).toThrow(/不是目录/)
    } finally {
      cleanup()
    }
  })
})

describe("浏览器就绪判定", () => {
  test("配置了可执行文件：存在 → 就绪且不查缓存；不存在 → 未就绪并给出修复入口", () => {
    const cacheFrom = tempDir("reel-cache-")
    const chrome = touchFile(join(cacheFrom, "chrome"))

    const ready = browserReadiness({ mode: "chrome-for-testing", browserExecutable: chrome, cacheFrom })
    expect(ready.ready).toBe(true)
    expect(ready.source).toBe("configured")
    expect(ready.executablePath).toBe(chrome)
    expect(ready.note).toContain("不查缓存、不下载")

    const broken = browserReadiness({ mode: "chrome-for-testing", browserExecutable: join(cacheFrom, "nope"), cacheFrom })
    expect(broken.ready).toBe(false)
    expect(broken.source).toBe("none")
    expect(broken.note).toContain(BROWSER_EXECUTABLE_ENV)
  })

  test("未配置：无缓存 → 未就绪且点名「联网下载」；缓存就绪（版本一致）→ 就绪", () => {
    const empty = tempDir("reel-cache-")
    writeFileSync(join(empty, "package.json"), "{}")
    const missing = browserReadiness({ mode: "headless-shell", cacheFrom: empty, platform: "linux", arch: "x64" })
    expect(missing.ready).toBe(false)
    expect(missing.note).toContain("联网下载")
    expect(missing.cacheDir).toBe(join(empty, "node_modules", ".remotion", "chrome-headless-shell"))

    const { root, executablePath } = makeChromeCache({ mode: "headless-shell", version: "149.0.7790.0" })
    const ready = browserReadiness({ mode: "headless-shell", cacheFrom: root, platform: "linux", arch: "x64", expectedVersion: "149.0.7790.0" })
    expect(ready.ready).toBe(true)
    expect(ready.source).toBe("local-cache")
    expect(ready.executablePath).toBe(executablePath)
    expect(ready.installedVersion).toBe("149.0.7790.0")
  })

  test("缓存版本与当前 Remotion 期望不一致 → 未就绪（Remotion 会重新下载）", () => {
    const { root } = makeChromeCache({ mode: "headless-shell", version: "120.0.0.0" })
    const state = browserReadiness({ mode: "headless-shell", cacheFrom: root, platform: "linux", arch: "x64", expectedVersion: "149.0.7790.0" })
    expect(state.ready).toBe(false)
    expect(state.source).toBe("none")
    expect(state.note).toContain("不一致")
  })

  test("形态相关：headless-shell 就绪不代表 chrome-for-testing 就绪", () => {
    const { root } = makeChromeCache({ mode: "headless-shell", version: "149.0.7790.0" })
    expect(browserReadiness({ mode: "headless-shell", cacheFrom: root, platform: "linux", arch: "x64" }).ready).toBe(true)
    expect(browserReadiness({ mode: "chrome-for-testing", cacheFrom: root, platform: "linux", arch: "x64" }).ready).toBe(false)
  })
})

describe("Remotion 期望路径与版本读取", () => {
  test("平台与形态决定可执行文件路径（含形态子目录与平台内层目录）", () => {
    const cacheRoot = "/cache/.remotion"
    expect(expectedBrowserExecutablePath({ cacheRoot, mode: "headless-shell", platform: "linux", arch: "x64", amazonLinux2023: false })).toBe(
      join(cacheRoot, "chrome-headless-shell", "linux64", "chrome-headless-shell-linux64", "chrome-headless-shell"),
    )
    expect(expectedBrowserExecutablePath({ cacheRoot, mode: "headless-shell", platform: "linux", arch: "x64", amazonLinux2023: true })).toBe(
      join(cacheRoot, "chrome-headless-shell", "linux64", "chrome-headless-shell-linux64", "headless_shell"),
    )
    expect(expectedBrowserExecutablePath({ cacheRoot, mode: "headless-shell", platform: "win32", arch: "x64" })).toBe(
      join(cacheRoot, "chrome-headless-shell", "win64", "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
    )
    expect(expectedBrowserExecutablePath({ cacheRoot, mode: "chrome-for-testing", platform: "darwin", arch: "arm64" })).toBe(
      join(cacheRoot, "chrome-for-testing", "mac-arm64", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    )
    expect(expectedBrowserExecutablePath({ cacheRoot, mode: "chrome-for-testing", platform: "linux", arch: "x64" })).toBe(
      join(cacheRoot, "chrome-for-testing", "linux64", "chrome-linux64", "chrome"),
    )
  })

  test("从共享运行时读 Remotion 的 TESTED_VERSION；读不到返回 null", () => {
    const runtimeRoot = tempDir("reel-runtime-")
    const dist = join(runtimeRoot, "node_modules", "@remotion", "renderer", "dist", "browser")
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, "get-chrome-download-url.js"), "exports.TESTED_VERSION = '149.0.7790.0';\n")

    try {
      expect(expectedChromeVersion(runtimeRoot)).toBe("149.0.7790.0")
      expect(expectedChromeVersion(null)).toBeNull()
      expect(expectedChromeVersion(tempDir("reel-runtime-bare-"))).toBeNull()
    } finally {
      cleanup()
    }
  })

  test("缓存 VERSION 读取：有则去空白，无则 null", () => {
    const { root } = makeChromeCache({ mode: "headless-shell", version: "149.0.7790.0" })
    const cacheRoot = join(root, "node_modules", ".remotion")
    expect(readCachedChromeVersion(cacheRoot, "headless-shell")).toBe("149.0.7790.0")
    expect(readCachedChromeVersion(cacheRoot, "chrome-for-testing")).toBeNull()
    expect(readCachedChromeVersion(tempDir("reel-cache-bare-"), "headless-shell")).toBeNull()
  })

  test("形态目录常量：两种形态各自独立子目录", () => {
    expect(browserModeDir("/c/.remotion", "headless-shell")).toBe(join("/c/.remotion", "chrome-headless-shell"))
    expect(browserModeDir("/c/.remotion", "chrome-for-testing")).toBe(join("/c/.remotion", "chrome-for-testing"))
  })
})
