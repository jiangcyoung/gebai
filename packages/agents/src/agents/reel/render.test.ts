/**
 * render.ts 测试：still 的两个姿态——**默认后台作业**（立即返回作业 ID，不附产物块）与
 * **送审模式 `wait=true`**（等这一帧渲完，把帧图以内容块 + 多模态图片附进结果；失败如实报错）。
 * 以及 waitJob 的等待/超时/不存在语义（超时分支在工具层无法用真渲染复现，故在函数级覆盖）。
 *
 * 原生库全部用假实现驱动：不联网、不装依赖、不依赖本机 GPU 与 ffmpeg；探测走真实主机但失败只记 notes。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJob, getJob, waitJob } from "./jobs"
import { renderTool } from "./render"
import { clearReelEnv, makeCtx } from "./test-ctx"
import type { ToolContext } from "@gebai/sdk"

const roots: string[] = []
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

beforeAll(() => clearReelEnv())
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** 假原生渲染库：renderStill 真写一个 PNG 占位文件（让送审块的路径断言有意义）。 */
const RENDERER_MOD = `
export const calls = []
export async function renderStill(o) {
  calls.push(["renderStill", o])
  if (o.output.includes("fail")) throw new Error("渲染引擎报错：模拟失败")
  const fs = await import("node:fs")
  const path = await import("node:path")
  fs.mkdirSync(path.dirname(o.output), { recursive: true })
  fs.writeFileSync(o.output, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return { ok: true }
}
export async function renderMedia(o) { calls.push(["renderMedia", o]); return { ok: true } }
export async function getCompositions(serveUrl, config) { return [{ id: "Reel", width: 1920, height: 1080, fps: 30, durationInFrames: 120 }] }
export async function selectComposition(o) { return { id: o.id, width: 1920, height: 1080, fps: 30, durationInFrames: 120, defaultProps: {} } }
export async function openBrowser(browser, opts) { calls.push(["openBrowser", browser, opts]); return { close: async () => {} } }
export async function ensureBrowser(o) {}
export function makeCancelSignal() { return { cancelSignal: {}, cancel: () => {} } }
`

const BUNDLER_MOD = `
export async function bundle(o) {
  const fs = await import("node:fs")
  fs.mkdirSync(o.outDir, { recursive: true })
  fs.writeFileSync(o.outDir + "/index.html", "<!doctype html>")
  return o.outDir
}
`

/** 就绪的假工程：入口点 + 假 Remotion 依赖 + 清单（库根 runtime 标记由 makeReelCtx 造）。 */
function makeProject(workdir: string, name = "proj"): string {
  const projectDir = join(workdir, name)
  const rendererDir = join(projectDir, "node_modules", "@remotion", "renderer")
  const bundlerDir = join(projectDir, "node_modules", "@remotion", "bundler")
  mkdirSync(join(rendererDir, "dist"), { recursive: true })
  mkdirSync(join(bundlerDir, "dist"), { recursive: true })
  const pkg = (n: string) => `${JSON.stringify({ name: n, version: "4.0.484", exports: { ".": { import: "./dist/index.mjs" } } })}\n`
  writeFileSync(join(rendererDir, "package.json"), pkg("@remotion/renderer"))
  writeFileSync(join(rendererDir, "dist", "index.mjs"), RENDERER_MOD)
  writeFileSync(join(bundlerDir, "package.json"), pkg("@remotion/bundler"))
  writeFileSync(join(bundlerDir, "dist", "index.mjs"), BUNDLER_MOD)
  mkdirSync(join(projectDir, "src"), { recursive: true })
  writeFileSync(join(projectDir, "src", "index.ts"), "import { registerRoot } from \"remotion\"\nregisterRoot(Root)\n")
  writeFileSync(join(projectDir, ".reel.json"), `${JSON.stringify({ entryPoint: join(projectDir, "src", "index.ts") }, null, 2)}\n`)
  return projectDir
}

/** 造好库根（含 runtime 就绪标记）与 ctx。 */
function makeReelCtx(prefix: string, env: Record<string, string> = {}): { ctx: ToolContext; workdir: string; libraryRoot: string } {
  const home = tempRoot(prefix)
  const made = makeCtx(home, env)
  const libraryRoot = join(home, "vendor", "reel")
  mkdirSync(join(libraryRoot, "runtime", "node_modules", "remotion"), { recursive: true })
  writeFileSync(join(libraryRoot, "runtime", "node_modules", "remotion", "package.json"), `${JSON.stringify({ version: "4.0.484" })}\n`)
  return { ctx: made.ctx, workdir: made.ctx.workdir, libraryRoot }
}

