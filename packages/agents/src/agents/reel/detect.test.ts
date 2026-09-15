/**
 * 探测层单测：有效 CPU 数（与 Remotion 同规则，容器 cgroup 配额生效）、nvidia-smi 解析、Linux DRI 设备、
 * 项目侧事实（Remotion 版本 + WebGL 内容）、Chrome 缓存目录规则与目录体积统计。
 * 全部用注入依赖驱动，不读本机真实硬件、不联网。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import {
  chromeCacheDir,
  collectProbe,
  detectProjectFacts,
  dirStats,
  effectiveCpuCount,
  parseNvidiaSmi,
  resolveCpuCount,
} from "./detect"
import { clearReelEnv, makeCtx } from "./test-ctx"

describe("有效 CPU 数（Remotion 同规则）", () => {
  test("取 nproc 与 availableParallelism 的较小值（容器配额 nproc 更小时按 nproc）", () => {
    expect(resolveCpuCount(8, 4)).toBe(4)
    expect(resolveCpuCount(4, 8)).toBe(4)
    expect(resolveCpuCount(8, null)).toBe(8)
    expect(resolveCpuCount(8, 0)).toBe(8)
    expect(resolveCpuCount(0, null)).toBe(1)
    expect(resolveCpuCount(8.9, 4.2)).toBe(4)
    expect(resolveCpuCount(-3, 2)).toBe(1)
  })

  test("真实环境返回值恒为 ≥ 1 的整数且不超过 availableParallelism", () => {
    const n = effectiveCpuCount()
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(Math.max(1, availableParallelism()))
  })
})

describe("nvidia-smi 解析", () => {
  test("csv（nounits）解析出名称/驱动/显存", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4090, 550.54.14, 24564\n")).toEqual({
      name: "NVIDIA GeForce RTX 4090",
      driver: "550.54.14",
      memoryMB: 24564,
    })
  })

  test("多行取首个非空行；空输出/无设备返回 null", () => {
    expect(parseNvidiaSmi("\n  \nNVIDIA A100-SXM4-80GB, 535.104.05, 81920\n")?.name).toBe("NVIDIA A100-SXM4-80GB")
    expect(parseNvidiaSmi("")).toBeNull()
    expect(parseNvidiaSmi("not found")).toBeNull()
    expect(parseNvidiaSmi("no devices were found")).toBeNull()
  })

  test("显存字段不可解析时退化为 0（不抛错）", () => {
    expect(parseNvidiaSmi("NVIDIA T4, 470.57, [N/A]")?.memoryMB).toBe(0)
  })
})

describe("collectProbe（注入依赖）", () => {
  test("Linux + NVIDIA + DRI + 含 WebGL 的项目：事实齐备且无降级提示", async () => {
    clearReelEnv()
    const home = mkdtempSync(join(tmpdir(), "reel-detect-"))
    try {
      const { ctx } = makeCtx(home, { REEL_LIBRARY_DIR: join(home, "vendor", "reel") })
      const project = join(home, "video")
      mkdirSync(join(project, "src"), { recursive: true })
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { remotion: "4.0.484", three: "0.185.1" } }))
      writeFileSync(join(project, "src/index.ts"), "registerRoot(Root)")
      mkdirSync(join(project, "node_modules/remotion"), { recursive: true })
      writeFileSync(join(project, "node_modules/remotion/package.json"), JSON.stringify({ version: "4.0.484" }))

      const result = await collectProbe(
        ctx,
        { projectDir: project },
        {
          platform: "linux",
          arch: "x64",
          cpuCount: () => 4,
          memoryMB: () => 16384,
          readDir: () => ["card0", "renderD128"],
          exec: async () => ({ code: 0, stdout: "NVIDIA GeForce RTX 4090, 550.54, 24564\n", stderr: "" }),
          freeDiskMB: () => 500_000,
        },
      )
      expect(result.input.cpuCount).toBe(4)
      expect(result.input.memoryMB).toBe(16384)
      expect(result.input.nvidia?.name).toBe("NVIDIA GeForce RTX 4090")
      expect(result.input.renderNodes).toEqual(["/dev/dri/renderD128"])
      expect(result.input.appleSilicon).toBe(false)
      expect(result.input.remotionVersion).toBe("4.0.484")
      expect(result.input.webglContent).toBe(true)
      expect(result.nvidiaSmiRaw).toContain("RTX 4090")
      expect(result.notes.join(" ")).not.toContain("未检测到 NVIDIA")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("无 GPU、无 DRI、磁盘紧张、项目未装依赖：只记 notes，不抛错", async () => {
    clearReelEnv()
    const home = mkdtempSync(join(tmpdir(), "reel-detect-"))
    try {
      const { ctx } = makeCtx(home, { REEL_LIBRARY_DIR: join(home, "vendor", "reel") })
      const result = await collectProbe(
        ctx,
        { projectDir: join(home, "nope") },
        {
          platform: "linux",
          arch: "arm64",
          cpuCount: () => 2,
          memoryMB: () => 4096,
          readDir: () => {
            throw new Error("ENOENT")
          },
          exec: async () => ({ code: 127, stdout: "", stderr: "nvidia-smi: command not found" }),
          freeDiskMB: () => 1000,
        },
      )
      const notes = result.notes.join(" ")
      expect(result.input.nvidia).toBeNull()
      expect(result.input.renderNodes).toEqual([])
      expect(result.input.remotionVersion).toBeNull()
      expect(result.input.webglContent).toBe(false)
      expect(notes).toContain("未检测到 NVIDIA GPU")
      expect(notes).toContain("/dev/dri")
      expect(notes).toContain("磁盘空间偏低")
      expect(notes).toContain("项目内未检测到 Remotion")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("探测项抛错也只记 notes（CPU/内存/exec/磁盘全部失败）", async () => {
    clearReelEnv()
    const home = mkdtempSync(join(tmpdir(), "reel-detect-"))
    try {
      const { ctx } = makeCtx(home, { REEL_LIBRARY_DIR: join(home, "vendor", "reel") })
      const result = await collectProbe(ctx, {}, {
        platform: "linux",
        arch: "x64",
        cpuCount: () => {
          throw new Error("boom")
        },
        memoryMB: () => {
          throw new Error("boom")
        },
        exec: async () => {
          throw new Error("spawn failed")
        },
        freeDiskMB: () => {
          throw new Error("statfs failed")
        },
      })
      expect(result.input.cpuCount).toBe(1)
      expect(result.input.memoryMB).toBe(0)
      expect(result.notes.join(" ")).toContain("CPU 核数探测失败")
      expect(result.notes.join(" ")).toContain("内存探测失败")
      expect(result.notes.join(" ")).toContain("nvidia-smi 执行失败")
      expect(result.notes.join(" ")).toContain("磁盘余量探测失败")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("项目侧事实", () => {
  test("依赖声明含 three/@remotion/three 即视为 WebGL 内容", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-facts-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@remotion/three": "4.0.484" } }))
      expect(detectProjectFacts(dir).webglContent).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("依赖未声明但 src 源码引用 Canvas/WebGL 也算 WebGL 内容，并读到 Remotion 版本", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-facts-"))
    try {
      mkdirSync(join(dir, "src"), { recursive: true })
      mkdirSync(join(dir, "node_modules/remotion"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { remotion: "4.0.484", react: "19.2.7" } }))
      writeFileSync(join(dir, "src/Scene.tsx"), "import { Canvas } from '@react-three/fiber'")
      writeFileSync(join(dir, "node_modules/remotion/package.json"), JSON.stringify({ version: "4.0.500" }))
      const facts = detectProjectFacts(dir)
      expect(facts.webglContent).toBe(true)
      expect(facts.remotionVersion).toBe("4.0.500")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("纯 Remotion 项目不算 WebGL；无目录/坏 JSON 不抛错", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-facts-"))
    try {
      mkdirSync(join(dir, "src"), { recursive: true })
      writeFileSync(join(dir, "package.json"), "{ 不是 JSON")
      writeFileSync(join(dir, "src/index.ts"), "registerRoot(Root)")
      expect(detectProjectFacts(dir)).toEqual({ remotionVersion: null, webglContent: false })
      expect(detectProjectFacts(null)).toEqual({ remotionVersion: null, webglContent: false })
      expect(detectProjectFacts("/definitely/not/here")).toEqual({ remotionVersion: null, webglContent: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Chrome 缓存目录（Remotion getDownloadsCacheDir 规则）", () => {
  test("自 cwd 向上找最近的 package.json 所在目录，取 node_modules/.remotion", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-chrome-"))
    const cwd = process.cwd()
    try {
      writeFileSync(join(dir, "package.json"), "{}")
      const nested = join(dir, "packages", "app", "src")
      mkdirSync(nested, { recursive: true })
      process.chdir(nested)
      const miss = chromeCacheDir()
      expect(miss.dir).toBe(join(dir, "node_modules", ".remotion"))
      expect(miss.exists).toBe(false)
      mkdirSync(join(dir, "node_modules", ".remotion"), { recursive: true })
      const hit = chromeCacheDir()
      expect(hit.dir).toBe(join(dir, "node_modules", ".remotion"))
      expect(hit.exists).toBe(true)
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("向上找不到 package.json 时回落 <起点>/.remotion（与 Remotion 同规则）", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-chrome-"))
    try {
      // 直接注入起点（不 chdir）：起点及其祖先都无 package.json 时，应为 <起点>/.remotion
      const from = join(dir, "nope", "deeper")
      const { dir: cacheDir } = chromeCacheDir(from)
      expect(cacheDir).toBe(join(from, ".remotion"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("目录体积统计", () => {
  test("递归累计文件数与字节数；目录不存在按 0 计", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-stats-"))
    try {
      mkdirSync(join(dir, "nested"), { recursive: true })
      writeFileSync(join(dir, "a.bin"), "12345")
      writeFileSync(join(dir, "nested", "b.bin"), "1234567890")
      expect(dirStats(dir)).toEqual({ bytes: 15, files: 2 })
      expect(dirStats(join(dir, "missing"))).toEqual({ bytes: 0, files: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
