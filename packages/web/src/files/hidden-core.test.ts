import { describe, expect, test } from "bun:test"
import { HIDDEN_INITIAL, toggled, withDefault, type HiddenState } from "./hidden-core"

/** 「显示隐藏文件」纯逻辑单测（无 DOM，与 explorer.ts 的宿主实现分离）。 */

describe("withDefault（套用服务端默认值）", () => {
  test("首次套用：改成服务端配置的值，且返回新对象（调用方据此重取）", () => {
    const next = withDefault(HIDDEN_INITIAL, true)
    expect(next).toEqual({ on: true, picked: false })
    expect(next).not.toBe(HIDDEN_INITIAL)
  })

  test("值相同 → 原样返回（不触发无谓的整树重取）", () => {
    const s: HiddenState = { on: true, picked: false }
    expect(withDefault(s, true)).toBe(s)
  })

  test("用户手动切换过 → 服务端默认不再覆盖（「刷新根清单」不会弹回用户的选择）", () => {
    const off = toggled({ on: true, picked: false })
    expect(off).toEqual({ on: false, picked: true })
    expect(withDefault(off, true)).toBe(off)
  })
})

describe("toggled（用户手动切换）", () => {
  test("翻转开关并记下「已手动切换」", () => {
    expect(toggled(HIDDEN_INITIAL)).toEqual({ on: true, picked: true })
    expect(toggled({ on: true, picked: true })).toEqual({ on: false, picked: true })
  })
})
