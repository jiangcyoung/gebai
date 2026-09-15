/**
 * 探测层单测：有效 CPU 数（与 Remotion 同规则，容器 cgroup 配额生效）、GPU/DRI 采集、项目侧事实
 * （Remotion 版本 + WebGL 内容）——collectProbe 以注入依赖驱动，不读本机真实硬件。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectProbe, detectProjectFacts, effectiveCpuCount, resolveCpuCount } from "./detect"
import { clearShotcraftEnv, makeCtx } from "./test-ctx"

describe("有效 CPU 数（Remotion 同规则）", () => {
  test("取 nproc 与 availableParallelism 的较小值", () => {
    expect(resolveCpuCount(8, 4)).toBe(4)
    expect(resolveCpuCount(4, 8)).toBe(4)
    expect(resolveCpuCount(8, null)).toBe(8)
    expect(resolveCpuCount(8, 0)).toBe(8)
    expect(resolveCpuCount(0, null)).toBe(1)
    expect(resolveCpuCount(8.9, 4.2)).toBe(4)
  })

  test("真实环境返回值恒 ≥ 1", () => {
    const n = effectiveCpuCount()
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(1)
  })
})

describe("collectProbe（注入依赖）", () => {
  test("解析 NVIDIA GPU、DRI 设备与项目侧事实", async () => {
    clearShotcraftEnv()
    const home = mkdtempSync(join(tmpdir(), "shotcraft-detect-"))
    try {
      const { ctx } = makeCtx(home)
      const project = join(home, "video")
      mkdirSync(join(project, "src"), { recursive: true })
      writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { remotion: "4.0.484", three: "0.185.1" } }))
      writeFileSync(join(project, "src/index.ts"), "registerRoot(Root);")
      mkdirSync(join(project, "node_modules/remotion"), { recursive: true })
      writeFileSync(join(project, "node_modules/remotion/package.json"), JSON.stringify({ version: "4.0.484" }))

      const res = await collectProbe(
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
      expect(res.input.cpuCount).toBe(4)
      expect(res.input.nvidia?.name).toBe("NVIDIA GeForce RTX 4090")
      expect(res.input.renderNodes).toEqual(["/dev/dri/renderD128"])
      expect(res.input.webglContent).toBe(true)
      expect(res.input.remotionVersion).toBe("4.0.484")
      expect(res.input.appleSilicon).toBe(false)
      expect(res.notes.join(" ")).not.toContain("nvidia-smi 不可用")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("无 GPU 与无 DRI 设备时给出探测说明，缺依赖项目不报错", async () => {
    clearShotcraftEnv()
    const home = mkdtempSync(join(tmpdir(), "shotcraft-detect-"))
    try {
      const { ctx } = makeCtx(home)
      const res = await collectProbe(
        ctx,
        { projectDir: join(home, "nope") },
        {
          platform: "linux",
          arch: "arm64",
          cpuCount: () => 2,
          memoryMB: () => 4096,
          readDir: () => [],
          exec: async () => ({ code: 127, stdout: "", stderr: "nvidia-smi: not found" }),
          freeDiskMB: () => 1000,
        },
      )
      expect(res.input.nvidia).toBeNull()
      expect(res.notes.join(" ")).toContain("nvidia-smi 不可用")
      expect(res.notes.join(" ")).toContain("/dev/dri")
      expect(res.notes.join(" ")).toContain("磁盘空间偏低")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("项目侧事实", () => {
  test("源码引用 Three/WebGL 也算含 WebGL 内容", () => {
    const dir = mkdtempSync(join(tmpdir(), "shotcraft-facts-"))
    try {
      mkdirSync(join(dir, "src"), { recursive: true })
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { remotion: "4.0.484" } }))
      writeFileSync(join(dir, "src/Scene.tsx"), "import { Canvas } from '@react-three/fiber'")
      const facts = detectProjectFacts(dir, { platform: "linux", arch: "x64" })
      expect(facts.webglContent).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("无项目目录时返回空事实", () => {
    expect(detectProjectFacts(null).remotionVersion).toBeNull()
    expect(detectProjectFacts("/definitely/not/here").webglContent).toBe(false)
  })
})
