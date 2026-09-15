/** library.ts 测试：模板展开 / 锁读写 / 签名判定 / 复用既有运行时（目录联接）/ 安装与失败登记。全部注入式假依赖。 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RUNTIME_READY_MARKER, TEMPLATE_REMOTION_VERSION, isRuntimeReady, libraryRoot, runtimeDir } from "./paths"
import { TEMPLATE_FILES, TEMPLATE_SIGNATURE } from "./template.generated"
import { ensureRuntime, materializeTemplate, readRuntimeLock, templateSignature, writeRuntimeLock } from "./library"
import type { RuntimeLock } from "./library"
import { clearReelEnv, makeCtx } from "./test-ctx"

const roots: string[] = []
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
const tempHome = () => tempRoot("reel-home-")

/** 假安装：只造出 node_modules/remotion/package.json（版本判定与就绪标记的唯一依据）。 */
function installFakeRemotion(dir: string, version: string): void {
  const pkgDir = join(dir, "node_modules", "remotion")
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify({ name: "remotion", version }, null, 2)}\n`)
}

const noRun = async (cmd: string[]) => {
  throw new Error(`测试不应执行命令：${cmd.join(" ")}`)
}

beforeAll(() => clearReelEnv())
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test("materializeTemplate 把内置模板展开成真实文件（覆盖写、幂等）", () => {
  const target = tempRoot("reel-tpl-")
  const written = materializeTemplate(target)
  expect(written.sort()).toEqual(Object.keys(TEMPLATE_FILES).sort())
  for (const rel of written) {
    expect(existsSync(join(target, rel))).toBe(true)
    expect(readFileSync(join(target, rel), "utf8")).toBe(TEMPLATE_FILES[rel])
  }
  // 嵌套目录已按需创建，且重复展开不报错
  expect(materializeTemplate(target).length).toBe(written.length)
})

test("运行时锁读写：round-trip，缺失与损坏返回 null", () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  expect(readRuntimeLock(ctx)).toBeNull()

  const lock: RuntimeLock = {
    status: "ready",
    packageManager: "npm",
    remotionVersion: TEMPLATE_REMOTION_VERSION,
    installedAt: "2024-01-01T00:00:00.000Z",
    templateSignature: templateSignature(),
    source: "builtin",
  }
  writeRuntimeLock(ctx, lock)
  expect(readRuntimeLock(ctx)).toEqual(lock)
  expect(existsSync(join(libraryRoot(ctx), "runtime.lock.json"))).toBe(true)

  writeFileSync(join(libraryRoot(ctx), "runtime.lock.json"), "{ 坏 JSON")
  expect(readRuntimeLock(ctx)).toBeNull()
})

test("签名判定：templateSignature() == TEMPLATE_SIGNATURE；已就绪则直接复用不安装", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  expect(templateSignature()).toBe(TEMPLATE_SIGNATURE)

  installFakeRemotion(runtimeDir(ctx), TEMPLATE_REMOTION_VERSION)
  writeRuntimeLock(ctx, {
    status: "ready",
    packageManager: "npm",
    remotionVersion: TEMPLATE_REMOTION_VERSION,
    installedAt: "2024-01-01T00:00:00.000Z",
    templateSignature: templateSignature(),
    source: "builtin",
  })

  const res = await ensureRuntime(ctx, { deps: { which: () => null, run: noRun } })
  expect(res.ok).toBe(true)
  expect(res.actions.join("\n")).toContain("已就绪")
  expect(res.lock?.source).toBe("builtin")
})

test("签名不匹配但本机依赖版本仍匹配 → 重落位模板、复用依赖（不重装）", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  installFakeRemotion(runtimeDir(ctx), TEMPLATE_REMOTION_VERSION)
  writeRuntimeLock(ctx, {
    status: "ready",
    packageManager: "npm",
    remotionVersion: TEMPLATE_REMOTION_VERSION,
    installedAt: "2024-01-01T00:00:00.000Z",
    templateSignature: "stale-signature",
    source: "builtin",
  })

  const res = await ensureRuntime(ctx, { deps: { which: () => "/usr/bin/npm", run: noRun, now: () => new Date("2024-03-04T05:06:07.000Z") } })
  expect(res.ok).toBe(true)
  expect(res.lock?.templateSignature).toBe(templateSignature())
  expect(res.lock?.remotionVersion).toBe(TEMPLATE_REMOTION_VERSION)
  expect(res.lock?.source).toBe("builtin")
  expect(res.actions.join("\n")).toContain("模板已更新")
  for (const rel of Object.keys(TEMPLATE_FILES)) expect(existsSync(join(runtimeDir(ctx), rel))).toBe(true)
})

test("复用同实例其他库根的同版本运行时：模板落位 + node_modules 走目录联接，不安装", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  const shared = join(home, "vendor", "some-other-video-kit", "runtime")
  installFakeRemotion(shared, TEMPLATE_REMOTION_VERSION)

  const res = await ensureRuntime(ctx, {
    deps: { which: () => null, run: noRun, now: () => new Date("2024-05-06T07:08:09.000Z") },
  })
  expect(res.ok).toBe(true)
  expect(res.lock?.source).toBe("shared")
  expect(res.lock?.linkedFrom).toBe(shared)
  expect(res.lock?.remotionVersion).toBe(TEMPLATE_REMOTION_VERSION)
  expect(res.lock?.packageManager).toBeNull()
  expect(res.lock?.installedAt).toBe("2024-05-06T07:08:09.000Z")

  const link = join(runtimeDir(ctx), "node_modules")
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(realpathSync(link)).toBe(realpathSync(join(shared, "node_modules")))
  for (const rel of Object.keys(TEMPLATE_FILES)) expect(existsSync(join(runtimeDir(ctx), rel))).toBe(true)
  expect(isRuntimeReady(ctx)).toBe(true)
  expect(res.actions.join("\n")).toContain("目录联接")

  // 二次调用命中快速路径，不再执行任何命令
  const again = await ensureRuntime(ctx, { deps: { which: () => null, run: noRun } })
  expect(again.ok).toBe(true)
  expect(again.actions.join("\n")).toContain("已就绪")
})

test("既有运行时版本不匹配 → 不复用；无包管理器时明确报错", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  const shared = join(home, "vendor", "some-other-video-kit", "runtime")
  installFakeRemotion(shared, "4.0.999")

  const res = await ensureRuntime(ctx, { deps: { which: () => null, run: noRun } })
  expect(res.ok).toBe(false)
  expect(res.actions.join("\n")).toContain("4.0.999")
  expect(res.error).toContain("npm")
  expect(res.error).toContain("bun")
  expect(readRuntimeLock(ctx)?.status).toBe("failed")
  expect(existsSync(join(runtimeDir(ctx), "node_modules"))).toBe(false)
})

test("REEL_SHARED_RUNTIME 显式指定复用位置（不依赖同实例目录扫描）", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home, { REEL_SHARED_RUNTIME: join(home, "elsewhere", "rt") })
  const shared = join(home, "elsewhere", "rt")
  installFakeRemotion(shared, TEMPLATE_REMOTION_VERSION)

  const res = await ensureRuntime(ctx, { deps: { which: () => null, run: noRun } })
  expect(res.ok).toBe(true)
  expect(res.lock?.source).toBe("shared")
  expect(res.lock?.linkedFrom).toBe(shared)
})

test("环境中没有任何可复用运行时 → 走自主安装（完全独立）", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  const runCalls: string[][] = []
  const res = await ensureRuntime(ctx, {
    deps: {
      which: (cmd) => (cmd === "npm" ? "/usr/bin/npm" : null),
      run: async (cmd) => {
        runCalls.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
      now: () => new Date("2024-05-06T07:08:09.000Z"),
    },
  })
  expect(res.ok).toBe(true)
  expect(res.lock?.source).toBe("builtin")
  expect(res.lock?.packageManager).toBe("npm")
  expect(runCalls.length).toBe(1)
})

test("自主安装成功：无 package-lock.json 用 npm install，记账版本与包管理器", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  const runCalls: string[][] = []
  const res = await ensureRuntime(ctx, {
    deps: {
      which: (cmd) => (cmd === "npm" ? "/usr/bin/npm" : null),
      sharedCandidates: [],
      run: async (cmd, opts) => {
        runCalls.push(cmd)
        expect(opts.cwd).toBe(runtimeDir(ctx))
        installFakeRemotion(opts.cwd, TEMPLATE_REMOTION_VERSION)
        return { code: 0, stdout: "", stderr: "" }
      },
    },
  })
  expect(res.ok).toBe(true)
  expect(runCalls).toEqual([["/usr/bin/npm", "install", "--no-audit", "--no-fund"]])
  expect(res.lock).toMatchObject({ status: "ready", source: "builtin", packageManager: "npm", remotionVersion: TEMPLATE_REMOTION_VERSION })
  expect(isRuntimeReady(ctx)).toBe(true)
})

test("自主安装：有 package-lock.json 用 npm ci；无 npm 回落 bun install", async () => {
  const homeA = tempHome()
  const { ctx: ctxA } = makeCtx(homeA)
  mkdirSync(runtimeDir(ctxA), { recursive: true })
  writeFileSync(join(runtimeDir(ctxA), "package-lock.json"), "{}\n")
  const callsA: string[][] = []
  const resA = await ensureRuntime(ctxA, {
    deps: {
      which: (cmd) => (cmd === "npm" ? "/usr/bin/npm" : null),
      sharedCandidates: [],
      run: async (cmd, opts) => {
        callsA.push(cmd)
        installFakeRemotion(opts.cwd, TEMPLATE_REMOTION_VERSION)
        return { code: 0, stdout: "", stderr: "" }
      },
    },
  })
  expect(resA.ok).toBe(true)
  expect(callsA[0]?.slice(1)).toEqual(["ci", "--no-audit", "--no-fund"])

  const homeB = tempHome()
  const { ctx: ctxB } = makeCtx(homeB)
  const callsB: string[][] = []
  const resB = await ensureRuntime(ctxB, {
    deps: {
      which: (cmd) => (cmd === "bun" ? "/usr/local/bin/bun" : null),
      sharedCandidates: [],
      run: async (cmd, opts) => {
        callsB.push(cmd)
        installFakeRemotion(opts.cwd, TEMPLATE_REMOTION_VERSION)
        return { code: 0, stdout: "", stderr: "" }
      },
    },
  })
  expect(resB.ok).toBe(true)
  expect(callsB).toEqual([["/usr/local/bin/bun", "install", "--no-summary"]])
  expect(resB.lock?.packageManager).toBe("bun")
})

test("安装失败：登记 failed + 错误尾部，且不清理已落位文件", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  const res = await ensureRuntime(ctx, {
    deps: {
      which: (cmd) => (cmd === "npm" ? "/usr/bin/npm" : null),
      sharedCandidates: [],
      now: () => new Date("2024-02-02T03:04:05.000Z"),
      run: async () => ({ code: 1, stdout: "npm ERR! boom", stderr: "EACCES: permission denied" }),
    },
  })
  expect(res.ok).toBe(false)
  expect(res.error).toContain("退出码 1")
  expect(res.error).toContain("EACCES")
  const lock = readRuntimeLock(ctx)
  expect(lock?.status).toBe("failed")
  expect(lock?.error).toContain("EACCES")
  expect(lock?.installedAt).toBe("2024-02-02T03:04:05.000Z")
  expect(lock?.remotionVersion).toBeNull()
  // 不清理：模板文件仍留在运行时目录，便于排查
  for (const rel of Object.keys(TEMPLATE_FILES)) expect(existsSync(join(runtimeDir(ctx), rel))).toBe(true)
  expect(existsSync(join(runtimeDir(ctx), RUNTIME_READY_MARKER))).toBe(false)
})

test("无 npm 也无 bun → 明确报错并登记 failed", async () => {
  const home = tempHome()
  const { ctx } = makeCtx(home)
  const res = await ensureRuntime(ctx, { deps: { which: () => null, sharedCandidates: [], run: noRun } })
  expect(res.ok).toBe(false)
  expect(res.error).toContain("既无 npm 也无 bun")
  expect(res.lock?.status).toBe("failed")
  expect(res.lock?.packageManager).toBeNull()
})
