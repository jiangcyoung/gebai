/**
 * 终端会话记忆（`files/term-sessions.ts`）：刷新后据此接管服务端已有会话。
 * 记忆出错的两类后果都要防住——**多开**（把前端占位 id 当服务端 id 存，刷新后 attach 必然失败，
 * 白试一轮）、**误接管**（旧实现的 id 混进新实现；脏数据让整个列表失效）。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { readTermSessions, realSessionIds, writeTermSessions } from "./term-sessions"

const KEY = "gebai.ui.termSessions"

afterEach(() => {
  localStorage.removeItem(KEY)
})

describe("term-sessions（终端会话记忆）", () => {
  test("往返：写入后读回同样的 id 与活动项", () => {
    writeTermSessions("pty", ["p1", "p2"], "p2")
    expect(readTermSessions("pty")).toEqual({ ids: ["p1", "p2"], active: "p2" })
  })

  test("实现不匹配当空处理（PTY ⇄ 管道式的 id 空间不通用）", () => {
    writeTermSessions("pty", ["p1"], "p1")
    expect(readTermSessions("legacy")).toEqual({ ids: [], active: null })
  })

  test("脏数据与非法项：非字符串条目过滤掉，整体不可解析时返回空", () => {
    localStorage.setItem(KEY, JSON.stringify({ kind: "pty", ids: ["p1", 3, null, "", "p2"], active: "p9" }))
    expect(readTermSessions("pty")).toEqual({ ids: ["p1", "p2"], active: null }) // active 不在 ids 里 → 回落到第一个
    localStorage.setItem(KEY, "{不是 JSON")
    expect(readTermSessions("pty")).toEqual({ ids: [], active: null })
  })

  test("空清单即清除记忆（一个会话都没接管到时不该留下残留）", () => {
    writeTermSessions("pty", ["p1"], "p1")
    writeTermSessions("pty", [], null)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(readTermSessions("pty")).toEqual({ ids: [], active: null })
  })

  test("active 不在 ids 里时不记录（避免接管到一个不存在的活动项）", () => {
    writeTermSessions("pty", ["p1"], "p8")
    expect(readTermSessions("pty")).toEqual({ ids: ["p1"], active: null })
  })

  test("realSessionIds：前端占位 id（tmpN）不进记忆", () => {
    expect(realSessionIds(["tmp1", "p1", "tmp22", "p2", "tmpid"])).toEqual(["p1", "p2", "tmpid"])
  })
})
