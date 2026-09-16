/**
 * 自动换行偏好与 Alt+Z 判定（`files/wrap.ts`）：关掉时不留残留键，脏值一律当关闭。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { isWordWrapHotkey, readWordWrap, saveWordWrap, wordWrapTitle } from "./wrap"

const KEY = "gebai.ui.wordWrap"

/** 快捷键事件的最小构造（其余字段由用例显式给）。 */
function ev(partial: Partial<{ key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) {
  return { key: "z", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...partial }
}

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

describe("Alt+Z 判定", () => {
  test("Alt+Z 命中（大小写都可）", () => {
    expect(isWordWrapHotkey(ev({ altKey: true }))).toBe(true)
    expect(isWordWrapHotkey(ev({ altKey: true, key: "Z" }))).toBe(true)
  })

  test("缺 Alt 不命中", () => {
    expect(isWordWrapHotkey(ev({}))).toBe(false)
  })

  test("叠加 Ctrl / Shift / Meta 都不命中（那些组合在别处另有语义）", () => {
    expect(isWordWrapHotkey(ev({ altKey: true, ctrlKey: true }))).toBe(false)
    expect(isWordWrapHotkey(ev({ altKey: true, shiftKey: true }))).toBe(false)
    expect(isWordWrapHotkey(ev({ altKey: true, metaKey: true }))).toBe(false)
  })

  test("别的键不命中", () => {
    expect(isWordWrapHotkey(ev({ altKey: true, key: "x" }))).toBe(false)
  })
})

describe("轮盘按钮文案", () => {
  test("按当前态给动作（两态文案不同，且都带快捷键）", () => {
    expect(wordWrapTitle(false)).toBe("开启自动换行（Alt+Z）")
    expect(wordWrapTitle(true)).toBe("关闭自动换行（Alt+Z）")
  })
})
