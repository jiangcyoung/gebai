/**
 * 渲染档决策单测：逐行覆盖契约 §4.2 的决策表（Linux/Windows/macOS/无 GPU 八种形态）、NVENC 版本门控、
 * REEL_GPU=off 强制软件档、实测调优覆盖与调用级覆盖的优先级、并发钳制、chromiumOf 非 WebGL 不传 gl。
 * 这些分支在没有对应硬件的开发机上无法真机验证，靠纯函数断言保证正确性。
 */
import { describe, expect, test } from "bun:test"
import type { ProbeInput } from "./detect"
import {
  chromiumOf,
  compareVersion,
  decideProfile,
  describeProfile,
  parseVersion,
  profileKey,
  type TunedEntry,
} from "./profile"

const RTX = { name: "NVIDIA GeForce RTX 4090", driver: "550.54.14", memoryMB: 24564 }
const BASE: ProbeInput = {
  platform: "linux",
  arch: "x64",
  cpuCount: 8,
  memoryMB: 32768,
  nvidia: null,
  renderNodes: [],
  appleSilicon: false,
  remotionVersion: "4.0.484",
  webglContent: false,
}
const TUNED: TunedEntry = {
  concurrency: 5,
  gl: "angle",
  chromeMode: "chrome-for-testing",
  hardwareAcceleration: "required",
  fps: 21.5,
  measuredAt: "2026-01-01T00:00:00.000Z",
}

describe("版本工具", () => {
  test("parseVersion 支持 v 前缀与预发布后缀，非法输入返回 null", () => {
    expect(parseVersion("4.0.484")).toEqual([4, 0, 484])
    expect(parseVersion("v4.1.0-rc.2")).toEqual([4, 1, 0])
    expect(parseVersion("nope")).toBeNull()
    expect(parseVersion(null)).toBeNull()
  })

  test("compareVersion 返回 -1/0/1，版本未知按「低于目标」处理", () => {
    expect(compareVersion([4, 0, 484], [4, 0, 484])).toBe(0)
    expect(compareVersion([4, 0, 483], [4, 0, 484])).toBe(-1)
    expect(compareVersion([5, 0, 0], [4, 0, 484])).toBe(1)
    expect(compareVersion(null, [4, 0, 484])).toBe(-1)
  })
})

describe("决策表：Linux + NVIDIA", () => {
  test("Remotion ≥ 4.0.484：NVENC（if-possible）+ videoBitrate + chrome-for-testing + WebGL 用 vulkan", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, webglContent: true })
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.videoBitrate).toBe("8M")
    expect(p.crf).toBeNull()
    expect(p.chromeMode).toBe("chrome-for-testing")
    expect(p.gl).toBe("vulkan")
    expect(p.reasons.join(" ")).toContain("NVENC")
    expect(p.unavailable).toEqual([])
  })

  test("非 WebGL 内容不传 gl（默认后端更优），其余同档", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, webglContent: false })
    expect(p.gl).toBeNull()
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.chromeMode).toBe("chrome-for-testing")
    expect(chromiumOf(p)).toEqual({})
  })

  test("Remotion < 4.0.484：记 unavailable 并落软件档，仍保留 GPU 光栅化", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.400", webglContent: true })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.videoBitrate).toBeNull()
    expect(p.crf).toBeNull()
    expect(p.gl).toBe("vulkan")
    expect(p.chromeMode).toBe("chrome-for-testing")
    expect(p.unavailable.join(" ")).toContain("4.0.484")
    expect(p.reasons.join(" ")).toContain("RTX 4090")
  })

  test("版本未知（未探测到）也按门控未通过处理，不冒险启用 NVENC", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, remotionVersion: null, webglContent: false })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.unavailable.join(" ")).toContain("未探测到版本")
  })

  test("边界：4.0.483 不过、4.0.484 通过、v4.0.484 也算通过", () => {
    expect(decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.483" }).hardwareAcceleration).toBe("disable")
    expect(decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "4.0.484" }).hardwareAcceleration).toBe("if-possible")
    expect(decideProfile({ ...BASE, nvidia: RTX, remotionVersion: "v4.0.484" }).hardwareAcceleration).toBe("if-possible")
  })

  test("Linux ARM64：内置 ffmpeg 无 NVENC，落软件档；gl 仅给 WebGL 内容", () => {
    const p = decideProfile({ ...BASE, arch: "arm64", nvidia: RTX, webglContent: true })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("angle-egl")
    expect(p.unavailable.join(" ")).toContain("ARM64")
    expect(decideProfile({ ...BASE, arch: "arm64", webglContent: false }).gl).toBeNull()
  })
})

