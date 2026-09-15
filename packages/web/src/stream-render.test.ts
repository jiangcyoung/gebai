import { afterAll, describe, expect, test } from "bun:test"
import { createStreamRenderer, findStableCut } from "./stream-render"

/* 自包含最小 DOM：全局桩（test-preload）不维护 children/textContent 聚合，而增量渲染的正确性
（结构、串联文本、尾部替换）必须落在真实语义上。仅提供渲染器实际用到的能力。 */
interface MiniEl {
  tagName: string
  className: string
  parentNode: MiniEl | null
  childNodes: MiniEl[]
  readonly children: MiniEl[]
  readonly firstElementChild: MiniEl | null
  appendChild(c: MiniEl): MiniEl
  replaceChildren(...nodes: MiniEl[]): void
  remove(): void
  textContent: string
  querySelectorAll(sel: string): MiniEl[]
}

function makeEl(tag: string): MiniEl {
  let own: string | null = null // null = 聚合子节点文本（容器）；非 null = 自身文本（叶子）
  const el: MiniEl = {
    tagName: tag.toUpperCase(),
    className: "",
    parentNode: null,
    childNodes: [],
    get children() {
      return el.childNodes
    },
    get firstElementChild() {
      return el.childNodes[0] ?? null
    },
    appendChild(c) {
      if (c.parentNode) c.parentNode.childNodes = c.parentNode.childNodes.filter((x) => x !== c)
      c.parentNode = el
      el.childNodes.push(c)
      return c
    },
    replaceChildren(...nodes) {
      for (const n of [...el.childNodes]) n.parentNode = null
      el.childNodes = []
      for (const n of nodes) el.appendChild(n)
    },
    remove() {
      const p = el.parentNode
      if (p) p.childNodes = p.childNodes.filter((x) => x !== el)
      el.parentNode = null
    },
    get textContent() {
      return own ?? el.childNodes.map((c) => c.textContent).join("")
    },
    set textContent(v) {
      own = v
    },
    querySelectorAll(sel) {
      const want = sel.replace(/^\./, "").toLowerCase()
      const byClass = sel.startsWith(".")
      const out: MiniEl[] = []
      const walk = (n: MiniEl) => {
        for (const c of n.childNodes) {
          const hit = byClass ? c.className.split(/\s+/).includes(want) : c.tagName.toLowerCase() === want
          if (hit) out.push(c)
          walk(c)
        }
      }
      walk(el)
      return out
    },
  }
  return el
}

const prevDocument = (globalThis as Record<string, unknown>).document
;(globalThis as Record<string, unknown>).document = {
  createElement: (tag: string) => makeEl(tag),
}
afterAll(() => {
  ;(globalThis as Record<string, unknown>).document = prevDocument
})

/* ---------------- 切点安全 ---------------- */

describe("流式切点：只在块边界切", () => {
  test("段落之间的空行即切点（下一行是普通段落）", () => {
    const text = "第一段\n\n第二段\n"
    expect(findStableCut(text)).toBe("第一段\n\n".length)
  })

  test("围栏代码块内的空行不切（未闭合期间整块属于尾部）", () => {
    const text = "前言\n\n```js\nconst a = 1\n\nconst b = 2\n"
    // 只有「前言」后的空行是边界；围栏未闭合，其内空行不算
    expect(findStableCut(text)).toBe("前言\n\n".length)
  })

  test("围栏闭合后其后的空行恢复为切点", () => {
    const text = "前言\n\n```js\nconst a = 1\n```\n\n后续段落\n"
    expect(findStableCut(text)).toBe("前言\n\n```js\nconst a = 1\n```\n\n".length)
  })

  test("列表跨空行（松散列表）不切：切开会裂成两个列表", () => {
    const text = "前言\n\n- 甲\n\n- 乙\n"
    expect(findStableCut(text)).toBe("前言\n\n".length)
  })

  test("有序列表、引用、缩进块、表格行同样视为延续，不切", () => {
    for (const cont of ["1. 甲", "> 甲", "    甲", "| 甲 |"]) {
      const text = `前言\n\n${cont}\n`
      expect(findStableCut(text)).toBe("前言\n\n".length)
    }
  })

  test("推理片段 <think> 未闭合期间不切；闭合后恢复", () => {
    const open = "前言\n\n<think>\n推理甲\n\n推理乙\n"
    expect(findStableCut(open)).toBe("前言\n\n".length)
    const closed = "前言\n\n<think>\n推理甲\n</think>\n\n正文段\n"
    expect(findStableCut(closed)).toBe("前言\n\n<think>\n推理甲\n</think>\n\n".length)
  })

  test("末行未换行不切（内容仍在追加）", () => {
    const text = "甲段\n\n乙段未结束"
    expect(findStableCut(text)).toBe("甲段\n\n".length)
  })

  test("多处候选取最后一个（一次扫描即推进到最新边界）", () => {
    const text = "甲\n\n乙\n\n丙\n\n丁\n"
    expect(findStableCut(text)).toBe("甲\n\n乙\n\n丙\n\n".length)
  })

  test("单调推进：从上次切点继续不影响结果", () => {
    const text = "甲\n\n乙\n\n丙\n"
    const first = findStableCut(text)
    expect(first).toBe("甲\n\n乙\n\n".length) // 一次扫描就到最后边界
    expect(findStableCut(text, first)).toBe(first) // 无新边界，不倒退
    expect(findStableCut(text, text.length)).toBe(text.length)
  })

  test("无块边界（单段长文本）返回起点", () => {
    expect(findStableCut("单段文字不断追加中")).toBe(0)
  })
})

