import { describe, expect, test } from "bun:test"
import {
  browserConflict,
  createKeymap,
  DEFAULT_FOCUS,
  focusKind,
  formatSpec,
  helpGroups,
  matchKey,
  normalizeKeyName,
  parseSpec,
  toSpecList,
  validateKeymap,
  type KeyBinding,
  type KeyEventLike,
  type KeyTarget,
} from "./keymap"

/* ------------------------------ 测试替身 ------------------------------ */

function makeEvent(o: Partial<KeyEventLike> = {}) {
  const e = {
    key: o.key ?? "",
    ctrlKey: !!o.ctrlKey,
    metaKey: !!o.metaKey,
    altKey: !!o.altKey,
    shiftKey: !!o.shiftKey,
    repeat: o.repeat,
    isComposing: o.isComposing,
    target: o.target,
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true
    },
    stopPropagation() {
      e.stopped = true
    },
  }
  return e
}

const PLAIN = { tagName: "DIV", closest: () => null, isContentEditable: false }
const INPUT = { tagName: "INPUT", closest: () => null, isContentEditable: false }
const EDITOR = { tagName: "TEXTAREA", closest: (s: string) => s.includes("monaco"), isContentEditable: false }
const TERMINAL = { tagName: "TEXTAREA", closest: (s: string) => s.includes("xterm"), isContentEditable: false }

function makeTarget(): KeyTarget & { fire: (e: KeyEventLike, phase: "capture" | "bubble") => void } {
  const listeners: Array<{ fn: (e: KeyEventLike) => void; capture: boolean }> = []
  return {
    addEventListener(_type, fn, capture) {
      listeners.push({ fn, capture: !!capture })
    },
    removeEventListener() {
      listeners.length = 0
    },
    fire(e, phase) {
      for (const l of listeners.filter((l) => l.capture === (phase === "capture"))) l.fn(e)
    },
  }
}

function binding(over: Partial<KeyBinding> & { id: string; keys: string | string[] }): KeyBinding {
  return { label: over.id, group: "main.session", run: () => {}, ...over }
}

/* ------------------------------ 键位解析 ------------------------------ */

describe("键位规范化与匹配", () => {
  test("键名归一：方向键多种写法、Shift+= 的 + 与 = 同一物理键", () => {
    expect(normalizeKeyName("ArrowDown")).toBe("↓")
    expect(normalizeKeyName("down")).toBe("↓")
    expect(normalizeKeyName("ARROWDOWN")).toBe("↓")
    expect(normalizeKeyName("+")).toBe("=")
    expect(normalizeKeyName("e")).toBe("E")
    expect(normalizeKeyName("F2")).toBe("F2")
    expect(normalizeKeyName("Escape")).toBe("Esc")
    expect(normalizeKeyName(" ")).toBe("Space")
  })

  test("写法解析：修饰键顺序无关，Ctrl/Cmd/Meta 同一含义", () => {
    const p = parseSpec("Alt+Ctrl+S")
    expect(p).toEqual({ ctrl: true, alt: true, shift: false, key: "S" })
    expect(parseSpec("Cmd+Alt+S")).toEqual(p!)
    expect(parseSpec("Meta+Alt+S")).toEqual(p!)
    expect(parseSpec("Ctrl+Alt")).toBeNull()
    // 末尾的 "+" 是键本体（按 Shift+= 得到的符号），归一成 "="
    expect(parseSpec("Ctrl+Alt+")).toEqual({ ctrl: true, alt: true, shift: false, key: "=" })
  })

  test("规范显示写法：修饰键固定顺序，键名归一", () => {
    expect(formatSpec("shift+ctrl+alt+e")).toBe("Ctrl+Alt+Shift+E")
    expect(formatSpec("ctrl+alt+arrowdown")).toBe("Ctrl+Alt+↓")
    expect(formatSpec("ctrl+alt++")).toBe("Ctrl+Alt+=")
    expect(formatSpec("ctrl+alt+=")).toBe("Ctrl+Alt+=")
  })

  test("匹配：修饰键精确相等，Meta 视作 Ctrl", () => {
    const spec = parseSpec("Ctrl+Alt+S")!
    expect(matchKey(makeEvent({ key: "s", ctrlKey: true, altKey: true }), spec)).toBe(true)
    expect(matchKey(makeEvent({ key: "s", metaKey: true, altKey: true }), spec)).toBe(true)
    expect(matchKey(makeEvent({ key: "s", ctrlKey: true, altKey: true, shiftKey: true }), spec)).toBe(false)
    expect(matchKey(makeEvent({ key: "s", ctrlKey: true }), spec)).toBe(false)
    expect(matchKey(makeEvent({ key: "e", ctrlKey: true, altKey: true }), spec)).toBe(false)
  })
})

