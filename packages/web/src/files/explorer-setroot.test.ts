/**
 * 资源管理器「带初始目录换根」：`setRoot(id, path)` 必须**先列根再定位**。
 *
 * 为什么值得钉住：整棵树是从**根缓存**渲染的（`render()` 读 `entriesOf("")`），所以只做 `reveal(path)`
 * 会留下「根没列过」的状态，界面永远停在「加载中…」。触发条件是**深链接到子目录里的文件**
 * （`?root=…&path=imgproc/main.cpp`）——顶层文件时 `dir` 为空、走的是另一条分支，所以手工点几下
 * 很难碰到，真机实测才发现（文件照常打开、左栏却是空的）。这里直接断言「根被列过」。
 *
 * DOM 说明同 explorer-clipboard.test.ts：自备一份最小元素并在结束时还原。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createExplorer, type ExplorerHooks } from "./explorer"
import type { DirEntry, FsApi, RootInfo } from "./api"

type AnyEl = Record<string, unknown> & { contains?: (t: unknown) => boolean }

function makeEl(tag = "div"): AnyEl {
  const children: AnyEl[] = []
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const node: AnyEl = {
    tagName: tag.toUpperCase(),
    className: "",
    dataset: {},
    style: {},
    title: "",
    textContent: "",
    innerHTML: "",
    innerText: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    isConnected: true,
    children,
    childNodes: children,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild: (c: AnyEl) => {
      children.push(c)
      return c
    },
    append: (...cs: unknown[]) => {
      for (const c of cs) if (c) children.push(c as AnyEl)
    },
    prepend: (...cs: unknown[]) => {
      children.unshift(...(cs as AnyEl[]))
    },
    replaceChildren: (...cs: unknown[]) => {
      children.length = 0
      for (const c of cs) if (c) children.push(c as AnyEl)
    },
    removeChild: (c: AnyEl) => {
      const i = children.indexOf(c)
      if (i >= 0) children.splice(i, 1)
      return c
    },
    remove: () => {},
    replaceWith: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: (t: unknown): boolean => t === node || children.some((c) => c?.contains?.(t) === true),
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), cb])
    },
    removeEventListener: (type: string, cb: (e: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== cb))
    },
    focus: () => {},
    blur: () => {},
    scrollIntoView: () => {},
    cloneNode: () => makeEl(tag),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  Object.defineProperty(node, "firstChild", { get: () => children[0] ?? null })
  return node
}

const doc = document as unknown as { createElement: unknown; createElementNS: unknown; createTextNode: unknown; createDocumentFragment: unknown }
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

function file(path: string): DirEntry {
  return { name: path.split("/").pop() ?? path, path, type: "file", size: 1, mtime: 0 }
}
function dir(path: string): DirEntry {
  return { name: path, path, type: "dir", size: 0, mtime: 0 }
}

function setup(): { explorer: ReturnType<typeof createExplorer>; listing: string[] } {
  const dirs: Record<string, DirEntry[]> = {
    "": [dir("imgproc"), file("framework.hpp")],
    imgproc: [file("main.cpp")],
  }
  const listing: string[] = []
  const api = {
    list: async (_root: string, path: string) => {
      listing.push(path)
      const entries = dirs[path] ?? []
      return { root: "r1", path, entries, truncated: false, total: entries.length, showHidden: true }
    },
  } as unknown as FsApi
  const hooks: ExplorerHooks = {
    api,
    roots: () => [{ id: "r1", name: "根一", path: "/root1" }] as unknown as RootInfo[],
    rootsMeta: () => ({ writable: true, gitEnabled: false, sandboxed: false }),
    openFile: () => {},
    activeFile: () => null,
    gitStatus: () => null,
    repoPathPrefix: () => "",
    onFsChange: () => {},
    onRootChanged: () => {},
  } as unknown as ExplorerHooks
  return { explorer: createExplorer(hooks), listing }
}

describe("setRoot 带初始目录（深链接到子目录里的文件）", () => {
  test("深链接到子目录里的**文件**：根先列，再逐级列出子目录（根必须先，否则整树停在「加载中…」）", async () => {
    const { explorer, listing } = setup()
    await explorer.setRoot("r1", "imgproc/main.cpp")
    expect(listing).toContain("")
    expect(listing).toContain("imgproc")
    // 顺序即渲染前提：整树从根缓存渲染
    expect(listing.indexOf("")).toBeLessThan(listing.indexOf("imgproc"))
  })

  test("目标是**目录**时：只需列根（该行由根列表给出，展开由用户触发）", async () => {
    const { explorer, listing } = setup()
    await explorer.setRoot("r1", "imgproc")
    expect(listing).toEqual([""])
  })

  test("不带目录时行为不变（仍是列根一次）", async () => {
    const { explorer, listing } = setup()
    await explorer.setRoot("r1")
    expect(listing).toEqual([""])
  })
})