describe("still：默认后台作业", () => {
  test("立即返回作业 ID，不附产物块（保持长任务语义）", async () => {
    const { ctx, workdir } = makeReelCtx("reel-render-")
    const projectDir = makeProject(workdir)

    const result = await renderTool.execute({ action: "still", project: projectDir, frame: 0, out: "out/qa/plain.png" }, ctx)

    expect(result.output).toContain("已启动静帧渲染作业")
    expect(result.output).toContain("查询进度：reel_render action=status")
    expect((result.data as { kind: string }).kind).toBe("still")
    expect(result.blocks).toBeUndefined()
    expect(result.images).toBeUndefined()
    // 异步作业仍会落地（等它跑完，顺带证明 wait 省略不影响渲染本身）
    const job = getJob((result.data as { jobId: string }).jobId)!
    await waitJob(job.id, 30_000)
    expect(getJob(job.id)!.status).toBe("done")
    expect(existsSync(join(projectDir, "out", "qa", "plain.png"))).toBe(true)
  })
})

describe("still：送审模式 wait=true", () => {
  test("等这一帧渲完并把帧图附进结果（内容块给用户看 + 多模态图片给模型自查）", async () => {
    const { ctx, workdir } = makeReelCtx("reel-render-")
    const projectDir = makeProject(workdir)

    const result = await renderTool.execute({ action: "still", project: projectDir, frame: 42, out: "out/qa/review.png", wait: true }, ctx)

    expect(result.output).toContain("静帧已渲染")
    expect(result.output).toContain("送审")
    const data = result.data as { status: string; output: string; frame: number }
    expect(data.status).toBe("done")
    expect(data.frame).toBe(42)

    // 产物存在
    expect(existsSync(join(projectDir, "out", "qa", "review.png"))).toBe(true)
    // 内容块：图片块，路径为会话 tmp 逻辑路径（UI 可解析）、名字为文件名
    expect(result.blocks?.length).toBe(1)
    expect(result.blocks?.[0]).toMatchObject({ type: "image", name: "review.png", mime: "image/png" })
    expect(String((result.blocks?.[0] as { path: string }).path)).toBe("tmp/proj/out/qa/review.png")
    // 多模态图片：绝对路径（引擎按此读取内联）
    expect(result.images?.length).toBe(1)
    expect(result.images?.[0]?.path).toBe(join(projectDir, "out", "qa", "review.png"))
    expect(result.images?.[0]?.mime).toBe("image/png")
  })

  test("渲染失败：如实报错并给排查入口，不附半成品块", async () => {
    const { ctx, workdir } = makeReelCtx("reel-render-")
    const projectDir = makeProject(workdir)

    const result = await renderTool.execute({ action: "still", project: projectDir, frame: 0, out: "out/qa/fail.png", wait: true }, ctx)

    expect(result.output).toContain("等待渲染未成功")
    expect(result.output).toContain("模拟失败")
    expect(result.output).toContain("reel_render action=log")
    expect((result.data as { status: string }).status).toBe("failed")
    expect(result.blocks).toBeUndefined()
    expect(result.images).toBeUndefined()
  })
})

describe("waitJob：等待语义", () => {
  test("已终态立即返回；不存在的作业返回 null", async () => {
    const { ctx } = makeReelCtx("reel-render-")
    const job = createJob({ ctx, kind: "still", project: "/p", composition: "Reel" })
    job.status = "done"
    expect((await waitJob(job.id, 1000))?.status).toBe("done")
    expect(await waitJob("still-nonexistent-1", 1000)).toBeNull()
  })

  test("超时返回当前（未终态）作业——调用方据 status 提示继续查", async () => {
    const { ctx } = makeReelCtx("reel-render-")
    const job = createJob({ ctx, kind: "still", project: "/p", composition: "Reel" })
    job.status = "running"
    const started = Date.now()
    const settled = await waitJob(job.id, 120, 20)
    expect(settled?.id).toBe(job.id)
    expect(settled?.status).toBe("running")
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })
})

describe("still：out 路径语义（送审帧落在工程内）", () => {
  test("相对 out 以工程目录为基准；绝对 out 直通", async () => {
    const { ctx, workdir } = makeReelCtx("reel-render-")
    const projectDir = makeProject(workdir)

    const rel = await renderTool.execute({ action: "still", project: projectDir, out: "out/qa/rel.png", wait: true }, ctx)
    expect((rel.data as { output: string }).output).toBe(join(projectDir, "out", "qa", "rel.png"))

    const absTarget = join(tempRoot("reel-abs-"), "deliver.png")
    const abs = await renderTool.execute({ action: "still", project: projectDir, out: absTarget, wait: true }, ctx)
    expect((abs.data as { output: string }).output).toBe(absTarget)
    expect(existsSync(absTarget)).toBe(true)
  })
})
