import { describe, expect, test } from "bun:test"
import { isTextEntry } from "./theme-fx"

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