describe("焦点环境判定", () => {
  test("容器归属优先于标签名：Monaco 与 xterm 内部都是隐藏 textarea", () => {
    expect(focusKind(EDITOR)).toBe("editor")
    expect(focusKind(TERMINAL)).toBe("terminal")
    expect(focusKind(INPUT)).toBe("input")
    expect(focusKind(PLAIN)).toBe("other")
    expect(focusKind(null)).toBe("other")
    expect(focusKind(undefined)).toBe("other")
  })
})

/* ------------------------------ 浏览器冲突判定 ------------------------------ */

describe("浏览器冲突判定（能接管的接管，拿不到的写清后果）", () => {
  test("可接管：浏览器有默认行为，但按键先到页面（Chromium 的 NOT_HANDLED_IS_SHORTCUT）", () => {
    const cases: Array<[string, string]> = [
      ["Ctrl+S", "保存网页"],
      ["Ctrl+P", "打印"],
      ["Ctrl+F", "页面查找"],
      ["Ctrl+E", "地址栏搜索"],
      ["Ctrl+B", "书签（Firefox 为侧栏）"],
      ["Ctrl+K", "地址栏搜索"],
      ["Ctrl+L", "聚焦地址栏"],
      ["Ctrl+=", "放大页面"],
      ["Ctrl+-", "缩小页面"],
      ["Ctrl+0", "重置页面缩放"],
      ["Ctrl+Shift+C", "DevTools 审查元素（DevTools 打开时）"],
      ["Ctrl+Shift+V", "粘贴为纯文本"],
      ["F5", "刷新页面"],
      ["F7", "光标浏览"],
      ["Ctrl+1", "切换到第 1 个标签页"],
    ]
    for (const [spec, what] of cases) expect(browserConflict(spec)).toEqual({ level: "override", what })
  })

  test("拿不到：Chromium 保留命令——页面收不到按键，只能按 reserved 声明", () => {
    const cases: Array<[string, string]> = [
      ["Ctrl+N", "打开新窗口"],
      ["Ctrl+T", "打开新标签页"],
      ["Ctrl+W", "关闭标签页"],
      ["Ctrl+Shift+T", "恢复刚关闭的标签页"],
      ["Ctrl+Shift+W", "关闭窗口"],
      ["Ctrl+Tab", "切换标签页"],
      ["Ctrl+PageDown", "切换标签页"],
      ["Alt+F4", "系统：关闭窗口"],
      ["Ctrl+Alt+Del", "系统：安全选项"],
    ]
    for (const [spec, what] of cases) expect(browserConflict(spec)).toEqual({ level: "reserved", what })
  })

  test("无冲突：Ctrl+Alt 族、文本编辑类 Ctrl、裸键与自定 Alt 字母", () => {
    for (const spec of ["Ctrl+Alt+S", "Ctrl+Alt+↓", "Ctrl+Alt+L", "Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Enter", "Alt+Z", "Alt+G", "Alt+M", "F2", "F8", "F9", "Esc", "Enter", "Y", "N", "↑", "Space"]) {
      expect(browserConflict(spec).level).toBe("free")
    }
  })

  test("族级保守判定：没进清单的 Ctrl / Ctrl+Shift / 功能键也算接管（新增键位必须自己查一遍）", () => {
    expect(browserConflict("Ctrl+Shift+G")).toEqual({ level: "override" })
    expect(browserConflict("Ctrl+`")).toEqual({ level: "override" })
    expect(browserConflict("Ctrl+\\")).toEqual({ level: "override" })
    expect(browserConflict("Shift+F7")).toEqual({ level: "override" })
    expect(browserConflict("F11")).toEqual({ level: "override", what: "全屏" })
  })

  test("写法无法解析时按不可用处理（防止手误写错的键位悄悄生效）", () => {
    expect(browserConflict("Ctrl+Alt").level).toBe("reserved")
    expect(browserConflict("").level).toBe("reserved")
  })
})

