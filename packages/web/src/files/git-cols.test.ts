/**
 * 三栏宽度数学（`files/git-cols.ts`）：分支栏的下限来自工具条按钮组的实测宽度，
 * 夹取规则决定拖动能拖到哪、窗口变窄时谁让路。算错只表现为"界面怪"（按钮被裁、日志栏被挤没），
 * 用单测把口径钉住。
 */
import { describe, expect, test } from "bun:test"
import { COL_MIN_COMMIT, COL_MIN_LOG, COL_MIN_REFS_FLOOR, clampColWidth, toolbarMinWidth } from "./git-cols"

describe("toolbarMinWidth（工具条固有宽度）", () => {
  test("内边距 + 固定项 + 全部子项间的间隙（含可压缩项之间的）", () => {
    // 8+8 内边距，7 个按钮共 168px，另有一个状态文本与一个占位空白（slots=9 → 8 个间隙）
    expect(toolbarMinWidth({ gap: 6, paddingX: 16, fixedWidths: [24, 24, 24, 24, 24, 24, 24], slots: 9 })).toBe(Math.ceil(16 + 168 + 48 + 2))
    expect(toolbarMinWidth({ gap: 6, paddingX: 16, fixedWidths: [24, 24, 24, 24, 24, 24, 24], slots: 9 })).toBe(234)
  })

  test("单个子项没有间隙；没有子项时不为负", () => {
    expect(toolbarMinWidth({ gap: 6, paddingX: 16, fixedWidths: [120], slots: 1 })).toBe(138)
    expect(toolbarMinWidth({ gap: 6, paddingX: 0, fixedWidths: [], slots: 0 })).toBe(COL_MIN_REFS_FLOOR)
  })

  test("下限兜底：按钮组极小时也留一个能用的宽度", () => {
    expect(toolbarMinWidth({ gap: 6, paddingX: 16, fixedWidths: [24], slots: 1 })).toBe(COL_MIN_REFS_FLOOR)
  })
})

describe("clampColWidth（栏宽夹取）", () => {
  const base = { min: 234, otherMin: COL_MIN_COMMIT, total: 1200 }

  test("范围内原样返回（四舍五入到整 px）", () => {
    expect(clampColWidth({ ...base, want: 300 })).toBe(300)
    expect(clampColWidth({ ...base, want: 300.4 })).toBe(300)
  })

  test("小于下限取下限，大于上限取上限（上限 = 总宽 − 另一侧下限 − 日志栏下限）", () => {
    expect(clampColWidth({ ...base, want: 100 })).toBe(234)
    expect(clampColWidth({ ...base, want: 2000 })).toBe(1200 - COL_MIN_COMMIT - COL_MIN_LOG)
  })

  test("空间不够时保下限：三栏都留最小值仍放不下，宁可横向溢出也不把栏压成缝", () => {
    expect(clampColWidth({ min: 234, otherMin: COL_MIN_COMMIT, total: 300, want: 90 })).toBe(234)
    expect(clampColWidth({ min: 234, otherMin: COL_MIN_COMMIT, total: 300, want: 500 })).toBe(234)
  })
})
