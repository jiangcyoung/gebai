/**
 * 渲染档决策单测：覆盖 GPU 分支（NVENC / VideoToolbox / 非 NVIDIA）、平台与版本门控、WebGL 光栅化后端、
 * 调用级覆盖与实测调优套用——这些分支在无 GPU 的开发机上无法真机验证，靠纯函数断言保证正确性。
 */
import { describe, expect, test } from "bun:test"
import {
  compareVersion,
  decideProfile,
  describeProfile,
  hasWebglDependencies,
  hasWebglImports,
  machineSignature,
  parseNvidiaSmi,
  parseVersion,
  supports,
  tuningKey,
  type ProbeInput,
} from "./profile"

const BASE: ProbeInput = { platform: "linux", arch: "x64", cpuCount: 8 }
const RTX = { vendor: "nvidia" as const, name: "NVIDIA GeForce RTX 4090", driver: "550.54.14", memoryMB: 24564 }

describe("版本工具", () => {
  test("parseVersion / compareVersion", () => {
    expect(parseVersion("4.0.484")).toEqual([4, 0, 484])
    expect(parseVersion("v4.1.0-rc.2")).toEqual([4, 1, 0])
    expect(parseVersion("nope")).toBeNull()
    expect(compareVersion([4, 0, 484], [4, 0, 228])).toBeGreaterThan(0)
    expect(compareVersion([4, 0, 484], [4, 0, 484])).toBe(0)
    expect(compareVersion([3, 9, 9], [4, 0, 0])).toBeLessThan(0)
  })

  test("能力门控：NVENC 需 4.0.484，chromeMode 需 4.0.248；版本未知时不误判为不支持", () => {
    expect(supports("4.0.484", "nvenc")).toBe(true)
    expect(supports("4.0.400", "nvenc")).toBe(false)
    expect(supports("4.0.248", "chromeMode")).toBe(true)
    expect(supports(null, "nvenc")).toBe(true)
    expect(supports(null, "chromeMode")).toBe(true)
  })
})

describe("GPU 探测解析", () => {
  test("nvidia-smi csv 解析", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 4080, 551.23, 16376\n")).toEqual({
      vendor: "nvidia",
      name: "NVIDIA GeForce RTX 4080",
      driver: "551.23",
      memoryMB: 16376,
    })
  })

  test("空输出/无设备不产生 GPU", () => {
    expect(parseNvidiaSmi("")).toBeNull()
    expect(parseNvidiaSmi("not found")).toBeNull()
  })
})

describe("WebGL 内容判定", () => {
  test("按依赖声明判定", () => {
    expect(hasWebglDependencies(JSON.stringify({ dependencies: { three: "0.185.1" } }))).toBe(true)
    expect(hasWebglDependencies(JSON.stringify({ devDependencies: { "@remotion/three": "4.0.484" } }))).toBe(true)
    expect(hasWebglDependencies(JSON.stringify({ dependencies: { remotion: "4.0.484", react: "19.2.7" } }))).toBe(false)
    expect(hasWebglDependencies("{not json")).toBe(false)
  })

  test("按源码引用判定", () => {
    expect(hasWebglImports(["import { Canvas } from '@react-three/fiber'"])) .toBe(true)
    expect(hasWebglImports(["const t = require('three')"])).toBe(true)
    expect(hasWebglImports(["import { AbsoluteFill } from 'remotion'"])).toBe(false)
  })
})

describe("渲染档决策：无 GPU", () => {
  test("软件档：不传 gl、headless-shell、并发取满核数", () => {
    const p = decideProfile({ ...BASE, webglContent: true })
    expect(p.gpu).toBeNull()
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.hardwareEncoder).toBeNull()
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("swangle")
    expect(p.videoBitrate).toBeNull()
    expect(p.concurrency).toBe(8)
  })

  test("非 WebGL 内容不指定 gl（默认后端最优）", () => {
    const p = decideProfile({ ...BASE, webglContent: false })
    expect(p.gl).toBeNull()
  })

  test("有 GPU 但请求 required 时如实报告无法满足", () => {
    const p = decideProfile({ ...BASE, webglContent: false, overrides: { hardwareAcceleration: "required" } })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.unavailable.join("")).toContain("required")
  })
})