describe("决策表：Linux 非 NVIDIA（DRI 光栅化）/ 无 GPU", () => {
  test("有 /dev/dri 但非 NVIDIA：软件编码 + angle-egl 光栅化，并如实说明硬件编码不可用", () => {
    const p = decideProfile({ ...BASE, renderNodes: ["/dev/dri/renderD128"], webglContent: true })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.crf).toBeNull()
    expect(p.videoBitrate).toBeNull()
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("angle-egl")
    expect(p.unavailable.join(" ")).toContain("NVENC")
  })

  test("完全无 GPU：软件 x264 + headless-shell，WebGL 内容用 swangle", () => {
    const p = decideProfile({ ...BASE, webglContent: true })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.videoBitrate).toBeNull()
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("swangle")
    expect(p.reasons.join(" ")).toContain("未检测到 GPU 硬件")
    expect(chromiumOf(p)).toEqual({ gl: "swangle" })
  })
})

describe("决策表：Windows / macOS", () => {
  test("Windows + NVIDIA：if-possible + bitrate，Chrome 保持 headless-shell、gl=angle", () => {
    const p = decideProfile({ ...BASE, platform: "win32", nvidia: RTX, webglContent: true })
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.videoBitrate).toBe("8M")
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("angle")
  })

  test("Windows + NVIDIA + 旧版本：NVENC 版本门控同样生效", () => {
    const p = decideProfile({ ...BASE, platform: "win32", nvidia: RTX, remotionVersion: "4.0.300", webglContent: false })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.unavailable.join(" ")).toContain("4.0.484")
  })

  test("macOS Apple Silicon：VideoToolbox（if-possible）+ bitrate + angle", () => {
    const p = decideProfile({ ...BASE, platform: "darwin", arch: "arm64", appleSilicon: true, webglContent: true })
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.videoBitrate).toBe("8M")
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.gl).toBe("angle")
    expect(p.reasons.join(" ")).toContain("VideoToolbox")
  })

  test("Intel/AMD（macOS/Windows）：硬件编码不可用但可 GPU 光栅化", () => {
    const mac = decideProfile({ ...BASE, platform: "darwin", arch: "x64", webglContent: true })
    expect(mac.hardwareAcceleration).toBe("disable")
    expect(mac.crf).toBeNull()
    expect(mac.gl).toBe("angle")
    expect(mac.chromeMode).toBe("headless-shell")
    expect(mac.unavailable.join(" ")).toContain("VideoToolbox")

    const win = decideProfile({ ...BASE, platform: "win32", webglContent: false })
    expect(win.hardwareAcceleration).toBe("disable")
    expect(win.gl).toBeNull()
    expect(win.unavailable.join(" ")).toContain("NVENC")
  })
})

