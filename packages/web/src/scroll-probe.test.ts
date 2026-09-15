import { describe, expect, test } from "bun:test"
import { isScrollProbeEnabled, probeSnapshot, SCROLL_PROBE_MAX, SCROLL_PROBE_TICK_MS } from "./scroll-probe"

/** 最小元素替身：只提供快照需要的字段/方法。 */
function fakeNode(opts: { cls?: string; h?: number } = {}) {
  const cls = opts.cls ?? ""
  const h = opts.h ?? 0
  return {
    classList: { contains: (c: string) => cls.split(/\s+/).includes(c) },
    getBoundingClientRect: () => ({ height: h, top: 0, bottom: h, left: 0, right: 100, width: 100 }),
    closest: () => null,
    className: cls,
    tagName: "DIV",
  }
}

/** 最小容器替身。 */
function fakeContainer(nodeCount = 3, opts: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}) {
  const children = Array.from({ length: nodeCount }, (_, i) => fakeNode({ cls: i % 2 === 0 ? "vz-block" : "vz-spacer", h: 100 * (i + 1) }))
  return {
    children,
    scrollTop: opts.scrollTop ?? 250,
    scrollHeight: opts.scrollHeight ?? 1000,
    clientHeight: opts.clientHeight ?? 400,
    querySelectorAll: () => [fakeNode({ cls: "msg" }), fakeNode({ cls: "msg" })],
    querySelector: () => null,
    getBoundingClientRect: () => ({ height: 400, top: 0, bottom: 400, left: 0, right: 800, width: 800 }),
  } as unknown as HTMLElement
}

describe("滚动诊断探针：开启判定", () => {
  test("URL 参数优先：?gb_scroll_probe=1 开启（含前后其他参数）", () => {
    expect(isScrollProbeEnabled({ search: "?gb_scroll_probe=1", getItem: () => null })).toBe(true)
    expect(isScrollProbeEnabled({ search: "?a=1&gb_scroll_probe=on&b=2", getItem: () => null })).toBe(true)
    expect(isScrollProbeEnabled({ search: "?gb_scroll_probe=true", getItem: () => null })).toBe(true)
  })

  test("URL 参数取值不合法/无参数时不开启", () => {
    expect(isScrollProbeEnabled({ search: "?gb_scroll_probe=0", getItem: () => null })).toBe(false)
    expect(isScrollProbeEnabled({ search: "?gb_scroll_probe", getItem: () => null })).toBe(false)
    expect(isScrollProbeEnabled({ search: "", getItem: () => null })).toBe(false)
    expect(isScrollProbeEnabled({ search: "?x=gb_scroll_probe=1", getItem: () => null })).toBe(false) // 必须是完整参数名
  })

  test("持久化键 gebai.ui.scrollProbe === \"on\" 时开启（其余值不开启）", () => {
    expect(isScrollProbeEnabled({ search: "", getItem: (k) => (k === "gebai.ui.scrollProbe" ? "on" : null) })).toBe(true)
    expect(isScrollProbeEnabled({ search: "", getItem: () => "off" })).toBe(false)
    expect(isScrollProbeEnabled({ search: "", getItem: () => null })).toBe(false)
  })

  test("存储不可用（隐私模式抛错）时不开启且不抛", () => {
    expect(
      isScrollProbeEnabled({
        search: "",
        getItem: () => {
          throw new Error("denied")
        },
      }),
    ).toBe(false)
  })
})

describe("滚动诊断探针：现场快照", () => {
  test("快照字段：位置/高度/距底/spacer 高度/块数/消息数/中心命中", () => {
    const snap = probeSnapshot(fakeContainer(3, { scrollTop: 250, scrollHeight: 1000, clientHeight: 400 }))
    expect(snap.why).toBe("tick")
    expect(snap.top).toBe(250)
    expect(snap.max).toBe(600)
    expect(snap.dist).toBe(350)
    expect(snap.pad).toEqual([200]) // 子节点中唯一一个 vz-spacer 的高度（i=1 节点）
    expect(snap.blocks).toBe(2) // 两个 vz-block 子节点（i=0、i=2）
    expect(snap.msgs).toBe(2)
    expect(typeof snap.t).toBe("number")
  })

  test("无布局环境（clientHeight 0）时距底为 0、中心命中降级为 none", () => {
    const snap = probeSnapshot(fakeContainer(1, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }))
    expect(snap.dist).toBe(0)
    expect(snap.center).toBe("none")
  })
})

describe("滚动诊断探针：上限常量", () => {
  test("记录上限与采样间隔为正且量级合理（长时间开启不吃内存/不刷屏）", () => {
    expect(SCROLL_PROBE_MAX).toBeGreaterThanOrEqual(500)
    expect(SCROLL_PROBE_MAX).toBeLessThanOrEqual(10000)
    expect(SCROLL_PROBE_TICK_MS).toBeGreaterThanOrEqual(20)
    expect(SCROLL_PROBE_TICK_MS).toBeLessThanOrEqual(500)
  })
})
