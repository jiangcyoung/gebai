/**
 * 浏览器原生右键菜单的屏蔽（`native-menu.ts`）。
 *
 * 两条断言钉住实现的两个要点：**要 preventDefault**（否则原生菜单照弹），
 * **不能 stopPropagation**（Monaco 与各面板的自绘菜单挂在同一个 contextmenu 事件上，阻断传播会一起失效）。
 */
import { describe, expect, test } from "bun:test"
import { blockNativeContextMenu } from "./native-menu"

/** 最小 EventTarget 桩：记录注册的处理器，便于手工派发。 */
function stubTarget(): {
  target: EventTarget
  fire: (type: string, ev: Record<string, unknown>) => void
  count: (type: string) => number
} {
  const handlers = new Map<string, Array<(e: unknown) => void>>()
  return {
    target: {
      addEventListener: (t: string, cb: (e: unknown) => void) => {
        handlers.set(t, [...(handlers.get(t) ?? []), cb])
      },
    } as unknown as EventTarget,
    fire: (type, ev) => {
      for (const cb of handlers.get(type) ?? []) cb(ev)
    },
    count: (type) => (handlers.get(type) ?? []).length,
  }
}

describe("屏蔽浏览器原生右键菜单", () => {
  test("contextmenu 被 preventDefault（原生菜单不弹）", () => {
    const s = stubTarget()
    blockNativeContextMenu(s.target)
    const called: string[] = []
    s.fire("contextmenu", {
      preventDefault: () => called.push("preventDefault"),
      stopPropagation: () => called.push("stopPropagation"),
    })
    expect(called).toEqual(["preventDefault"])
  })

  test("只监听 contextmenu：不干扰其它事件", () => {
    const s = stubTarget()
    blockNativeContextMenu(s.target)
    expect(s.count("contextmenu")).toBe(1)
    expect(s.count("mousedown")).toBe(0)
    expect(s.count("click")).toBe(0)
  })
})
