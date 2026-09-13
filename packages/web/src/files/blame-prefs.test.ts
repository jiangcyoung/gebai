/**
 * blame 显示偏好（`files/blame-prefs.ts`）：只有行尾（inline）态被记忆，关掉时不留残留键。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readInlineBlame, saveInlineBlame } from "./blame-prefs"

const KEY = "gebai.ui.blameInline"

afterEach(() => {
  localStorage.removeItem(KEY)
})

describe("blame 行尾开关的记忆", () => {
  test("默认关闭（无记忆）", () => {
    expect(readInlineBlame()).toBe(false)
  })

  test("开→读回 true；关→键被清除而不是写 0（无残留）", () => {
    saveInlineBlame(true)
    expect(localStorage.getItem(KEY)).toBe("1")
    expect(readInlineBlame()).toBe(true)
    saveInlineBlame(false)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(readInlineBlame()).toBe(false)
  })

  test("脏值（非 \"1\"）当关闭处理", () => {
    localStorage.setItem(KEY, "true")
    expect(readInlineBlame()).toBe(false)
  })
})
