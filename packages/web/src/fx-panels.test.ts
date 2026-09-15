import { describe, expect, test } from "bun:test"
import { getFxPanelsSetting } from "./fx-panels"

/* 纯判定部分（applyFxPanels 依赖真实 document.localStorage，由 style-contract 用例守 CSS 规则）。 */
describe("特效面板形态：设置读取", () => {
  test("默认毛玻璃；仅 \"matte\" 视为实底（其它值一律回落现状）", () => {
    const real = globalThis.localStorage
    const suite = (value: string | null) => {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: { getItem: () => value },
      })
      return getFxPanelsSetting()
    }
    try {
      expect(suite(null)).toBe("glass")
      expect(suite("matte")).toBe("matte")
      expect(suite("on")).toBe("glass")
      expect(suite("")).toBe("glass")
      // 存储不可用：不抛、回落默认
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: () => {
            throw new Error("denied")
          },
        },
      })
      expect(getFxPanelsSetting()).toBe("glass")
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real })
    }
  })

  test("样式契约：实底形态的 CSS 规则存在（大面板去模糊 + 加实底色）", async () => {
    const css = await Bun.file(new URL("./css/base.css", import.meta.url)).text()
    expect(css).toContain('html[data-fx-panels="matte"] header')
    expect(css).toContain('html[data-fx-panels="matte"] aside')
    expect(css).toContain('html[data-fx-panels="matte"] .composer-row')
    const rule = css.slice(css.indexOf('html[data-fx-panels="matte"] header'))
    expect(rule).toContain("backdrop-filter: none")
    expect(rule).toContain("color-mix(in srgb, var(--bg-elev) 88%, transparent)")
  })
})
