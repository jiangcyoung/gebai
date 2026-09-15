import { describe, expect, test } from "bun:test"
import { FX_ACC_MAX, FX_BUSY_FPS, FX_FADE_FPS, FX_LOW_FPS, FX_MAX_DPR, FX_TYPING_FPS, FX_TYPING_IDLE_MS, isTextEntry, targetGap } from "./theme-fx"

/** 最小元素替身：输入降载判定只读 tagName / type / isContentEditable 三个属性。 */
const node = (tagName: string, props: Record<string, unknown> = {}) =>
  ({ tagName, isContentEditable: false, ...props }) as unknown as EventTarget

describe("theme-fx 输入降载判定", () => {
  test("文本输入元素命中", () => {
    expect(isTextEntry(node("TEXTAREA"))).toBe(true)
    expect(isTextEntry(node("INPUT"))).toBe(true) // type 缺省即 text
    expect(isTextEntry(node("INPUT", { type: "text" }))).toBe(true)
    expect(isTextEntry(node("INPUT", { type: "search" }))).toBe(true)
    expect(isTextEntry(node("INPUT", { type: "NUMBER" }))).toBe(true)
    expect(isTextEntry(node("DIV", { isContentEditable: true }))).toBe(true)
  })

  test("非文本控件与空目标不命中", () => {
    for (const type of ["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image", "hidden"]) {
      expect(isTextEntry(node("INPUT", { type }))).toBe(false)
    }
    expect(isTextEntry(node("DIV"))).toBe(false)
    expect(isTextEntry(node("BUTTON"))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
    expect(isTextEntry({} as unknown as EventTarget)).toBe(false)
  })
})

describe("theme-fx 输入降载档位", () => {
  test("目标绘制间隔小于累积上限：否则该档位累积永远追不上、静默变成完全不绘制", () => {
    expect(1 / FX_TYPING_FPS).toBeLessThan(FX_ACC_MAX)
    expect(1 / FX_LOW_FPS).toBeLessThan(FX_ACC_MAX)
    expect(1 / FX_BUSY_FPS).toBeLessThan(FX_ACC_MAX)
  })

  test("打字档不比聚焦档更费（打字是最需要即时反馈的交互）", () => {
    expect(FX_TYPING_FPS).toBeLessThanOrEqual(FX_LOW_FPS)
    expect(FX_TYPING_IDLE_MS).toBeGreaterThan(0)
  })

  test("满帧档无间隔下限；会话运行中降频", () => {
    expect(targetGap("full", false)).toBe(0)
    expect(targetGap("full", true)).toBeCloseTo(1 / FX_BUSY_FPS, 6)
  })

  test("多来源取更慢者（输入档与运行档叠加，不会互相抵消）", () => {
    expect(targetGap("low", true)).toBeCloseTo(1 / FX_LOW_FPS, 6) // 15fps 比 24fps 慢
    expect(targetGap("typing", true)).toBeCloseTo(1 / FX_TYPING_FPS, 6)
    expect(targetGap("typing", false)).toBeCloseTo(1 / FX_TYPING_FPS, 6)
  })

  test("特效画布分辨率上限：不低于 1（低于 1 在普通屏上也模糊）、不高于 2", () => {
    expect(FX_MAX_DPR).toBeGreaterThanOrEqual(1)
    expect(FX_MAX_DPR).toBeLessThanOrEqual(2)
  })

  test("全屏渐隐降频帧率高于最低绘制档（否则降频反成主导成本）", () => {
    expect(FX_FADE_FPS).toBeGreaterThan(FX_TYPING_FPS)
  })
})
