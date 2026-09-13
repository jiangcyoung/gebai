/**
 * 通用按钮轮盘原语（wheel-core）：几何 + 生命周期。
 *
 * 覆盖四件事：
 * ① 项被搬进容器并打上组类名（外层样式靠它定尺寸与组标识）；
 * ② 展开后按钮落在**对应弧位**（每个按钮到圆心的距离等于它那一弧的半径，且扇形朝下展开）；
 * ③ 外点收起（document 上的 pointerdown 不落在容器里）；
 * ④ destroy 摘干净（容器离场、监听退订，之后再 hover 不展开）——工作台标签栏每次重渲染都要 destroy 一次，
 *    漏掉就是每重建一次多留一份扇形 DOM 与一组 document 监听。
 *
 * 元素桩在这里就地实现：测试基线（scripts/test-preload.ts）的 Proxy 桩把 classList 做成 no-op、
 * document 的事件注册也是 no-op，断言不了展开态与外点收起，所以本文件临时换一套最小实现
 * （classList 直接读写 className、document 事件真实登记），用完还原。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createWheel } from "./wheel-core"

interface StubEl {
  tagName: string
  className: string
  classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string): void }
  style: Record<string, string>
  dataset: Record<string, string>
  hidden: boolean
  offsetWidth: number
  offsetHeight: number
  parentNode: StubEl | null
  children: StubEl[]
  textContent: string
  appendChild(c: StubEl): StubEl
  remove(): void
  contains(c: StubEl): boolean
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  addEventListener(t: string, cb: (ev?: unknown) => void): void
  removeEventListener(t: string, cb: (ev?: unknown) => void): void
  dispatchEvent(ev: { type: string; target?: unknown; key?: string }): boolean
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number }
  listenerCount(): number
}

/** classList 直接读写 className 字符串——`el(tag, cls)` 是**赋 className**，两套存储会互相看不见。 */
function stub(tag = "div"): StubEl {
  const listeners = new Map<string, Array<(ev?: unknown) => void>>()
  const attrs = new Map<string, string>()
  const has = (c: string): boolean => el.className.split(/\s+/).filter(Boolean).includes(c)
  const el: StubEl = {
    tagName: tag.toUpperCase(),
    className: "",
    classList: {
      add: (c) => {
        if (!has(c)) el.className = el.className ? `${el.className} ${c}` : c
      },
      remove: (c) => {
        el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(" ")
      },
      contains: (c) => has(c),
      toggle: (c) => (has(c) ? el.classList.remove(c) : el.classList.add(c)),
    },
    style: {},
    dataset: {},
    hidden: false,
    offsetWidth: 32,
    offsetHeight: 32,
    parentNode: null,
    children: [],
    textContent: "",
    appendChild(c) {
      c.parentNode = el
      el.children.push(c)
      return c
    },
    remove() {
      const p = el.parentNode
      if (!p) return
      const i = p.children.indexOf(el)
      if (i >= 0) p.children.splice(i, 1)
      el.parentNode = null
    },
    contains(c) {
      return el.children.includes(c)
    },
    setAttribute: (k, v) => void attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    addEventListener: (t, cb) => void listeners.set(t, [...(listeners.get(t) ?? []), cb]),
    removeEventListener: (t, cb) => void listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== cb)),
    dispatchEvent: (ev) => {
      for (const cb of listeners.get(ev.type) ?? []) cb({ preventDefault() {}, ...ev, target: ev.target ?? el })
      return true
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 32, bottom: 32, width: 32, height: 32 }),
    listenerCount: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
  }
  return el
}

/* ---------------- 临时 DOM 接线（beforeEach 装、afterEach 还原） ---------------- */

const docListeners = new Map<string, Array<(ev?: unknown) => void>>()
const origCreate = document.createElement.bind(document)
const origCreateNS = document.createElementNS.bind(document)
const origAdd = document.addEventListener.bind(document)
const origRemove = document.removeEventListener.bind(document)
const origDispatch = document.dispatchEvent.bind(document)
const origBody = document.body

beforeEach(() => {
  docListeners.clear()
  // body 也换成桩：基线 body 的 appendChild 不记 parentNode，容器的 remove() 会静默失败（用例间互相污染）
  ;(document as unknown as { body: unknown }).body = stub("body")
  ;(document as unknown as { createElement: unknown }).createElement = (t?: string) => stub(t)
  ;(document as unknown as { createElementNS: unknown }).createElementNS = (_ns: string, t?: string) => stub(t)
  ;(document as unknown as { addEventListener: unknown }).addEventListener = (t: string, cb: (ev?: unknown) => void) => {
    docListeners.set(t, [...(docListeners.get(t) ?? []), cb])
  }
  ;(document as unknown as { removeEventListener: unknown }).removeEventListener = (t: string, cb: (ev?: unknown) => void) => {
    docListeners.set(t, (docListeners.get(t) ?? []).filter((f) => f !== cb))
  }
  ;(document as unknown as { dispatchEvent: unknown }).dispatchEvent = (ev: { type: string }) => {
    for (const cb of docListeners.get(ev.type) ?? []) cb(ev)
    return true
  }
})

afterEach(() => {
  for (const c of containers()) c.remove()
  ;(document as unknown as { body: unknown }).body = origBody
  ;(document as unknown as { createElement: unknown }).createElement = origCreate
  ;(document as unknown as { createElementNS: unknown }).createElementNS = origCreateNS
  ;(document as unknown as { addEventListener: unknown }).addEventListener = origAdd
  ;(document as unknown as { removeEventListener: unknown }).removeEventListener = origRemove
  ;(document as unknown as { dispatchEvent: unknown }).dispatchEvent = origDispatch
})

