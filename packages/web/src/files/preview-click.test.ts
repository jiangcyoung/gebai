/**
 * 「单击 = 预览、双击 = 固定」的时序判定（`files/preview-click.ts`）。
 *
 * 这一层是**实测踩出来的**：浏览器双击时给的是 `click, click, dblclick`（第二发 click 还可能被合并），
 * 而单击与双击的第一发在事件层一模一样——所以预览的打开必须延后一个双击窗口、窗口内等到 dblclick
 * 就作废。这里用**注入的假时钟**把三种时序钉死（真时钟测不了这几毫秒的差别）。
 */
import { describe, expect, test } from "bun:test"

import { createPreviewClick, type PreviewClock, type PreviewTarget } from "./preview-click"

/** 假时钟：手动推进（`advance(ms)` 只触发到期的那些定时器）。 */
function fakeClock(): PreviewClock & { advance(ms: number): void } {
  let now = 0
  let seq = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    set(fn, ms) {
      const id = seq++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clear(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
  }
}

const T = (path: string, root = "proj:x"): PreviewTarget => ({ key: `${root}|${path}`, root, path })

function setup(o: { delay?: number; alive?: (t: PreviewTarget) => boolean } = {}) {
  const clock = fakeClock()
  const previews: string[] = []
  const pinned: string[] = []
  const api = createPreviewClick({
    openPreview: (t) => previews.push(t.path),
    openPinned: (t) => pinned.push(t.path),
    isAlive: o.alive,
    delay: o.delay,
    clock,
  })
  return { api, clock, previews, pinned }
}

describe("单击 = 预览（延后一拍落地）", () => {
  test("单击后窗口内不开，过了窗口才开预览", () => {
    const s = setup()
    s.api.click(T("a.ts"))
    s.clock.advance(219)
    expect(s.previews).toEqual([])
    expect(s.api.pending()).toBe("proj:x|a.ts")
    s.clock.advance(1)
    expect(s.previews).toEqual(["a.ts"])
    expect(s.pinned).toEqual([])
    expect(s.api.pending()).toBeNull()
  })

  test("窗口内连点同一个文件：只开一次（不叠加）", () => {
    const s = setup()
    s.api.click(T("a.ts"))
    s.clock.advance(100)
    s.api.click(T("a.ts"))
    s.clock.advance(120) // 相对第一发已 220ms，但第二发重置了？不重置：以首次为准
    expect(s.previews).toEqual(["a.ts"])
    s.clock.advance(1000)
    expect(s.previews).toEqual(["a.ts"])
  })

  test("窗口内点别的文件：前一个作废，只开后一个（预览槽只有一个）", () => {
    const s = setup()
    s.api.click(T("a.ts"))
    s.clock.advance(100)
    s.api.click(T("b.ts"))
    s.clock.advance(300)
    expect(s.previews).toEqual(["b.ts"])
  })
})

describe("双击 = 固定", () => {
  test("双击作废单击那一发，只按常驻打开一次", () => {
    const s = setup()
    s.api.click(T("a.ts"))
    s.clock.advance(80)
    s.api.dblclick(T("a.ts"))
    expect(s.pinned).toEqual(["a.ts"])
    s.clock.advance(1000)
    expect(s.previews).toEqual([]) // 预览那一发没有落地
    expect(s.pinned).toEqual(["a.ts"])
  })

  test("双击时上一发待定的别的文件也一起作废", () => {
    const s = setup()
    s.api.click(T("a.ts"))
    s.clock.advance(100)
    s.api.dblclick(T("b.ts"))
    s.clock.advance(1000)
    expect(s.previews).toEqual([])
    expect(s.pinned).toEqual(["b.ts"])
  })
})

describe("边界", () => {
  test("行已被重画（isAlive 为假）时不开预览", () => {
    let alive = true
    const s = setup({ alive: () => alive })
    s.api.click(T("a.ts"))
    alive = false
    s.clock.advance(300)
    expect(s.previews).toEqual([])
    expect(s.api.pending()).toBeNull()
  })

  test("cancel（换根等）作废待定预览", () => {
    const s = setup()
    s.api.click(T("a.ts"))
    s.api.cancel()
    s.clock.advance(1000)
    expect(s.previews).toEqual([])
    expect(s.api.pending()).toBeNull()
  })

  test("不同根下的同名文件不是同一个 key", () => {
    const s = setup()
    s.api.click(T("a.ts", "proj:x"))
    s.clock.advance(100)
    s.api.click(T("a.ts", "sess:y"))
    s.clock.advance(300)
    expect(s.previews).toEqual(["a.ts"]) // 只有后一发落地
    expect(s.api.pending()).toBeNull()
  })
})
