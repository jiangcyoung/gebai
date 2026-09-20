/**
 * 资源管理器剪贴板：复制 → 粘贴落到服务端 `/fs/copy` 的请求形状与守卫。
 *
 * 为什么值得测：粘贴的落点与「撞名怎么办」全在这条链上——落点算错就是覆盖别人的文件，
 * 而这类判断只有走完真实的 api 调用（列举目标目录 → 挑落点 → 复制）才看得出对不对。
 *
 * DOM 说明：`createExplorer` 在构造期就建元素，而基线 preload 的全局 document 可能已被
 * 其它用例的整体替换覆盖掉，故本文件自备一份最小元素并在结束时还原（与 explorer-hidden 同一约定）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createExplorer, type ExplorerHooks } from "./explorer"
import type { DirEntry, FsApi, RootInfo } from "./api"

type AnyEl = Record<string, unknown> & { contains?: (t: unknown) => boolean }

function makeEl(tag = "div"): AnyEl {
  const children: AnyEl[] = []
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  /** 真实包含关系：键盘守卫靠 `el.contains(事件目标)` 判「点的是不是树里」，桩必须是真判定。 */
  const contains = (t: unknown): boolean => t === node || children.some((c) => c?.contains?.(t) === true)
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
    contains,
    addEventListener(type: string, cb: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), cb])
    },
    removeEventListener(type: string, cb: (e: unknown) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== cb))
    },
    /** 测试用：把已登记的处理函数按类型跑一遍（桩没有真实事件派发）。 */
    dispatch(type: string, ev: unknown) {
      for (const cb of listeners.get(type) ?? []) cb(ev)
    },
    focus() {},
    blur() {},
    scrollIntoView() {},
    cloneNode: () => makeEl(tag),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  }
  Object.defineProperty(node, "firstChild", { get: () => children[0] ?? null })
  return node
}

const doc = document as unknown as {
  createElement: unknown
  createElementNS: unknown
  createTextNode: unknown
  createDocumentFragment: unknown
  addEventListener: unknown
}
const prev = {
  createElement: doc.createElement,
  createElementNS: doc.createElementNS,
  createTextNode: doc.createTextNode,
  createDocumentFragment: doc.createDocumentFragment,
  addEventListener: doc.addEventListener,
}
/** 基线 document 的 addEventListener 是 no-op：这里改成登记下来，测「点到树之外」的取消逻辑。 */
const docListeners = new Map<string, Array<(e: unknown) => void>>()

beforeAll(() => {
  doc.createElement = (tag?: string) => makeEl(tag ?? "div")
  doc.createElementNS = (_ns: string, tag?: string) => makeEl(tag ?? "div")
  doc.createTextNode = (text: string) => ({ nodeType: 3, textContent: text })
  doc.createDocumentFragment = () => makeEl("fragment")
  doc.addEventListener = (type: string, cb: (e: unknown) => void) => {
    docListeners.set(type, [...(docListeners.get(type) ?? []), cb])
  }
})

afterAll(() => {
  doc.createElement = prev.createElement
  doc.createElementNS = prev.createElementNS
  doc.createTextNode = prev.createTextNode
  doc.createDocumentFragment = prev.createDocumentFragment
  doc.addEventListener = prev.addEventListener
  docListeners.clear()
})

function file(path: string): DirEntry {
  return { name: path.split("/").pop() ?? path, path, type: "file", size: 1, mtime: 0 }
}
function dir(path: string): DirEntry {
  return { name: path, path, type: "dir", size: 0, mtime: 0 }
}

interface CopyCall {
  root: string
  path: string
  to: string
  overwrite: boolean
}

/** 目录内容固定的一套夹具：根有 `a.txt` 与 `src/`，`src/dst/` 里另有一个 `a.txt`。 */
function setup(opts: { writable?: boolean } = {}): {
  explorer: ReturnType<typeof createExplorer>
  copies: CopyCall[]
  listing: string[]
  changed: () => number
} {
  const dirs: Record<string, DirEntry[]> = {
    "": [file("a.txt"), dir("src")],
    dst: [file("keep.txt")],
    src: [file("inner.txt")],
    "src/dst": [file("a.txt")],
  }
  const copies: CopyCall[] = []
  const listing: string[] = []
  let changes = 0
  const api = {
    list: async (_root: string, path: string) => {
      listing.push(path)
      const entries = dirs[path] ?? []
      return { root: "r1", path, entries, truncated: false, total: entries.length, showHidden: true }
    },
    copy: async (root: string, path: string, to: string, overwrite: boolean) => {
      copies.push({ root, path, to, overwrite })
      return { ok: true, path: to }
    },
  } as unknown as FsApi
  const hooks: ExplorerHooks = {
    api,
    roots: () => [{ id: "r1", name: "根一", path: "/root1" }, { id: "r2", name: "根二", path: "/root2" }] as unknown as RootInfo[],
    rootsMeta: () => ({ writable: opts.writable ?? true, gitEnabled: false, sandboxed: false }),
    openFile: () => {},
    activeFile: () => null,
    gitStatus: () => null,
    repoPathPrefix: () => "",
    onFsChanged: () => {
      changes++
    },
    onRootChanged: () => {},
  }
  return { explorer: createExplorer(hooks), copies, listing, changed: () => changes }
}

