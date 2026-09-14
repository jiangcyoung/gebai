/**
 * 面板宽度数学（`files/panel-width.ts`）：左栏下限来自提交框动作行的实测宽度。
 * 「多宽算够」算错只表现为按钮被裁/折行，用单测把口径钉住。
 */
import { describe, expect, test } from "bun:test"
import { clampPanelWidth, LEFT_MAX, LEFT_MIN_FLOOR, rowMinWidth } from "./panel-width"

describe("rowMinWidth（一行控件的固有宽度）", () => {
  test("不可压缩项之和 + 项间间隙 + 内边距 + 取整余量", () => {
    // 提交框动作行：选项组 81 + 动作组 146，间隙 8，容器内边距 16
    expect(rowMinWidth({ widths: [81, 146], gaps: 8, paddingX: 16 })).toBe(253)
  })

  test("间隙按**全部项数**算（可省略项被压到 0，但它两边的间隙还在）", () => {
    expect(rowMinWidth({ widths: [100], gaps: 8, paddingX: 0, itemCount: 3 })).toBe(118)
    expect(rowMinWidth({ widths: [100], gaps: 8, paddingX: 0, itemCount: 1 })).toBe(102)
  })

  test("单项无间隙；空行只剩内边距与余量", () => {
    expect(rowMinWidth({ widths: [69], gaps: 8, paddingX: 0 })).toBe(71)
    expect(rowMinWidth({ widths: [], gaps: 8, paddingX: 16 })).toBe(18)
  })
})

describe("clampPanelWidth（宽度夹取）", () => {
  test("范围内原样（四舍五入到整 px）", () => {
    expect(clampPanelWidth({ want: 300, min: 253 })).toBe(300)
    expect(clampPanelWidth({ want: 300.6, min: 253 })).toBe(301)
  })

  test("小于下限取下限，大于上限取上限", () => {
    expect(clampPanelWidth({ want: 100, min: 253 })).toBe(253)
    expect(clampPanelWidth({ want: 999, min: LEFT_MIN_FLOOR })).toBe(LEFT_MAX)
  })

  test("下限高于上限时保下限（宁可更宽，也不裁掉栏内控件）", () => {
    expect(clampPanelWidth({ want: 999, min: 600, max: 500 })).toBe(600)
  })
})