/* ------------------------------ 分发器 ------------------------------ */

describe("分发器", () => {
  test("命中即执行、阻止默认与继续传播（接管浏览器默认的键也一样）", () => {
    let hits = 0
    const map = createKeymap([binding({ id: "t.save", keys: "Ctrl+S", browser: "override", run: () => hits++ })])
    const target = makeTarget()
    map.install(target)
    const e = makeEvent({ key: "s", ctrlKey: true, target: PLAIN })
    target.fire(e, "bubble")
    expect(hits).toBe(1)
    expect(e.prevented).toBe(true)
    expect(e.stopped).toBe(true)
  })

  test("输入框内默认不接管；声明 focus 含 input 的才生效", () => {
    let a = 0
    let b = 0
    const map = createKeymap([
      binding({ id: "t.default", keys: "Ctrl+Alt+S", run: () => a++ }),
      binding({ id: "t.force", keys: "Ctrl+Alt+R", focus: ["other", "editor", "input"], run: () => b++ }),
    ])
    const target = makeTarget()
    map.install(target)
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: INPUT }), "bubble")
    target.fire(makeEvent({ key: "r", ctrlKey: true, altKey: true, target: INPUT }), "bubble")
    expect(a).toBe(0)
    expect(b).toBe(1)
  })

  test("终端面板内不接管（shell 的 readline 键归终端自己）", () => {
    let hits = 0
    const map = createKeymap([binding({ id: "t.w", keys: "Ctrl+Alt+W", run: () => hits++ })])
    const target = makeTarget()
    map.install(target)
    target.fire(makeEvent({ key: "w", ctrlKey: true, altKey: true, target: TERMINAL }), "bubble")
    expect(hits).toBe(0)
  })

  test("输入法组合态与长按重复都不触发", () => {
    let hits = 0
    const map = createKeymap([binding({ id: "t.s", keys: "Ctrl+Alt+S", run: () => hits++ })])
    const target = makeTarget()
    map.install(target)
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN, isComposing: true }), "bubble")
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN, repeat: true }), "bubble")
    expect(hits).toBe(0)
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN }), "bubble")
    expect(hits).toBe(1)
  })

  test("阶段区分：捕获绑定不吃冒泡事件，冒泡绑定不吃捕获事件", () => {
    const seen: string[] = []
    const map = createKeymap([
      binding({ id: "t.cap", keys: "Alt+Z", phase: "capture", run: () => seen.push("cap") }),
      binding({ id: "t.bub", keys: "Ctrl+Alt+S", run: () => seen.push("bub") }),
    ])
    const target = makeTarget()
    map.install(target)
    target.fire(makeEvent({ key: "z", altKey: true, target: EDITOR }), "bubble")
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN }), "capture")
    expect(seen).toEqual([])
    target.fire(makeEvent({ key: "z", altKey: true, target: EDITOR }), "capture")
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN }), "bubble")
    expect(seen).toEqual(["cap", "bub"])
  })

  test("when 不满足时让给下一个绑定（同键按条件分派）", () => {
    const seen: string[] = []
    const map = createKeymap([
      binding({ id: "t.first", keys: "Ctrl+Alt+S", when: () => false, run: () => seen.push("first") }),
      binding({ id: "t.second", keys: "Ctrl+Alt+S", when: () => true, run: () => seen.push("second") }),
    ])
    const target = makeTarget()
    map.install(target)
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN }), "bubble")
    expect(seen).toEqual(["second"])
  })

  test("作用域栈顶优先：一次 Esc 只关最上层", () => {
    const closed: string[] = []
    const map = createKeymap([binding({ id: "t.menu", keys: "Esc", run: () => closed.push("menu") })])
    const target = makeTarget()
    map.install(target)
    map.pushScope({ id: "dialog", bindings: [binding({ id: "t.dialog", keys: "Esc", run: () => closed.push("dialog") })] })
    map.pushScope({ id: "preview", bindings: [binding({ id: "t.preview", keys: "Esc", run: () => closed.push("preview") })] })
    target.fire(makeEvent({ key: "Escape", target: PLAIN }), "bubble")
    expect(closed).toEqual(["preview"])
    map.popScope("preview")
    target.fire(makeEvent({ key: "Escape", target: PLAIN }), "bubble")
    expect(closed).toEqual(["preview", "dialog"])
    map.popScope("dialog")
    target.fire(makeEvent({ key: "Escape", target: PLAIN }), "bubble")
    expect(closed).toEqual(["preview", "dialog", "menu"])
    expect(map.hasScope("dialog")).toBe(false)
  })

  test("元素级登记（owned: false）不参与分发，但可进入帮助与校验", () => {
    let hits = 0
    const b = binding({ id: "t.el", keys: "Enter", owned: false, run: () => hits++ })
    const map = createKeymap([b])
    const target = makeTarget()
    map.install(target)
    target.fire(makeEvent({ key: "Enter", target: PLAIN }), "bubble")
    expect(hits).toBe(0)
    expect(validateKeymap([b])).toEqual([])
  })

  test("uninstall 后不再监听", () => {
    let hits = 0
    const map = createKeymap([binding({ id: "t.s", keys: "Ctrl+Alt+S", run: () => hits++ })])
    const target = makeTarget()
    map.install(target)
    map.uninstall()
    target.fire(makeEvent({ key: "s", ctrlKey: true, altKey: true, target: PLAIN }), "bubble")
    expect(hits).toBe(0)
  })
})

