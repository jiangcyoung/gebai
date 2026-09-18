/**
 * 资源管理器把「显示隐藏文件」落到列举请求上（`createExplorer` → `/fs/list` 的 `showHidden`）。
 *
 * 为什么值得测：宿主（`main.ts`）在根清单到达时喂进来的默认值只该管首次，之后由「更多」菜单说了算；
 * 这条链断了不报错——只表现成树里看不到 `.env` / `.git`。
 *
 * DOM 说明：`createExplorer` 在**构造期**就建元素，而本文件按名字排在若干「整体替换全局 document」的
 * 用例（ui/messages/state 等）之后——基线元素桩到那时已被换掉（它们的桩连 `setAttribute` 都没有）。
 * 因此这里自备一份最小元素，用完还原（同为基线 preload 的约定：只补自己缺的成员）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createExplorer, type ExplorerHooks } from "./explorer"
import type { DirEntry, FsApi, RootInfo } from "./api"

type AnyEl = Record<string, unknown>

/** 最小元素桩：够 `h()` / `icon()` 与资源管理器建行、重建整树用。 */
function makeEl(tag = "div"): AnyEl {
  const children: AnyEl[] = []
  const node: AnyEl = {
    tagName: tag.toUpperCase(),
    children,
    childNodes: children,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {},
    dataset: {},
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    value: "",
    disabled: false,
    hidden: false,
    isConnected: true,
    append(...cs: AnyEl[]) {
      children.push(...cs)
    },
    appendChild(c: AnyEl) {
      children.push(c)
      return c
    },
    prepend(...cs: AnyEl[]) {
      children.unshift(...cs)
    },
    replaceChildren(...cs: AnyEl[]) {
      children.splice(0, children.length, ...cs)
    },
    removeChild(c: AnyEl) {
      const i = children.indexOf(c)
      if (i >= 0) children.splice(i, 1)
      return c
    },
    remove() {},
    replaceWith() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    blur() {},
    scrollIntoView() {},
    cloneNode: () => makeEl(tag),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  // `clear()` 靠 firstChild 逐个子节点摘除——得跟着 children 走，不能是一次性快照
  Object.defineProperty(node, "firstChild", { get: () => children[0] ?? null })
  return node
}

const doc = document as unknown as {
  createElement: unknown
  createElementNS: unknown
  createTextNode: unknown
  createDocumentFragment: unknown
}
const prev = {
  createElement: doc.createElement,
  createElementNS: doc.createElementNS,
  createTextNode: doc.createTextNode,
  createDocumentFragment: doc.createDocumentFragment,
}

beforeAll(() => {
  doc.createElement = (tag?: string) => makeEl(tag ?? "div")
  doc.createElementNS = (_ns: string, tag?: string) => makeEl(tag ?? "div")
  doc.createTextNode = (text: string) => ({ nodeType: 3, textContent: text })
  doc.createDocumentFragment = () => makeEl("fragment")
})

afterAll(() => {
  doc.createElement = prev.createElement
  doc.createElementNS = prev.createElementNS
  doc.createTextNode = prev.createTextNode
  doc.createDocumentFragment = prev.createDocumentFragment
})

/** 记下每次列举请求的 `showHidden`；树里只有普通文件，不触发预取。 */
function makeExplorer(): { explorer: ReturnType<typeof createExplorer>; calls: boolean[] } {
  const calls: boolean[] = []
  const entry: DirEntry = { name: "a.txt", path: "a.txt", type: "file", size: 1, mtime: 0 }
  const api = {
    list: async (_root: string, _path: string, opts: { showHidden?: boolean } = {}) => {
      calls.push(opts.showHidden === true)
      return { root: "r1", path: "", entries: [entry], truncated: false, total: 1, showHidden: opts.showHidden === true }
    },
  } as unknown as FsApi
  const hooks = {
    api,
    roots: () => [{ id: "r1", name: "根", path: "/root" }] as unknown as RootInfo[],
    rootsMeta: () => ({ writable: true, gitEnabled: false, sandboxed: false }),
    openFile: () => {},
    activeFile: () => null,
    gitStatus: () => null,
    repoPathPrefix: () => "",
    onFsChanged: () => {},
    onRootChanged: () => {},
  } as ExplorerHooks
  return { explorer: createExplorer(hooks), calls }
}

/** 等一次即发即忘的刷新落定（`applyHiddenDefault` 内部走 `void refresh()`）。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe("资源管理器的隐藏文件开关", () => {
  test("默认不列隐藏文件；套用服务端默认（true）后改写列举参数", async () => {
    const { explorer, calls } = makeExplorer()
    await explorer.setRoot("r1")
    expect(calls.at(-1)).toBe(false)

    explorer.applyHiddenDefault(true)
    await flush()
    expect(calls.at(-1)).toBe(true)
  })

  test("默认值与现状相同时不重新列举（刷新根清单不该白跑一趟）", async () => {
    const { explorer, calls } = makeExplorer()
    await explorer.setRoot("r1")
    const before = calls.length
    explorer.applyHiddenDefault(false)
    await flush()
    expect(calls.length).toBe(before)
  })
})