/* ---------------- 增量渲染器 ---------------- */

/** 假渲染：把片段包成 .markdown（childNodes 为文本节点），记录每帧渲染的片段。 */
function fakeRenderer() {
  const calls: string[] = []
  const make = (text: string) => {
    calls.push(text)
    const box = makeEl("div")
    box.className = "markdown"
    // 以「块」为单位成节点：每个非空行一个 p，便于断言节点数
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      const p = makeEl("p")
      p.textContent = line
      box.appendChild(p)
    }
    return box
  }
  const handle = createStreamRenderer({ renderFragment: make as unknown as (t: string) => { childNodes: ArrayLike<ChildNode> } })
  return { calls, make, handle }
}

const container = () => {
  const c = makeEl("div")
  c.className = "msg-text"
  return c
}

/** 容器内可见文本（拼接所有后代文本）。 */
const textOf = (c: MiniEl) => c.textContent

describe("流式增量渲染器", () => {
  test("结构：容器内单层 .markdown 包裹（与全量渲染一致）", () => {
    const { handle } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段\n")
    expect(c.children.length).toBe(1)
    expect(c.firstElementChild?.className).toBe("markdown")
    expect(c.querySelectorAll(".markdown").length).toBe(1)  })

  test("已稳定的前缀只渲染一次（核心收益：成本不随长度增长）", () => {
    const { handle, calls } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段增长中")
    const firstCalls = calls.length
    expect(firstCalls).toBe(2) // 稳定段「甲段\n\n」+ 尾部「乙段增长中」
    calls.length = 0
    // 尾部继续增长：前缀不再重渲染
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段继续增长")
    expect(calls).toEqual(["乙段继续增长"])
    expect(textOf(c)).toBe("甲段乙段继续增长")
  })

  test("尾部被新块稳定：只渲染新增的稳定段与新尾部", () => {
    const { handle, calls } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段")
    calls.length = 0
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段\n\n丙段增长中")
    // 首帧：稳定段推进到「甲段\n\n乙段\n\n」→ 只渲染新增的「乙段\n\n」；尾部「丙段增长中」
    expect(calls).toEqual(["乙段\n\n", "丙段增长中"])
    expect(textOf(c)).toBe("甲段乙段丙段增长中")
    expect(handle.stableBlocks()).toBe(2)
  })

  test("长回答多帧：每帧只渲染新增稳定段与尾部（成本不随长度增长）", () => {
    const { handle, calls } = fakeRenderer()
    const c = container()
    let text = ""
    for (let i = 0; i < 40; i++) text += `第 ${i} 段\n\n`
    handle.update(c as unknown as HTMLElement, text) // 预热：首帧把已有前缀一次性渲染（真实场景是逐段到达）
    const sampled: number[] = []
    for (let i = 40; i < 60; i++) {
      text += `第 ${i} 段\n\n`
      calls.length = 0
      handle.update(c as unknown as HTMLElement, text.slice(0, text.length - 1)) // 末行未结束
      sampled.push(calls.join("").length)
    }
    // 每帧仅渲染新增段与尾部：远小于全文（20 段 × 7 字符 = 140），且不随帧数增长
    expect(Math.max(...sampled)).toBeLessThan(60)
    expect(sampled[sampled.length - 1]).toBeLessThan(60)
    expect(textOf(c)).toContain("第 59 段")
  })

  test("容器被外部重建：自动重新开始（不残留旧内容）", () => {
    const { handle } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段")
    c.replaceChildren() // 外部清空（如历史重载）
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段更新")
    expect(textOf(c)).toBe("甲段乙段更新")
    expect(c.querySelectorAll(".markdown").length).toBe(1)
  })

  test("文本被重写（长度回退，重连重放）：全量重建且内容正确", () => {
    const { handle, calls } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "甲段\n\n乙段\n\n丙段")
    calls.length = 0
    handle.update(c as unknown as HTMLElement, "甲段") // 回退
    expect(handle.incremental()).toBe(false) // 走全量路径
    expect(textOf(c)).toBe("甲段")
  })

  test("含 <think> 的文本走全量路径（保留推理卡片语义）", () => {
    const { handle, calls } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "<think>推理</think>\n\n正文")
    expect(handle.incremental()).toBe(false)
    expect(calls).toEqual(["<think>推理</think>\n\n正文"])
    expect(c.querySelectorAll(".markdown").length).toBe(0) // 全量路径由 renderFull 负责包裹（此假实现无包裹）
  })

  test("空文本不产生节点", () => {
    const { handle } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "")
    expect(textOf(c)).toBe("")
  })

  test("尾部空行不产生多余块（渲染器只在非空尾部渲染）", () => {
    const { handle } = fakeRenderer()
    const c = container()
    handle.update(c as unknown as HTMLElement, "甲段\n\n")
    expect(textOf(c)).toBe("甲段")
    expect(c.querySelectorAll("p").length).toBe(1)
  })
})