/* ------------------------------ 校验与帮助 ------------------------------ */

import { mainKeymap } from "./keymap-main"
import { workbenchKeymap } from "./files/keymap-wb"

/* ------------------------------ 真实键位表 ------------------------------ */

describe("主界面键位表", () => {
  test("无重复登记、浏览器相关声明齐备（新增键位撞车在这里直接变红）", () => {
    expect(validateKeymap(mainKeymap.bindings())).toEqual([])
  })

  test("每个键位都有动作说明与分组（帮助 UI 与文档直接从表生成）", () => {
    for (const b of mainKeymap.bindings()) {
      expect(b.label.length).toBeGreaterThan(0)
      expect(b.group).toContain(".")
    }
  })

  test("带修饰键的绑定在输入框内也生效——主界面的默认焦点就在聊天输入框", () => {
    // 不带这条，快捷键会出现「按了没反应，点一下别处再来才好使」的怪现象（焦点守卫不一致）
    const composed = mainKeymap.bindings().filter((b) => b.owned !== false && toSpecList(b.keys).every((k) => parseSpec(k)?.ctrl))
    expect(composed.length).toBeGreaterThan(0)
    for (const b of composed) expect(b.focus ?? DEFAULT_FOCUS).toContain("input")
  })

  test("接管浏览器默认的键位都显式声明了接管，保留键都写了后果", () => {
    const declared = mainKeymap.bindings().filter((b) => b.owned !== false && b.browser)
    expect(declared.length).toBeGreaterThan(0)
    for (const b of declared) {
      const levels = toSpecList(b.keys).map((k) => browserConflict(k).level)
      if (b.browser === "override") expect(levels).toContain("override")
      else {
        expect(levels).toContain("reserved")
        expect(b.note?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  test("Ctrl+Alt 族已从表里腾空（那个族留作他用，不再当备用键）", () => {
    const specs = mainKeymap.bindings().flatMap((b) => toSpecList(b.keys))
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) {
      const parsed = parseSpec(spec)
      expect(parsed?.ctrl && parsed?.alt).toBeFalsy()
    }
  })
})

describe("工作台键位表（元素级登记部分；动作绑定在 files/main.ts 里启动时自检）", () => {
  test("元素级登记无重复、无冲突声明问题", () => {
    expect(validateKeymap(workbenchKeymap.bindings())).toEqual([])
  })

  test("Ctrl+Alt 族同样已腾空", () => {
    for (const b of workbenchKeymap.bindings()) {
      for (const spec of toSpecList(b.keys)) {
        const parsed = parseSpec(spec)
        expect(parsed?.ctrl && parsed?.alt).toBeFalsy()
      }
    }
  })
})

describe("键位表校验", () => {
  test("同键位 + 焦点重叠的重复登记被报出", () => {
    const issues = validateKeymap([
      binding({ id: "a", keys: "Ctrl+Alt+S" }),
      binding({ id: "b", keys: "Ctrl+Alt+S" }),
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe("duplicate")
    expect(issues[0].detail).toContain("a")
  })

  test("焦点不重叠的同键位合法（终端键与全局键可以同名）", () => {
    const issues = validateKeymap([
      binding({ id: "global", keys: "Ctrl+Alt+C" }),
      binding({ id: "term", keys: "Ctrl+Alt+C", focus: ["terminal"] }),
    ])
    expect(issues).toEqual([])
  })

  test("接管未声明、保留键没写后果、写法错误都被报出", () => {
    const issues = validateKeymap([
      binding({ id: "undeclared", keys: "Ctrl+S" }),
      binding({ id: "reservedNoNote", keys: "Ctrl+W", browser: "reserved" }),
      binding({ id: "typo", keys: "Ctrl+Alt" }),
    ])
    expect(issues.map((i) => i.kind).sort()).toEqual(["browser-note", "browser-undeclared", "invalid"])
    expect(issues.map((i) => i.id).sort()).toEqual(["reservedNoNote", "typo", "undeclared"])
  })

  test("声明齐备时不再报错（接管要拦截、保留键要写 note）", () => {
    const issues = validateKeymap([
      binding({ id: "save", keys: "Ctrl+S", browser: "override" }),
      binding({ id: "close", keys: "Ctrl+W", browser: "reserved", note: "浏览器窗口里拿不到，仅桌面形态生效" }),
      binding({ id: "term", keys: "Ctrl+F", focus: ["terminal"], browser: "override" }),
    ])
    expect(issues).toEqual([])
  })

  test("接管浏览器默认却不拦截默认行为：报错", () => {
    const issues = validateKeymap([binding({ id: "soft", keys: "Ctrl+S", browser: "override", intercept: false })])
    expect(issues.map((i) => i.kind)).toEqual(["browser-undeclared"])
  })

  test("作用域表可单独校验（与基表同键是合法的）", () => {
    const scopeRows = [binding({ id: "s.esc", keys: "Esc" })]
    expect(validateKeymap(scopeRows, "scope:menu")).toEqual([])
  })
})

describe("帮助数据", () => {
  test("按分组输出，空组不出现，键位用规范写法", () => {
    const groups = helpGroups([
      binding({ id: "y", keys: ["Y", "N"], label: "审批", group: "main.approval" }),
      binding({ id: "s", keys: "Ctrl+S", label: "保存", group: "wb.file", browser: "override" }),
    ])
    expect(groups.map((g) => g.id)).toEqual(["main.approval", "wb.file"])
    expect(groups[0].rows[0].keys).toEqual(["Y", "N"])
    expect(groups[1].title).toBe("工作台 · 文件")
    expect(groups[1].rows[0].keys).toEqual(["Ctrl+S"])
  })

  test("带出被接管的浏览器行为（帮助 UI 据此标注）", () => {
    const groups = helpGroups([
      binding({ id: "s", keys: "Ctrl+S", label: "保存", group: "wb.file", browser: "override" }),
      binding({ id: "y", keys: "Y", label: "审批", group: "main.approval" }),
    ])
    expect(groups[0].rows[0].takesOver).toBeUndefined()
    expect(groups[1].rows[0].takesOver).toBe("保存网页")
  })
})