/** 桩 → HTMLElement（createWheel 面向真实元素，测试只关心它用到的那些成员）。 */
const asEl = (e: StubEl): HTMLElement => e as unknown as HTMLElement

/** 容器（挂在 body 上的那一层）。 */
const containers = (): StubEl[] => (document.body as unknown as { children: StubEl[] }).children.filter((c) => c.classList.contains("wheel"))

/** 展开是异步的（错落动画前先走一个宏任务）。 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

/** 从 transform="translate(dxpx, dypx)" 里取弧位偏移。 */
function offsetOf(el: StubEl): { dx: number; dy: number; radius: number } {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform ?? "")
  const dx = m ? Number(m[1]) : NaN
  const dy = m ? Number(m[2]) : NaN
  return { dx, dy, radius: Math.hypot(dx, dy) }
}

describe("createWheel（按钮轮盘原语）", () => {
  test("项被搬进容器并分组打标；收起态不可见", () => {
    const trigger = stub("button")
    const a = stub("button")
    const b = stub("button")
    const c = stub("button")
    const w = createWheel({
      trigger: asEl(trigger),
      items: [
        { el: asEl(a), group: "inner" },
        { el: asEl(b), group: "inner" },
        { el: asEl(c) },
      ],
    })
    const keep = containers()[0]
    expect(keep).toBeDefined()
    expect(keep.children).toContain(a)
    expect(keep.children).toContain(b)
    expect(keep.children).toContain(c)
    expect(a.classList.contains("wheel-item")).toBe(true)
    expect(a.classList.contains("wheel-inner")).toBe(true)
    expect(c.classList.contains("wheel-item")).toBe(true)
    expect(c.classList.contains("wheel-inner")).toBe(false)
    // 收起态：透明 + 缩到 0.4 + 容器没有 open
    expect(a.style.opacity).toBe("0")
    expect(a.style.transform).toBe("translate(0, 0) scale(0.4)")
    expect(keep.classList.contains("open")).toBe(false)
    w.destroy()
  })

  test("hover 展开：按钮落在各自弧位上（内弧半径 < 外弧半径，扇形朝下）", async () => {
    const trigger = stub("button")
    const inner1 = stub("button")
    const inner2 = stub("button")
    const outer1 = stub("button")
    const w = createWheel({
      trigger: asEl(trigger),
      items: [
        { el: asEl(inner1), group: "inner" },
        { el: asEl(inner2), group: "inner" },
        { el: asEl(outer1) },
      ],
      innerR: 85,
      outerR: 145,
    })
    const keep = containers()[0]
    trigger.dispatchEvent({ type: "pointerenter" })
    await tick()
    expect(keep.classList.contains("open")).toBe(true)
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(inner1.style.opacity).toBe("1")
    expect(inner1.style.transitionDelay).toBe("0ms")
    expect(inner2.style.transitionDelay).toBe("14ms")

    for (const el of [inner1, inner2]) expect(offsetOf(el).radius).toBeCloseTo(85, 3)
    expect(offsetOf(outer1).radius).toBeCloseTo(145, 3)
    // 扇形朝下（入口在界面上缘，只有向下有空间）
    for (const el of [inner1, inner2, outer1]) expect(offsetOf(el).dy).toBeGreaterThan(0)
    w.destroy()
  })

  test("外点收起：pointerdown 落在容器之外", async () => {
    const trigger = stub("button")
    const a = stub("button")
    const w = createWheel({ trigger: asEl(trigger), items: [{ el: asEl(a), group: "inner" }] })
    trigger.dispatchEvent({ type: "pointerenter" })
    await tick()
    expect(a.style.opacity).toBe("1")
    document.dispatchEvent({ type: "pointerdown", target: stub() } as unknown as Event)
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    expect(a.style.opacity).toBe("0")
    w.destroy()
  })

  test("destroy：容器离场 + 监听退订（之后再 hover 不展开）", async () => {
    const trigger = stub("button")
    const a = stub("button")
    const w = createWheel({ trigger: asEl(trigger), items: [{ el: asEl(a), group: "inner" }] })
    expect(containers().length).toBe(1)
    w.destroy()
    expect(containers().length).toBe(0)
    expect(trigger.listenerCount()).toBe(0)
    trigger.dispatchEvent({ type: "pointerenter" })
    await tick()
    expect(containers().length).toBe(0)
  })

  test("键盘入口：入口获焦后 Enter 展开、Esc 收起", async () => {
    const trigger = stub("button")
    const a = stub("button")
    const w = createWheel({ trigger: asEl(trigger), items: [{ el: asEl(a), group: "inner" }] })
    trigger.dispatchEvent({ type: "keydown", key: "Enter" })
    await tick()
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    document.dispatchEvent({ type: "keydown", key: "Escape" } as unknown as Event)
    expect(trigger.getAttribute("aria-expanded")).toBe("false")
    w.destroy()
  })

  test("hidden 项不参与弧位排布（保持收起态）", async () => {
    const trigger = stub("button")
    const shown = stub("button")
    const hidden = stub("button")
    hidden.hidden = true
    const w = createWheel({
      trigger: asEl(trigger),
      items: [
        { el: asEl(shown), group: "inner" },
        { el: asEl(hidden), group: "inner" },
      ],
    })
    trigger.dispatchEvent({ type: "pointerenter" })
    await tick()
    // 只剩一个可见项：落在区间起点角度上，半径仍是内弧半径
    expect(offsetOf(shown).radius).toBeCloseTo(85, 3)
    expect(hidden.style.opacity).toBe("0")
    expect(hidden.style.transform).toBe("translate(0, 0) scale(0.4)")
    w.destroy()
  })
})
