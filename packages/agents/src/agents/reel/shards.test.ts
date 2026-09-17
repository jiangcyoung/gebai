/**
 * 分片纯逻辑单测：帧段等分、分片规划（阈值/核数/饱和点/调用级覆盖）、ffmpeg 解析、拼接与合轨的外部件错误路径。
 * 全部不依赖本机 GPU、ffmpeg 或网络。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MAX_SHARDS,
  MIN_TOTAL_FRAMES_FOR_AUTO_SHARD,
  PAGES_PER_SHARD,
  concatVideoSegments,
  muxAudioVideo,
  planShards,
  resolveShardFfmpeg,
  splitFrameRange,
} from "./shards"

describe("帧段等分 splitFrameRange", () => {
  test("整除时逐段等长、首尾相接（闭区间不重叠）", () => {
    expect(splitFrameRange(0, 299, 4)).toEqual([
      [0, 74],
      [75, 149],
      [150, 224],
      [225, 299],
    ])
  })

  test("除不尽时余数分给前若干片，总量与首尾不变", () => {
    const parts = splitFrameRange(10, 19, 3)
    expect(parts).toEqual([
      [10, 13],
      [14, 16],
      [17, 19],
    ])
    expect(parts[0]![0]).toBe(10)
    expect(parts[parts.length - 1]![1]).toBe(19)
    for (let i = 1; i < parts.length; i++) expect(parts[i]![0]).toBe(parts[i - 1]![1] + 1)
  })

  test("不分片原样返回；片数超过帧数时按帧数收口", () => {
    expect(splitFrameRange(5, 9, 1)).toEqual([[5, 9]])
    expect(splitFrameRange(5, 5, 4)).toEqual([[5, 5]])
    const many = splitFrameRange(0, 2, 10)
    expect(many.length).toBe(3)
    expect(many).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ])
  })
})

describe("分片规划 planShards", () => {
  test("调用级指定优先，并按实测饱和点封顶", () => {
    expect(planShards({ totalFrames: 10, cpuCount: 4, override: 3 }).count).toBe(3)
    const capped = planShards({ totalFrames: 10, cpuCount: 4, override: 99 })
    expect(capped.count).toBe(MAX_SHARDS)
    expect(capped.reason).toContain("封顶")
    expect(planShards({ totalFrames: 10, cpuCount: 4, override: 0 }).count).toBe(1)
  })

  test("自动档：帧数不足阈值不分片", () => {
    const plan = planShards({ totalFrames: MIN_TOTAL_FRAMES_FOR_AUTO_SHARD - 1, cpuCount: 28 })
    expect(plan.count).toBe(1)
    expect(plan.reason).toContain("低于自动分片阈值")
  })

  test("自动档：取帧数允许、核数允许、饱和点三者的最小值", () => {
    // 1350 帧 · 28 核 → 帧数允许 22、核数允许 7、饱和点 6 → 6
    expect(planShards({ totalFrames: 1350, cpuCount: 28 }).count).toBe(MAX_SHARDS)
    // 核数少时被核数卡住：8 核 → 允许 2 片
    expect(planShards({ totalFrames: 1350, cpuCount: 8 }).count).toBe(2)
    // 帧数少时被帧数卡住
    expect(planShards({ totalFrames: 180, cpuCount: 28 }).count).toBe(3)
    expect(planShards({ totalFrames: 180, cpuCount: 28 }).pagesPerShard).toBe(PAGES_PER_SHARD)
  })

  test("核数取不到时至少 1 片（不因探测失败而误判）", () => {
    expect(planShards({ totalFrames: 1000, cpuCount: 0 }).count).toBe(1)
    expect(planShards({ totalFrames: 1000, cpuCount: Number.NaN }).count).toBe(1)
  })

  test("实测 CPU 配额受限 → 即使帧数很长也单浏览器（分片只会加剧争抢）", () => {
    // 实测形状：4 核配额容器 · 1000 帧 · 墙钟 138s · 本容器用掉 512 CPU 秒 → 占 3.7/4 核
    const measured = { frames: 1000, wallMs: 138_000, cpuSeconds: 512, cpuSource: "cgroup" as const, cores: 4, measuredAt: "2026-09-17T00:00:00.000Z" }
    const plan = planShards({ totalFrames: 5000, cpuCount: 8, measured })
    expect(plan.count).toBe(1)
    expect(plan.reason).toContain("CPU 配额受限")
    expect(plan.reason).toContain("3.7/4")
  })

  test("实测 CPU 明显富余 → 按可用核数切（单个浏览器卡在截帧通道的场景）", () => {
    // 实测形状：8 核、1000 帧、墙钟 27s、只用 24 CPU 秒 → 占 0.9/8 核
    const measured = { frames: 1000, wallMs: 27_000, cpuSeconds: 24, cpuSource: "cgroup" as const, cores: 8, measuredAt: "2026-09-17T00:00:00.000Z" }
    const plan = planShards({ totalFrames: 5000, cpuCount: 8, measured })
    expect(plan.count).toBe(8 > MAX_SHARDS ? MAX_SHARDS : 8)
    expect(plan.reason).toContain("CPU 富余")
  })

  test("宿主全局（proc）口径不参与判定；无实测时回落核数保守推算", () => {
    const hostWide = { frames: 1000, wallMs: 100_000, cpuSeconds: 800, cpuSource: "proc" as const, cores: 4, measuredAt: "2026-09-17T00:00:00.000Z" }
    // 宿主读数再高也不能拿它下结论（含其他租户）——仍按核数推算：8 核 → 2 片
    expect(planShards({ totalFrames: 5000, cpuCount: 8, measured: hostWide }).count).toBe(2)
  })

  test("实测受限时显式指定分片仍生效，但如实告出与实测的冲突", () => {
    const measured = { frames: 1000, wallMs: 138_000, cpuSeconds: 512, cpuSource: "cgroup" as const, cores: 4, measuredAt: "2026-09-17T00:00:00.000Z" }
    const plan = planShards({ totalFrames: 5000, cpuCount: 4, override: 4, measured })
    expect(plan.count).toBe(4)
    expect(plan.reason).toContain("调用级指定")
    expect(plan.reason).toContain("大概率更慢")
  })
})

describe("ffmpeg 解析 resolveShardFfmpeg", () => {
  test("优先用配置的 binariesDirectory", () => {
    const home = mkdtempSync(join(tmpdir(), "reel-shards-"))
    try {
      const bin = join(home, "bin")
      mkdirSync(bin, { recursive: true })
      const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
              writeFileSync(join(bin, exe), "")
      expect(resolveShardFfmpeg({ binariesDirectory: bin })).toBe(join(bin, exe))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("其次在运行时依赖里找 compositor 包；都没有返回 null", () => {
    const home = mkdtempSync(join(tmpdir(), "reel-shards-"))
    try {
      const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
      const roots = [join(home, "runtime")]
      const pkgByPlatform: Record<string, string> = {
        win32: "@remotion/compositor-win32-x64-msvc",
        darwin: "@remotion/compositor-darwin-arm64",
        linux: "@remotion/compositor-linux-x64-gnu",
      }
      const pkg = pkgByPlatform[process.platform]
      if (pkg) {
        const dir = join(roots[0]!, "node_modules", ...pkg.split("/"))
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, exe), "")
        expect(resolveShardFfmpeg({ roots })).toBe(join(dir, exe))
      }
      expect(resolveShardFfmpeg({ roots: [join(home, "empty")] })).toBeNull()
      expect(resolveShardFfmpeg({})).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("拼接与合轨的失败路径", () => {
  test("拼接清单路径归一为正斜杠；ffmpeg 不可用时报错带上下文", () => {
    const home = mkdtempSync(join(tmpdir(), "reel-shards-"))
    try {
      const list = join(home, "concat.txt")
      const segments = [join(home, "a's.mp4"), join(home, "seg-01.mp4")]
      expect(() =>
        concatVideoSegments({ ffmpeg: join(home, "不存在-ffmpeg"), segments, output: join(home, "out.mp4"), listPath: list }),
      ).toThrow(/分片拼接失败/)
      // 清单在调用 ffmpeg 前落盘：写入即可验证转义与路径归一（反斜杠会破坏 concat 清单语法）
      const body = readFileSync(list, "utf8")
      // 反斜杠路径会破坏 concat 清单语法（Windows 路径必须归一为正斜杠）
      expect(body).not.toMatch(/[A-Za-z]:\\/)
      expect(body).toContain("a'\\''s.mp4")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("合轨失败抛出带上下文的错误（不静默）", () => {
    const home = mkdtempSync(join(tmpdir(), "reel-shards-"))
    try {
      expect(() =>
        muxAudioVideo({
          ffmpeg: join(home, "不存在-ffmpeg"),
          video: join(home, "v.mp4"),
          audio: join(home, "a.aac"),
          output: join(home, "o.mp4"),
        }),
      ).toThrow(/音视频合轨失败/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