describe("覆盖与调优", () => {
  test("REEL_GPU=off（override.gpu=off）强制软件档", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, webglContent: true }, { gpu: "off" })
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.videoBitrate).toBeNull()
    expect(p.crf).toBeNull()
    expect(p.gl).toBe("swangle")
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.reasons.join(" ")).toContain("REEL_GPU=off")
  })

  test("调用级覆盖优先于自动档，crf 可显式指定（软件档）", () => {
    const p = decideProfile(
      { ...BASE, nvidia: RTX, webglContent: true },
      { concurrency: 3, gl: null, chromeMode: "headless-shell", hardwareAcceleration: "disable", crf: 23 },
    )
    expect(p.concurrency).toBe(3)
    expect(p.source.concurrency).toBe("override")
    expect(p.source.hardware).toBe("override")
    expect(p.gl).toBeNull()
    expect(p.chromeMode).toBe("headless-shell")
    expect(p.hardwareAcceleration).toBe("disable")
    expect(p.crf).toBe(23)
  })

  test("硬件档显式要给 crf 时如实报告「硬件编码不支持 crf」", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, webglContent: false }, { crf: 18 })
    expect(p.hardwareAcceleration).toBe("if-possible")
    expect(p.crf).toBeNull()
    expect(p.videoBitrate).toBe("8M")
    expect(p.unavailable.join(" ")).toContain("不支持 crf")
  })

  test("实测调优覆盖并发/gl/chromeMode/硬件档并标 source=tuned，差异写进 reasons", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, webglContent: false }, {}, TUNED)
    expect(p.concurrency).toBe(5)
    expect(p.gl).toBe("angle")
    expect(p.chromeMode).toBe("chrome-for-testing")
    expect(p.hardwareAcceleration).toBe("required")
    expect(p.source).toEqual({ concurrency: "tuned", hardware: "tuned" })
    expect(p.reasons.join(" ")).toContain("实测调优")
    expect(p.reasons.join(" ")).toContain("并发 4 → 5")
  })

  test("自动并发取有效核数的一半（与 Remotion 官方默认同口径）", () => {
    // 帧渲染流水线含串行段，单 worker 吃不满全部核；4 核配额下两 worker 即饱和（实测 c=2 优于 c=4）
    expect(decideProfile({ ...BASE, cpuCount: 4 }).concurrency).toBe(2)
    expect(decideProfile({ ...BASE, cpuCount: 8 }).concurrency).toBe(4)
    expect(decideProfile({ ...BASE, cpuCount: 1 }).concurrency).toBe(1)
    expect(decideProfile({ ...BASE, cpuCount: 3 }).concurrency).toBe(2)
    expect(decideProfile({ ...BASE, cpuCount: 4 }).source.concurrency).toBe("auto")
  })

  test("调优与覆盖同时存在：覆盖字段优先，其余仍取实测值", () => {
    const p = decideProfile({ ...BASE, nvidia: RTX, webglContent: false }, { concurrency: 3 }, TUNED)
    expect(p.concurrency).toBe(3)
    expect(p.source.concurrency).toBe("override")
    expect(p.hardwareAcceleration).toBe("required")
    expect(p.source.hardware).toBe("tuned")
  })

  test("并发钳制在 [1, 64]", () => {
    expect(decideProfile({ ...BASE, cpuCount: 0 }).concurrency).toBe(1)
    expect(decideProfile({ ...BASE, cpuCount: 512 }).concurrency).toBe(64)
    expect(decideProfile({ ...BASE, cpuCount: 8 }, { concurrency: 999 }).concurrency).toBe(64)
    expect(decideProfile({ ...BASE, cpuCount: 8 }, { concurrency: 0 }).concurrency).toBe(1)
    expect(decideProfile({ ...BASE, cpuCount: 8 }, { concurrency: 999 }).reasons.join(" ")).toContain("钳制")
  })

  test("调优缓存键：同项目同合成稳定，不同合成/项目不同", () => {
    expect(profileKey("/p", "Promo")).toBe(profileKey("/p", "Promo"))
    expect(profileKey("/p", "Promo")).not.toBe(profileKey("/p", "Other"))
    expect(profileKey("/p", "Promo")).not.toBe(profileKey("/q", "Promo"))
  })
})

describe("chromiumOf 与描述输出", () => {
  test("非 WebGL 内容不传 gl；WebGL 内容按档传 gl", () => {
    expect(chromiumOf(decideProfile({ ...BASE, webglContent: false }))).toEqual({})
    expect(chromiumOf(decideProfile({ ...BASE, webglContent: true }))).toEqual({ gl: "swangle" })
    expect(chromiumOf(decideProfile({ ...BASE, nvidia: RTX, webglContent: true }))).toEqual({ gl: "vulkan" })
  })

  test("describeProfile 覆盖主机/GPU/编码/Chrome/并发/依据/未能启用", () => {
    const input: ProbeInput = { ...BASE, nvidia: RTX, remotionVersion: "4.0.400", webglContent: true }
    const lines = describeProfile(decideProfile(input), input).join("\n")
    expect(lines).toContain("linux/x64")
    expect(lines).toContain("RTX 4090")
    expect(lines).toContain("软件 x264")
    expect(lines).toContain("Chrome：chrome-for-testing · gl=vulkan")
    expect(lines).toContain("并发：4")
    expect(lines).toContain("未能启用")
  })
})