describe("渲染档决策：Linux + NVIDIA", () => {
  test("4.0.484：NVENC 硬件编码 + chrome-for-testing + vulkan + 8M 码率", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.484", webglContent: true })
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.hardwareEncoder).toBe("h264_nvenc")
    expect(p.chromeMode).toBe("chrome-for-testing")
    expect(p.gl).toBe("vulkan")
    expect(p.videoBitrate).toBe("8M")
    expect(p.reasons.join(" ")).toContain("NVENC")
  })

  test("版本低于 4.0.484：不启用 NVENC 并给出原因，其余仍可用 GPU 光栅化", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.400", webglContent: true })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.unavailable.join(" ")).toContain("4.0.484")
    expect(p.gl).toBe("vulkan")
    expect(p.chromeMode).toBe("chrome-for-testing")
  })

  test("Linux ARM64：内置 ffmpeg 不含 NVENC，落软件编码", () => {
    const p = decideProfile({ ...BASE, arch: "arm64", nvidia: RTX, remotionVersion: "4.0.484", webglContent: false })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.unavailable.join(" ")).toContain("ARM64")
  })
})

describe("渲染档决策：Windows / macOS", () => {
  test("Windows + NVIDIA：NVENC，但 Chrome 模式保持 headless-shell（官方只在 Linux GPU 场景建议 chrome-for-testing）", () => {
    const p = decideProfile({ ...BASE, platform: "win32", nvidia: RTX, remotionVersion: "4.0.484", webglContent: true })
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("angle")
  })

  test("macOS Apple Silicon：VideoToolbox + angle", () => {
    const p = decideProfile({ ...BASE, platform: "darwin", arch: "arm64", appleSilicon: true, remotionVersion: "4.0.484", webglContent: true })
    expect(p.gpu?.vendor).toBe("apple")
    expect(p.hardwareEncoder).toBe("h264_videotoolbox")
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.gl).toBe("angle")
    expect(p.chromeMode).toBe("headless-shell")
  })

  test("Intel/AMD GPU：硬件编码不可用（Remotion 仅支持 NVENC/VideoToolbox），但可用 GPU 光栅化", () => {
    const p = decideProfile({ ...BASE, renderNodes: ["/dev/dri/renderD128"], remotionVersion: "4.0.484", webglContent: true })
    expect(p.gpu?.vendor).toBe("unknown")
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.gl).toBe("angle-egl")
    expect(p.chromeMode).toBe("chrome-for-testing")
  })
})

describe("覆盖与调优", () => {
  test("SHOTCRAFT_GPU=off 强制软件档", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.484", gpuPolicy: "off", webglContent: true })
    expect(p.gpu).toBeNull()
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.gl).toBe("swangle")
    expect(p.reasons.join(" ")).toContain("off")
  })

  test("调用级覆盖优先于自动档", () => {
    const p = decideProfile({
      ...BASE,
      nvidia: RTX,
      remotionVersion: "4.0.484",
      webglContent: true,
      overrides: { concurrency: 3, gl: "off", chromeMode: "headless-shell", hardwareAcceleration: "disable" },
    })
    expect(p.concurrency).toBe(3)
    expect(p.gl).toBeNull()
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.hardwareAcceleration).toBe("disable")
  })

  test("实测调优覆盖并发与硬件档", () => {
    const p = decideProfile({
      ...BASE,
      nvidia: RTX,
      remotionVersion: "4.0.484",
      webglContent: false,
      tuning: { concurrency: 5, gl: null, chromeMode: "chrome-for-testing", hardwareAcceleration: "required", fps: 21.5, measuredAt: "2026-01-01T00:00:00.000Z" },
    })
    expect(p.fromTuning).toBe(true)
    expect(p.concurrency).toBe(5)
    expect(p.chromeMode).toBe("chrome-for-testing")
    expect(p.hardwareAcceleration).toBe("required")
    expect(p.reasons.join(" ")).toContain("实测调优")
  })

  test("并发数被夹在 [1,64]", () => {
    expect(decideProfile({ ...BASE, cpuCount: 0 }).concurrency).toBe(1)
    expect(decideProfile({ ...BASE, cpuCount: 512 }).concurrency).toBe(64)
  })

  test("签名与调优键稳定且区分形态", () => {
    const a = machineSignature({ platform: "linux", arch: "x64", cpuCount: 8, gpu: null, remotionVersion: "4.0.484", webglContent: false })
    const b = machineSignature({ platform: "linux", arch: "x64", cpuCount: 8, gpu: null, remotionVersion: "4.0.484", webglContent: false })
    const c = machineSignature({ platform: "linux", arch: "x64", cpuCount: 8, gpu: RTX, remotionVersion: "4.0.484", webglContent: false })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(tuningKey(a, "/p", "Promo")).toBe(tuningKey(a, "/p", "Promo"))
    expect(tuningKey(a, "/p", "Promo")).not.toBe(tuningKey(a, "/p", "Other"))
  })
})

describe("描述输出", () => {
  test("含主机/GPU/编码/Chrome/并发与不可用项", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.400", webglContent: true, memoryMB: 32768 })
    const text = describeProfile(p)
    expect(text).toContain("RTX 4090")
    expect(text).toContain("并发：8")
    expect(text).toContain("未能启用")
  })
})