/** 选中一条（右键/Ctrl+C 的前置动作就是它）。 */
async function select(explorer: ReturnType<typeof createExplorer>, path: string): Promise<void> {
  await explorer.reveal(path)
}

describe("复制到目标目录", () => {
  test("原名空着就用原名，且一律非覆盖", async () => {
    const { explorer, copies, changed } = setup()
    await explorer.setRoot("r1")
    await select(explorer, "a.txt")
    expect(explorer.copySelection()).toBe(true)
    expect(explorer.clipboard()).toEqual({ root: "r1", path: "a.txt", isDir: false })

    await explorer.paste("dst")
    expect(copies).toEqual([{ root: "r1", path: "a.txt", to: "dst/a.txt", overwrite: false }])
    expect(changed()).toBe(1)
  })

  test("粘回原目录 = 造一份副本（不覆盖源文件）", async () => {
    const { explorer, copies } = setup()
    await explorer.setRoot("r1")
    await select(explorer, "a.txt")
    explorer.copySelection()
    await explorer.paste("")
    expect(copies[0]?.to).toBe("a - 副本.txt")
  })

  test("目标目录已有同名：顺延到「- 副本 (2)」，不覆盖", async () => {
    const { explorer, copies } = setup()
    await explorer.setRoot("r1")
    await select(explorer, "a.txt")
    explorer.copySelection()
    await explorer.paste("src/dst")
    expect(copies[0]?.to).toBe("src/dst/a - 副本.txt")
  })

  test("目录也按同一套命名，且不拆扩展名", async () => {
    const { explorer, copies } = setup()
    await explorer.setRoot("r1")
    await select(explorer, "src")
    explorer.copySelection()
    expect(explorer.clipboard()?.isDir).toBe(true)
    await explorer.paste("")
    expect(copies[0]?.to).toBe("src - 副本")
  })

  test("没选中就没有可复制的东西", async () => {
    const { explorer } = setup()
    await explorer.setRoot("r1")
    expect(explorer.copySelection()).toBe(false)
    expect(explorer.clipboard()).toBeNull()
  })
})

describe("守卫", () => {
  test("目录不能粘进自己的子树（递归复制）", async () => {
    const { explorer, copies } = setup()
    await explorer.setRoot("r1")
    await select(explorer, "src")
    explorer.copySelection()
    await explorer.paste("src/dst")
    expect(copies).toEqual([])
  })

  test("跨根不粘贴：条目在别的根时明确不可用", async () => {
    const { explorer, copies } = setup()
    await explorer.setRoot("r1")
    await select(explorer, "a.txt")
    explorer.copySelection()
    await explorer.setRoot("r2")
    expect(explorer.canPaste()).toBe(false)
    await explorer.paste("")
    expect(copies).toEqual([])
  })

  test("只读模式不粘贴", async () => {
    const { explorer, copies } = setup({ writable: false })
    await explorer.setRoot("r1")
    await select(explorer, "a.txt")
    explorer.copySelection()
    expect(explorer.canPaste()).toBe(false)
    await explorer.paste("dst")
    expect(copies).toEqual([])
  })

  test("活动区：树里按过才接管，点到别处就交还（Ctrl+C 不能抢走文本复制）", () => {
    const { explorer } = setup()
    const el = explorer.el as unknown as { dispatch: (type: string, ev: unknown) => void }
    expect(explorer.isActive()).toBe(false)

    el.dispatch("pointerdown", {})
    expect(explorer.isActive()).toBe(true)

    // 点到树之外：document 上的 pointerdown 目标不在树内 → 交还
    for (const cb of docListeners.get("pointerdown") ?? []) cb({ target: {} })
    expect(explorer.isActive()).toBe(false)

    // 点在树内（同一个根元素）则保持接管
    el.dispatch("pointerdown", {})
    for (const cb of docListeners.get("pointerdown") ?? []) cb({ target: explorer.el })
    expect(explorer.isActive()).toBe(true)
  })
})
