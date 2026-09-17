/**
 * browser-render.ts 测试：通道常量与参数校验、帧段解析（与 Remotion 同口径）、
 * 以及不依赖真实浏览器的失败路径（缺可执行文件时给出可操作报错）。
 *
 * 真实通道（CDP 自驱 + drawElementImage + WebCodecs）需要浏览器与真机渲染，由集成验证覆盖，不在此处跑。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BACKEND_ENV,
  BROWSER_BACKENDS,
  CANVAS_DRAW_ELEMENT_FLAG,
  audioPeak,
  isBrowserBackend,
  renderAudioTrack,
  resolveFrameSpan,
  runBrowserRender,
} from "./browser-render"
import { resolveShardFfmpeg } from "./shards"
import { makeCtx } from "./test-ctx"
import type { VideoConfig } from "./runtime"

const comp: VideoConfig = { id: "Reel", width: 1920, height: 1080, fps: 30, durationInFrames: 300 }

describe("通道常量与判定", () => {
  test("浏览器通道只有 dom-canvas 与 record；remotion/canvas 不算浏览器通道", () => {
    expect([...BROWSER_BACKENDS]).toEqual(["dom-canvas", "record"])
    expect(isBrowserBackend("dom-canvas")).toBe(true)
    expect(isBrowserBackend("record")).toBe(true)
    expect(isBrowserBackend("remotion")).toBe(false)
    expect(isBrowserBackend("canvas")).toBe(false)
    expect(isBrowserBackend("")).toBe(false)
  })

  test("dom-canvas 的 Blink 开关与默认通道环境变量名固定（文档与实现同源）", () => {
    expect(CANVAS_DRAW_ELEMENT_FLAG).toBe("--enable-blink-features=CanvasDrawElement")
    expect(BACKEND_ENV).toBe("GEBAI_REEL_BACKEND")
  })
})

describe("帧段解析（含端点、可到片尾）", () => {
  test("整片：0 到 durationInFrames-1", () => {
    expect(resolveFrameSpan(comp)).toEqual([0, 299])
    expect(resolveFrameSpan(comp, null)).toEqual([0, 299])
  })

  test("显式区间含端点；片尾用 null 表示", () => {
    expect(resolveFrameSpan(comp, [75, 104])).toEqual([75, 104])
    expect(resolveFrameSpan(comp, [100, null])).toEqual([100, 299])
  })

  test("越界收敛到片尾；起点为负收敛到 0；区间反了也不返回空段", () => {
    expect(resolveFrameSpan(comp, [280, 999])).toEqual([280, 299])
    expect(resolveFrameSpan(comp, [-10, 5])).toEqual([0, 5])
    expect(resolveFrameSpan(comp, [200, 100])).toEqual([200, 200])
  })

  test("单帧区间合法（still 之外也可能用到）", () => {
    expect(resolveFrameSpan(comp, [0, 0])).toEqual([0, 0])
    expect(resolveFrameSpan(comp, [299, 299])).toEqual([299, 299])
  })
})

describe("音轨：静音识别与失败路径", () => {
  // 真 ffmpeg 在共享运行时里（仓库 vendor/ 下）——拿不到就跳过（不把环境依赖变成必败用例）
  const repoRuntime = join(import.meta.dir, "..", "..", "..", "..", "..", "vendor", "reel", "runtime")
  const ffmpeg = resolveShardFfmpeg({ roots: [repoRuntime] })
  const tone = (file: string, seconds = 0.2) =>
    Bun.spawnSync([ffmpeg as string, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=880:duration=${seconds}`, "-y", file])
  const silence = (file: string, seconds = 0.2) =>
    Bun.spawnSync([
      ffmpeg as string,
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      String(seconds),
      "-y",
      file,
    ])

  test.skipIf(!ffmpeg)("audioPeak：有声远大于 0、静音为 0、读不到时返回 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-audio-"))
    try {
      const on = join(dir, "tone.wav")
      const off = join(dir, "silence.wav")
      expect(tone(on).exitCode).toBe(0)
      expect(silence(off).exitCode).toBe(0)
      expect(audioPeak(ffmpeg as string, on) ?? 0).toBeGreaterThan(1000)
      expect(audioPeak(ffmpeg as string, off)).toBe(0)
      expect(audioPeak(ffmpeg as string, join(dir, "missing.wav"))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!ffmpeg)("renderAudioTrack：静音轨不当成有声（无音频标签的合成保持无声）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-audio-"))
    try {
      const out = join(dir, "out.aac")
      const libs = {
        renderMedia: async (opts: { outputLocation: string }) => {
          silence(opts.outputLocation)
          return { ok: true }
        },
      } as unknown as Parameters<typeof renderAudioTrack>[0]["libs"]
      const res = await renderAudioTrack({
        libs,
        serveUrl: dir,
        composition: comp,
        inputProps: {},
        browser: {} as never,
        frameRange: [0, 29],
        output: out,
        ffmpeg,
      })
      expect(res.ok).toBe(false)
      expect(res.reason).toMatch(/没有音频内容/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!ffmpeg)("renderAudioTrack：有声音时 ok=true 并给出字节数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-audio-"))
    try {
      const out = join(dir, "out.aac")
      const libs = {
        renderMedia: async (opts: { outputLocation: string }) => {
          tone(opts.outputLocation, 0.3)
          return { ok: true }
        },
      } as unknown as Parameters<typeof renderAudioTrack>[0]["libs"]
      const res = await renderAudioTrack({
        libs,
        serveUrl: dir,
        composition: comp,
        inputProps: {},
        browser: {} as never,
        frameRange: [0, 29],
        output: out,
        ffmpeg,
      })
      expect(res.ok).toBe(true)
      expect(res.bytes).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("renderAudioTrack：音频通道报错/无产出 → ok=false 且原因可读（不阻断出片）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-audio-"))
    try {
      const throwing = { renderMedia: async () => { throw new Error("模拟音频通道失败") } } as unknown as Parameters<typeof renderAudioTrack>[0]["libs"]
      const failed = await renderAudioTrack({
        libs: throwing, serveUrl: dir, composition: comp, inputProps: {}, browser: {} as never,
        frameRange: [0, 29], output: join(dir, "a.aac"),
      })
      expect(failed.ok).toBe(false)
      expect(failed.reason).toMatch(/音频通道渲染失败/)

      const empty = { renderMedia: async () => ({ ok: true }) } as unknown as Parameters<typeof renderAudioTrack>[0]["libs"]
      const none = await renderAudioTrack({
        libs: empty, serveUrl: dir, composition: comp, inputProps: {}, browser: {} as never,
        frameRange: [0, 29], output: join(dir, "b.aac"),
      })
      expect(none.ok).toBe(false)
      expect(none.reason).toMatch(/没有产出内容/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("参数校验与失败路径（不启真实浏览器）", () => {
  test("缺浏览器可执行文件 → 明确报错并指向 reel_setup", async () => {
    const home = mkdtempSync(join(tmpdir(), "reel-br-home-"))
    const { ctx } = makeCtx(home, {})
    try {
      await expect(
        runBrowserRender({
          ctx,
          backend: "dom-canvas",
          serveUrl: "/nonexistent-bundle",
          composition: comp,
          width: 1920,
          height: 1080,
          fps: 30,
          output: join(home, "out.mp4"),
          browserExecutable: null,
          log: () => {},
        }),
      ).rejects.toThrow(/浏览器通道需要明确的可执行文件路径/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("空合成（durationInFrames=0）→ 明确报错，不静默产出空片", async () => {
    const home = mkdtempSync(join(tmpdir(), "reel-br-home-"))
    const { ctx } = makeCtx(home, {})
    const exe = join(home, "fake-chrome")
    writeFileSync(exe, "")
    try {
      // 帧段钳制会把 0 帧合成掩盖成 1 帧，故必须在入口就拦下（否则会产出空片）
      await expect(
        runBrowserRender({
          ctx,
          backend: "record",
          serveUrl: home,
          composition: { ...comp, durationInFrames: 0 },
          width: 1920,
          height: 1080,
          fps: 30,
          output: join(home, "out.mp4"),
          browserExecutable: exe,
          log: () => {},
        }),
      ).rejects.toThrow(/没有任何帧/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
