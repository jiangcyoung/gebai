/**
 * 自动换行偏好（`files/wrap.ts`）：关掉时不留残留键，脏值一律当关闭。
 * Alt+Z 的判定已并入键位表（`keymap.ts` 的 parseSpec / matchKey），本文件只测偏好与文案。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readWordWrap, saveWordWrap, wordWrapTitle } from "./wrap"

const KEY = "gebai.ui.wordWrap"

afterEach(() => {
  localStorage.removeItem(KEY)
})

describe("自动换行偏好", () => {
  test("默认关闭（无记忆）", () => {
    expect(readWordWrap()).toBe(false)
  })

  test("开→读回 true；关→键被清除而不是写 0（无残留）", () => {
    saveWordWrap(true)
    expect(localStorage.getItem(KEY)).toBe("1")
    expect(readWordWrap()).toBe(true)
    saveWordWrap(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(readWordWrap()).toBe(false)
  })

  test("脏值（非 \"1\"）当关闭处理", () => {
    localStorage.setItem(KEY, "true")
    expect(readWordWrap()).toBe(false)
  })
})

describe("轮盘按钮文案", () => {
  test("按当前态给动作（两态文案不同，且都带快捷键）", () => {
    expect(wordWrapTitle(false)).toBe("开启自动换行（Alt+Z）")
    expect(wordWrapTitle(true)).toBe("关闭自动换行（Alt+Z）")
  })
})
