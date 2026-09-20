/** 在途任务标记（服务中断留痕）：写入/扫描/补记/清理。 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RUN_MARKER_FILE, clearRunMarker, interruptedRunNote, reportInterruptedRuns, scanRunMarkers, writeRunMarker } from "./run-marker"

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "gebai-runmarker-"))
}

/** 造一个用户的会话目录：users/{user}/sessions/{sid}/。 */
function sessionDir(home: string, user: string, sid: string): string {
  const dir = join(home, "users", user, "sessions", sid)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("在途任务标记", () => {
  test("写入 → 扫描命中（含会话/用户归属）→ 清理后不再命中", () => {
    const home = tmpHome()
    try {
      const dir = sessionDir(home, "admin", "s1")
      writeRunMarker(dir, { sessionId: "s1", user: "admin", startedAt: 1000, prompt: "跑个长任务" })
      expect(existsSync(join(dir, RUN_MARKER_FILE))).toBe(true)
      const found = scanRunMarkers(home)
      expect(found).toHaveLength(1)
      expect(found[0].marker.sessionId).toBe("s1")
      expect(found[0].marker.user).toBe("admin")
      clearRunMarker(dir)
      expect(scanRunMarkers(home)).toHaveLength(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("损坏/字段不全的标记：不参与补记，且扫描时顺手清掉（防每次启动重复处理）", () => {
    const home = tmpHome()
    try {
      const dir = sessionDir(home, "admin", "s1")
      writeFileSync(join(dir, RUN_MARKER_FILE), "{ 不是 JSON", "utf8")
      expect(scanRunMarkers(home)).toHaveLength(0)
      expect(existsSync(join(dir, RUN_MARKER_FILE))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("补记：逐会话写入中断说明并清标记；写失败的会话同样清标记（不重复补偿）", async () => {
    const home = tmpHome()
    try {
      writeRunMarker(sessionDir(home, "admin", "s1"), { sessionId: "s1", user: "admin", startedAt: Date.now(), prompt: "A" })
      writeRunMarker(sessionDir(home, "bob", "s2"), { sessionId: "s2", user: "bob", startedAt: Date.now(), prompt: "B" })
      const seen: Array<{ sessionId: string; user: string; content: string }> = []
      const r = await reportInterruptedRuns(home, async (sessionId, user, content) => {
        if (sessionId === "s2") throw new Error("会话已删除")
        seen.push({ sessionId, user, content })
      })
      expect(r).toEqual({ reported: 1, failed: 1 })
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ sessionId: "s1", user: "admin" })
      expect(seen[0].content).toContain("服务进程中断")
      expect(scanRunMarkers(home)).toHaveLength(0) // 两个标记都已清（失败的那个也不重试）
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("活进程写的标记不算中断（同一 GEBAI_HOME 多实例：不能把另一实例在跑的任务误报为中断）", () => {
    const home = tmpHome()
    try {
      writeRunMarker(sessionDir(home, "admin", "s1"), { sessionId: "s1", user: "admin", startedAt: Date.now(), prompt: "A", pid: process.pid })
      expect(scanRunMarkers(home)).toHaveLength(0)
      // 已消失的进程写的标记（不可能存在的 pid）：照旧算中断
      writeRunMarker(sessionDir(home, "admin", "s2"), { sessionId: "s2", user: "admin", startedAt: Date.now(), prompt: "B", pid: 0x7ffffffe })
      expect(scanRunMarkers(home).map((f) => f.marker.sessionId)).toEqual(["s2"])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("中断说明：含开始时间与输入摘要，超长输入截断", () => {
    const note = interruptedRunNote({ sessionId: "s1", user: "admin", startedAt: 0, prompt: "x".repeat(200) })
    expect(note).toContain("服务进程中断")
    expect(note).toContain("…")
    expect(note.length).toBeLessThan(300)
  })
})
