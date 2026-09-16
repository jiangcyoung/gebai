/**
 * output.ts 测试：视频输出尺寸换算与校验（h264 的整数/偶数约束提前到工具入口）、
 * x264 preset 解析、草稿档常量。
 */
import { describe, expect, test } from "bun:test"
import { DRAFT, X264_PRESETS, asX264Preset, feasibleSizes, resolveVideoSize } from "./output"

describe("输出尺寸：height 优先于 scale", () => {
  test("1080p 合成取 height=720 / 540 / 360 → 整数且偶数", () => {
    expect(resolveVideoSize({ width: 1920, height: 1080, targetHeight: 720 })).toEqual({ width: 1280, height: 720, scale: 2 / 3 })
    expect(resolveVideoSize({ width: 1920, height: 1080, targetHeight: 540 })).toEqual({ width: 960, height: 540, scale: 0.5 })
    expect(resolveVideoSize({ width: 1920, height: 1080, targetHeight: 360 })).toEqual({ width: 640, height: 360, scale: 1 / 3 })
  })

  test("竖屏合成（1080×1920）：height=1080 无解（宽 607.5 非整数）——报错列出该合成的可行档", () => {
    const r = resolveVideoSize({ width: 1080, height: 1920, targetHeight: 1080 })
    expect("error" in r).toBe(true)
    if ("error" in r) {
      expect(r.error).toContain("607.5")
      expect(r.error).toContain("scale=0.5（540×960）")
      expect(r.error).toContain("scale=2/3（720×1280）")
    }
    // 同合成下能用的档位：原尺寸 / 720×1280 / 540×960 / 360×640
    expect(resolveVideoSize({ width: 1080, height: 1920, scale: 0.5 })).toEqual({ width: 540, height: 960, scale: 0.5 })
    expect(resolveVideoSize({ width: 1080, height: 1920, targetHeight: 960 })).toEqual({ width: 540, height: 960, scale: 0.5 })
  })

  test("scale 缺省为 1（原尺寸）", () => {
    expect(resolveVideoSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080, scale: 1 })
  })
})

describe("输出尺寸：不合法即报错并给可执行建议", () => {
  test("scale=0.667 → 1281×720（宽为奇数）被拒，报错列出可用档位", () => {
    const r = resolveVideoSize({ width: 1920, height: 1080, scale: 0.667 })
    expect("error" in r).toBe(true)
    if ("error" in r) {
      expect(r.error).toContain("偶数")
      expect(r.error).toContain("scale 0.667")
      expect(r.error).toContain("scale=2/3（1280×720）")
      expect(r.error).toContain("可行高度：1080/810/720/540/360/270")
    }
  })

  test("非整数尺寸被拒（height 取 721 这类会算出小数）", () => {
    const r = resolveVideoSize({ width: 1920, height: 1080, targetHeight: 721 })
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain("整数")
  })

  test("feasibleSizes 只给出真正可用的档（整数 + 偶数）", () => {
    expect(feasibleSizes(1920, 1080).map((o) => `${o.width}×${o.height}`)).toEqual(["1920×1080", "1440×810", "1280×720", "960×540", "640×360", "480×270"])
    expect(feasibleSizes(1080, 1920).map((o) => `${o.width}×${o.height}`)).toEqual(["1080×1920", "810×1440", "720×1280", "540×960", "360×640", "270×480"])
  })

  test("非正数参数被拒（scale=0 / height=-1）", () => {
    expect(resolveVideoSize({ width: 1920, height: 1080, scale: 0 })).toMatchObject({ error: expect.stringContaining("scale 必须是正数") })
    expect(resolveVideoSize({ width: 1920, height: 1080, targetHeight: -1 })).toMatchObject({ error: expect.stringContaining("height 必须是正数") })
  })

  test("合法比例可用（2/3、0.5、1/3）", () => {
    for (const scale of [2 / 3, 0.5, 1 / 3]) {
      expect("error" in resolveVideoSize({ width: 1920, height: 1080, scale })).toBe(false)
    }
  })
})

describe("x264 preset 解析", () => {
  test("合法值原样返回（大小写与空白容错）", () => {
    expect(asX264Preset("ultrafast")).toBe("ultrafast")
    expect(asX264Preset("  VeryFast ")).toBe("veryfast")
    expect(asX264Preset("placebo")).toBe("placebo")
  })

  test("非法值与非法类型返回 null（由调用方决定报错）", () => {
    expect(asX264Preset("turbo")).toBeNull()
    expect(asX264Preset(undefined)).toBeNull()
    expect(asX264Preset(3)).toBeNull()
  })

  test("常量表与 Remotion 合法集一致（10 档）", () => {
    expect(X264_PRESETS.length).toBe(10)
    expect(X264_PRESETS[0]).toBe("ultrafast")
    expect(X264_PRESETS.at(-1)).toBe("placebo")
  })
})

describe("草稿档常量", () => {
  test("半分辨率 + ultrafast + 较低帧图质量", () => {
    expect(DRAFT.scale).toBe(0.5)
    expect(DRAFT.x264Preset).toBe("ultrafast")
    expect(DRAFT.jpegQuality).toBe(70)
    // 草稿档的默认尺寸必须自身合法（1080p 合成 → 960×540）
    expect("error" in resolveVideoSize({ width: 1920, height: 1080, scale: DRAFT.scale })).toBe(false)
  })
})
