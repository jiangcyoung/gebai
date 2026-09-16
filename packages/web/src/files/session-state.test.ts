/**
 * 工作台状态记忆（`files/session-state.ts`）：存取回环、脏值免疫、空态不留残留。
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  FW_SESSION_KEY,
  FW_TAB_LIMIT,
  clearSession,
  loadSession,
  normalizeSession,
  parseSession,
  saveSession,
  tabKey,
  type FwSessionState,
} from "./session-state"

afterEach(() => {
  sessionStorage.removeItem(FW_SESSION_KEY)
})

const sample: FwSessionState = {
  root: "proj:gebai",
  tabs: [
    { root: "proj:gebai", path: "src/main.ts", mode: "edit", line: 42 },
    { root: "proj:gebai", path: "README.md", mode: "view" },
  ],
  active: tabKey("proj:gebai", "README.md"),
  leftView: "changes",
  leftVisible: true,
}

describe("状态记忆存取", () => {
  test("无记忆时读回 null", () => {
    expect(loadSession()).toBeNull()
  })

  test("存→读回一致（标签 / 活动标签 / 根 / 左栏）", () => {
    saveSession(sample)
    expect(loadSession()).toEqual(sample)
  })

  test("空状态清键（不留残留）", () => {
    saveSession(sample)
    saveSession({ tabs: [] })
    expect(sessionStorage.getItem(FW_SESSION_KEY)).toBeNull()
    expect(loadSession()).toBeNull()
  })

  test("坏 JSON 当没有记忆（不抛错）", () => {
    sessionStorage.setItem(FW_SESSION_KEY, "{ 不是 json")
    expect(loadSession()).toBeNull()
  })

  test("clearSession 抹掉记忆", () => {
    saveSession(sample)
    clearSession()
    expect(loadSession()).toBeNull()
  })

  test("tabKey 用 `|` 连接根与路径", () => {
    expect(tabKey("sess:abc", "tmp/a.txt")).toBe("sess:abc|tmp/a.txt")
  })
})

describe("解析对脏值免疫", () => {
  test("非对象一律 null", () => {
    expect(normalizeSession(null)).toBeNull()
    expect(normalizeSession("x")).toBeNull()
    expect(normalizeSession(42)).toBeNull()
  })

  test("缺 root/path 或类型不对的标签被丢弃，其余保留", () => {
    const s = normalizeSession({
      root: "proj:gebai",
      tabs: [{ root: "proj:gebai", path: "a.ts" }, { root: "proj:gebai" }, { path: "b.ts" }, null, "x", { root: 1, path: "c.ts" }],
    })
    expect(s?.tabs).toEqual([{ root: "proj:gebai", path: "a.ts", mode: "view", line: undefined }])
  })

  test("mode 只认 edit，其余归 view；line 非正/非数一律丢掉", () => {
    const s = normalizeSession({
      tabs: [
        { root: "r", path: "a", mode: "edit", line: 7 },
        { root: "r", path: "b", mode: "EDIT", line: 0 },
        { root: "r", path: "c", mode: "view", line: "12" },
      ],
    })
    expect(s?.tabs.map((t) => [t.mode, t.line])).toEqual([
      ["edit", 7],
      ["view", undefined],
      ["view", undefined],
    ])
  })

  test("leftView 只认三个合法值，其它丢掉；leftVisible 只认布尔", () => {
    expect(normalizeSession({ tabs: [], leftView: "search" })?.leftView).toBe("search")
    expect(normalizeSession({ tabs: [], leftView: "unknown" })?.leftView).toBeUndefined()
    expect(normalizeSession({ tabs: [], leftVisible: "yes" })?.leftVisible).toBeUndefined()
    expect(normalizeSession({ tabs: [], leftVisible: false })?.leftVisible).toBe(false)
  })

  test("标签超出上限时截断（保住打开顺序的前 N 个）", () => {
    const tabs = Array.from({ length: FW_TAB_LIMIT + 5 }, (_, i) => ({ root: "r", path: `f${i}.ts` }))
    const s = normalizeSession({ tabs })
    expect(s?.tabs.length).toBe(FW_TAB_LIMIT)
    expect(s?.tabs[0]?.path).toBe("f0.ts")
    expect(s?.tabs[FW_TAB_LIMIT - 1]?.path).toBe(`f${FW_TAB_LIMIT - 1}.ts`)
  })

  test("parseSession 接受空串/空值", () => {
    expect(parseSession(null)).toBeNull()
    expect(parseSession("")).toBeNull()
    expect(parseSession("{}")?.tabs).toEqual([])
  })
})
