/**
 * 渲染执行与作业单测：原生库调用参数映射（硬件编码/码率/CRF/帧段/并发/Chrome 档/热浏览器复用）、
 * 取消信号、进度回调、作业登记与日志、bench 的硬件编码探针与调优写入——全部用假原生库（不启动 Chrome、不渲染）。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearShotcraftEnv, makeCtx } from "./test-ctx"
import { decideProfile } from "./profile"
import {
  cancelJob,
  createJob,
  describeJob,
  getJob,
  parseConcurrencyLimit,
  pickTuningEntry,
  readJobLog,
  readTuning,
  runBench,
  runMediaRender,
  runStill,
  startJob,
} from "./jobs"
import { parseFrameRange, parsePropsInput } from "./render"
import type { NativeBrowser, NativeLibs, VideoConfig } from "./runtime"

const roots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "shotcraft-render-"))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => clearShotcraftEnv())

const COMPOSITION: VideoConfig = { id: "Promo", width: 1920, height: 1080, fps: 30, durationInFrames: 300 }

interface FakeCalls {
  still: Record<string, unknown>[]
  media: Record<string, unknown>[]
  cancels: number
}

function fakeLibs(opts: { failMedia?: (params: Record<string, unknown>) => Error | null } = {}): { libs: NativeLibs; calls: FakeCalls } {
  const calls: FakeCalls = { still: [], media: [], cancels: 0 }
  const browser: NativeBrowser = { close: async () => {} }
  const libs = {
    rendererDir: "/fake/@remotion/renderer",
    version: "4.0.484",
    renderStill: async (params: Record<string, unknown>) => {
      calls.still.push(params)
      return {}
    },
    renderMedia: async (params: Record<string, unknown>) => {
      calls.media.push(params)
      const failure = opts.failMedia?.(params)
      if (failure) throw failure
      return {}
    },
    getCompositions: async () => [COMPOSITION],
    selectComposition: async () => COMPOSITION,
    openBrowser: async () => browser,
    ensureBrowser: async () => {},
    makeCancelSignal: () => ({
      cancelSignal: {},
      cancel: () => {
        calls.cancels++
      },
    }),
    bundle: async () => "/fake/bundle",
  } as unknown as NativeLibs
  return { libs, calls }
}

function baseArgs(ctx: ReturnType<typeof makeCtx>["ctx"], libs: NativeLibs, profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 8 })) {
  const browser: NativeBrowser = { close: async () => {} }
  return {
    ctx,
    libs,
    projectDir: "/fake/project",
    entryPoint: "/fake/project/src/index.ts",
    serveUrl: "/fake/bundle",
    composition: COMPOSITION,
    profile,
    binariesDirectory: "/fake/binaries",
    browser,
    inputProps: {},
  }
}

describe("参数解析", () => {
  test("帧段：闭合段与开放段，非法返回 null", () => {
    expect(parseFrameRange("0-59")).toEqual([0, 59])
    expect(parseFrameRange(" 10 - 20 ")).toEqual([10, 20])
    expect(parseFrameRange("120-")).toEqual([120, null])
    expect(parseFrameRange("5-3")).toBeNull()
    expect(parseFrameRange("abc")).toBeNull()
    expect(parseFrameRange("0,30,60")).toBeNull()
  })

  test("props：JSON 文本、JSON 文件、对象直传；文件缺失报错", () => {
    const dir = tmpRoot()
    expect(parsePropsInput('{"bgm":false}', dir)).toEqual({ bgm: false })
    expect(parsePropsInput({ title: "x" }, dir)).toEqual({ title: "x" })
    expect(parsePropsInput("", dir)).toEqual({})
    const file = join(dir, "props.json")
    writeJson(file, { bgm: true })
    expect(parsePropsInput("props.json", dir)).toEqual({ bgm: true })
    expect(() => parsePropsInput("missing.json", dir)).toThrow()
    expect(() => parsePropsInput("{bad json", dir)).toThrow()
  })
})

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

describe("静帧渲染", () => {
  test("参数直通原生库：帧号/格式/缩放/热浏览器/Chrome 档", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const { libs, calls } = fakeLibs()
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 8, nvidia: { vendor: "nvidia", name: "RTX 4090" }, remotionVersion: "4.0.484", webglContent: true })
    const job = createJob({ ctx, kind: "still", project: "/fake/project", composition: "Promo" })
    const summary = await runStill({
      ...baseArgs(ctx, libs, profile),
      job,
      frame: 42,
      output: "/fake/project/out/still.png",
      imageFormat: "png",
      scale: 0.5,
    })
    const params = calls.still[0]
    expect(params.frame).toBe(42)
    expect(params.imageFormat).toBe("png")
    expect(params.scale).toBe(0.5)
    expect(params.output).toBe("/fake/project/out/still.png")
    expect(params.chromeMode).toBe("chrome-for-testing")
    expect(params.chromiumOptions).toEqual({ gl: "vulkan" })
    // 不传 binariesDirectory：原生 compositor/ffmpeg 由项目内 @remotion/compositor-* 包提供，
    // 指向自建目录会让 Remotion 去那里找不存在的二进制（实测报 ENOENT）
    expect(params.binariesDirectory).toBeUndefined()
    expect(params.puppeteerInstance).toBeDefined()
    expect(params.overwrite).toBe(true)
    expect(String(params.serveUrl)).toBe("/fake/bundle")
    expect(summary).toContain("静帧已渲染")
    expect(job.progress.totalFrames).toBe(1)
  })
})

describe("视频渲染", () => {
  test("硬件档：hardwareAcceleration + videoBitrate，不传 crf", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const { libs, calls } = fakeLibs()
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 8, nvidia: { vendor: "nvidia", name: "RTX 4090" }, remotionVersion: "4.0.484", webglContent: false })
    const job = createJob({ ctx, kind: "video", project: "/fake/project", composition: "Promo" })
    await runMediaRender({ ...baseArgs(ctx, libs, profile), job, output: "/fake/project/out/promo.mp4", options: { frameRange: [0, 119], crf: 18 } })
    const params = calls.media[0]
    expect(params.hardwareAcceleration).toBe("if-possible")
    expect(params.videoBitrate).toBe("8M")
    expect(params.crf).toBeUndefined()
    expect(params.concurrency).toBe(8)
    expect(params.frameRange).toEqual([0, 119])
    expect(params.codec).toBe("h264")
    expect(params.imageFormat).toBe("jpeg")
  })

  test("软件档：不传 hardwareAcceleration，按 crf 控质量", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const { libs, calls } = fakeLibs()
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 4 })
    const job = createJob({ ctx, kind: "video", project: "/fake/project", composition: "Promo" })
    await runMediaRender({ ...baseArgs(ctx, libs, profile), job, output: "/fake/project/out/promo.mp4", options: { crf: 16, videoBitrate: null } })
    const params = calls.media[0]
    expect(params.hardwareAcceleration).toBeUndefined()
    expect(params.videoBitrate).toBeUndefined()
    expect(params.crf).toBe(16)
  })

  test("进度回调写入作业进度与日志", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const { libs, calls } = fakeLibs()
    const job = createJob({ ctx, kind: "preview", project: "/fake/project", composition: "Promo" })
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 4 })
    await runMediaRender({ ...baseArgs(ctx, libs, profile), job, output: "/fake/project/out/preview.mp4", options: { frameRange: [0, 59] } })
    const onProgress = calls.media[0].onProgress as (p: Record<string, unknown>) => void
    onProgress({ renderedFrames: 30, encodedFrames: 20, progress: 0.5, stitchStage: "encoding" })
    expect(job.progress.renderedFrames).toBe(30)
    expect(job.progress.percent).toBe(50)
    expect(job.progress.totalFrames).toBe(60)
    expect(readJobLog(job, ctx, 20)).toContain("视频渲染")
  })

  test("渲染失败：抛错并发出取消信号", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const { libs, calls } = fakeLibs({ failMedia: () => new Error("compositor crashed") })
    const job = createJob({ ctx, kind: "video", project: "/fake/project", composition: "Promo" })
    await expect(runMediaRender({ ...baseArgs(ctx, libs), job, output: "/fake/out.mp4" })).rejects.toThrow("compositor crashed")
    expect(calls.cancels).toBe(1)
  })
})

describe("作业管理", () => {
  test("状态描述含进度条与帧数", () => {
    const { ctx } = makeCtx(tmpRoot())
    const job = createJob({ ctx, kind: "video", project: "/p", composition: "Promo" })
    job.status = "running"
    job.progress = { stage: "渲染中", renderedFrames: 60, totalFrames: 300, percent: 20, fps: 10 }
    const text = describeJob(job)
    expect(text).toContain("帧 60/300")
    expect(text).toContain("20%")
    expect(text).toContain("10.0 fps")
  })

  test("后台作业登记取消函数并可中止；未知作业返回 false", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const job = createJob({ ctx, kind: "video", project: "/p", composition: "Promo" })
    let cancelled = false
    startJob(ctx, job, async (log, register) => {
      register(() => {
        cancelled = true
      })
      log("开始")
      await new Promise((r) => setTimeout(r, 30))
      return "完成"
    })
    expect(getJob(job.id)).toBe(job)
    expect(cancelJob("nope")).toBe(false)
    // startJob 排队/启动是异步的：等取消函数登记后再中止
    for (let i = 0; i < 50 && !cancelled; i++) {
      if (cancelJob(job.id)) break
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(cancelled).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
    expect(job.status).toBe("done")
    expect(job.summary).toBe("完成")
    expect(readJobLog(job, ctx, 10)).toContain("开始")
  })
})

describe("并发上限自愈", () => {
  test("解析 Remotion 的并发拒绝消息", () => {
    expect(parseConcurrencyLimit("Maximum for --concurrency is 4 (number of cores on this system)")).toBe(4)
    expect(parseConcurrencyLimit("other error")).toBeNull()
  })

  test("并发超上限时按上限重试一次（而非直接失败）", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const attempts: number[] = []
    const browser: NativeBrowser = { close: async () => {} }
    const libs = {
      rendererDir: "/fake",
      version: "4.0.484",
      renderStill: async () => ({}),
      renderMedia: async (params: Record<string, unknown>) => {
        const concurrency = Number(params.concurrency)
        attempts.push(concurrency)
        if (concurrency > 4) throw new Error("Maximum for --concurrency is 4 (number of cores on this system)")
        return {}
      },
      getCompositions: async () => [COMPOSITION],
      selectComposition: async () => COMPOSITION,
      openBrowser: async () => browser,
      ensureBrowser: async () => {},
      makeCancelSignal: () => ({ cancelSignal: {}, cancels: 0, cancel: () => {} }),
      bundle: async () => "/fake/bundle",
    } as unknown as NativeLibs
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 8 })
    const job = createJob({ ctx, kind: "preview", project: "/p", composition: "Promo" })
    const summary = await runMediaRender({ ...baseArgs(ctx, libs, profile), job, output: "/fake/out.mp4", options: { frameRange: [0, 9] } })
    expect(attempts).toEqual([8, 4])
    expect(summary).toContain("已渲染")
    expect(readJobLog(job, ctx, 20)).toContain("超本机上限")
  })
})

describe("bench 实测调优", () => {  test("硬件编码探针失败时如实记录，并写入最优并发", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const { libs } = fakeLibs({ failMedia: (params) => (params.hardwareAcceleration === "required" ? new Error("No capable hardware encoder found") : null) })
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 8, nvidia: { vendor: "nvidia", name: "RTX 4090" }, remotionVersion: "4.0.484" })
    const job = createJob({ ctx, kind: "bench", project: "/fake/project", composition: "Promo" })
    const summary = await runBench({
      ...baseArgs(ctx, libs, profile),
      projectDir: "/fake/project",
      job,
      candidates: [8, 4],
      frameRange: [0, 29],
      benchDir: join(home, "bench"),
    })
    const tuning = readTuning(ctx)
    expect(tuning.encoderProbe?.hardware).toBe(false)
    expect(tuning.encoderProbe?.error).toContain("hardware encoder")
    expect(Object.keys(tuning.entries).length).toBe(1)
    const entry = pickTuningEntry(ctx, profile, "/fake/project", "Promo")
    expect(entry).not.toBeNull()
    expect([8, 4]).toContain(entry!.concurrency!)
    expect(summary).toContain("硬件编码探针：未通过")
    expect(summary).toContain("并发实测")
  })

  test("探针通过时记录硬件编码可用", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const { libs } = fakeLibs()
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 4, nvidia: { vendor: "nvidia", name: "RTX 3090" }, remotionVersion: "4.0.484" })
    const job = createJob({ ctx, kind: "bench", project: "/fake/project", composition: "Promo" })
    await runBench({ ...baseArgs(ctx, libs, profile), projectDir: "/fake/project", job, candidates: [4], frameRange: [0, 9], benchDir: join(home, "bench") })
    expect(readTuning(ctx).encoderProbe?.hardware).toBe(true)
  })

  test("无 GPU 时探针直接判定不可用", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const { libs } = fakeLibs()
    const profile = decideProfile({ platform: "linux", arch: "x64", cpuCount: 4 })
    const job = createJob({ ctx, kind: "bench", project: "/fake/project", composition: "Promo" })
    await runBench({ ...baseArgs(ctx, libs, profile), projectDir: "/fake/project", job, candidates: [4], frameRange: [0, 9], benchDir: join(home, "bench") })
    const probe = readTuning(ctx).encoderProbe
    expect(probe?.hardware).toBe(false)
    expect(probe?.error).toContain("未检测到 GPU")
  })
})
