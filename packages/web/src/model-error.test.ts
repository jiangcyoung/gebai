import { afterAll, describe, expect, test } from "bun:test"

// model-error 经 state.ts 取元素工厂（el）：import 期就绑 DOM，先装一套最小 DOM
// （元素树真实可读、未定义成员 no-op 兜底），用完还原基线那一份。
interface MockEl {
  children: MockEl[]
  className: string
  tagName: string
  textContent: string
  append(...nodes: unknown[]): void
  appendChild(node: unknown): void
}
function makeEl(tag = "div"): MockEl {
  let own = ""
  const node: MockEl = {
    children: [],
    className: "",
    tagName: tag.toUpperCase(),
    get textContent() {
      return own + node.children.map((c) => c.textContent ?? "").join("")
    },
    set textContent(v: string) {
      own = String(v ?? "")
      node.children.length = 0
    },
    append(...nodes: unknown[]) {
      for (const n of nodes) if (n && typeof n === "object") node.children.push(n as MockEl)
    },
    appendChild(n: unknown) {
      if (n && typeof n === "object") node.children.push(n as MockEl)
    },
  }
  return node
}
const docBase: Record<string, unknown> = {
  getElementById: () => makeEl(),
  createElement: (tag?: string) => makeEl(tag ?? "div"),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: makeEl("body"),
  documentElement: makeEl("html"),
}
const g = globalThis as unknown as Record<string, unknown>
const prevDocument = g.document
g.document = new Proxy(docBase, {
  get(t, k) {
    if (typeof k === "string" && k in t) return t[k]
    return () => {}
  },
})

const { createModelErrorNotice, modelErrorText } = await import("./model-error")
afterAll(() => {
  g.document = prevDocument
})

function lines(notice: { el: HTMLElement }): HTMLElement[] {
  return (notice.el as unknown as { children: HTMLElement[] }).children
}
function texts(notice: { el: HTMLElement }): string[] {
  return lines(notice).map((l) => l.textContent)
}
function classes(notice: { el: HTMLElement }): string[] {
  return lines(notice).map((l) => l.className)
}

describe("modelErrorText（异常行正文）", () => {
  test("带重试序号", () => {
    expect(modelErrorText(1, 2, "connection reset")).toBe("模型服务异常（第 1/2 次重试）：connection reset")
  })

  test("无总次数时只报当前序号", () => {
    expect(modelErrorText(2, undefined, "空响应")).toBe("模型服务异常（第 2 次重试）：空响应")
  })

  test("无序号时省略括号", () => {
    expect(modelErrorText(undefined, undefined, "断流")).toBe("模型服务异常：断流")
  })
})

describe("模型服务异常记录：常驻不消失", () => {
  test("记录重试中异常：一行，正文 + 重试中状态", () => {
    const notice = createModelErrorNotice()
    notice.record("1/2:connection reset", modelErrorText(1, 2, "connection reset"))
    expect(texts(notice)).toEqual(["模型服务异常（第 1/2 次重试）：connection reset，正在自动重试…"])
    expect(classes(notice)).toEqual(["model-error-line is-retrying"])
  })

  test("模型恢复输出只标注状态，记录仍在（报错信息不随恢复消失）", () => {
    const notice = createModelErrorNotice()
    notice.record("1/2:超时", modelErrorText(1, 2, "超时"))
    notice.recovered()
    expect(texts(notice)).toEqual(["模型服务异常（第 1/2 次重试）：超时（已恢复，模型继续输出）"])
    expect(classes(notice)).toEqual(["model-error-line is-recovered"])
  })

  test("任务结束仍未恢复：标注重试未成功（记录保留）", () => {
    const notice = createModelErrorNotice()
    notice.record("2/2:超时", modelErrorText(2, 2, "超时"))
    notice.failed()
    expect(texts(notice)).toEqual(["模型服务异常（第 2/2 次重试）：超时（重试未成功）"])
    expect(classes(notice)).toEqual(["model-error-line is-failed"])
  })

  test("已恢复后再失败：新增一行重试中，旧行保持已恢复（每条异常都留痕）", () => {
    const notice = createModelErrorNotice()
    notice.record("1/2:超时", modelErrorText(1, 2, "超时"))
    notice.recovered()
    notice.record("2/2:超时", modelErrorText(2, 2, "超时"))
    notice.recovered()
    notice.record("1/2:断流", modelErrorText(1, 2, "断流"))
    expect(texts(notice)).toEqual([
      "模型服务异常（第 1/2 次重试）：超时（已恢复，模型继续输出）",
      "模型服务异常（第 2/2 次重试）：超时（已恢复，模型继续输出）",
      "模型服务异常（第 1/2 次重试）：断流，正在自动重试…",
    ])
    expect(classes(notice)).toEqual(["model-error-line is-recovered", "model-error-line is-recovered", "model-error-line is-retrying"])
    notice.failed()
    expect(classes(notice)).toEqual(["model-error-line is-recovered", "model-error-line is-recovered", "model-error-line is-failed"])
  })

  test("同一条重放（断线重连事件重放）：原地更新不新增行", () => {
    const notice = createModelErrorNotice()
    notice.record("1/2:超时", modelErrorText(1, 2, "超时"))
    notice.record("1/2:超时", modelErrorText(1, 2, "超时"))
    notice.record("1/2:超时", modelErrorText(1, 2, "超时"))
    expect(lines(notice)).toHaveLength(1)
    expect(texts(notice)).toEqual(["模型服务异常（第 1/2 次重试）：超时，正在自动重试…"])
  })

  test("无重试中行时 recovered/failed 空转（正常结束不产生多余标注）", () => {
    const notice = createModelErrorNotice()
    notice.recovered()
    notice.failed()
    expect(lines(notice)).toHaveLength(0)
  })
})
