import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TaskRunRecord } from "@gebai/sdk"
import { TASK_RUNS_KEEP, importTaskRuns, listTaskRuns, runFileName, taskRunsDir, trimTaskRuns, writeTaskRun } from "./task-runs"

function rec(at: number, over: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return { id: `r${at}`, at, endedAt: at + 100, status: "success", durationMs: 100, ...over }
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "gebai-task-runs-"))
}

describe("任务执行记录存储", () => {
  test("目录与文件名：三级结构（task-runs/{taskId}/）、文件名为时间且字典序即时序", () => {
    const h = home()
    try {
      expect(taskRunsDir(h, "admin", "t1")).toBe(join(h, "users", "admin", "task-runs", "t1"))
      // UTC ISO、冒号替换为 -（Windows 文件名安全）
      expect(runFileName(Date.UTC(2026, 8, 24, 11, 12, 59, 918))).toBe("2026-09-24T11-12-59.918Z.json")
      expect(runFileName(0, 1)).toMatch(/_2\.json$/)
      const names = [runFileName(2000), runFileName(1000), runFileName(3000)]
      expect([...names].sort()).toEqual([runFileName(1000), runFileName(2000), runFileName(3000)])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test("写入与读取：新→旧排序、limit 截断、同毫秒不互相覆盖", async () => {
    const h = home()
    try {
      const taskId = "a".repeat(32)
      expect(await writeTaskRun(h, "admin", taskId, rec(1000))).toBe(runFileName(1000))
      await writeTaskRun(h, "admin", taskId, rec(3000))
      // 同毫秒第二条：自动加序号，两条都在
      const second = await writeTaskRun(h, "admin", taskId, rec(1000, { id: "dup" }))
      expect(second).toBe(runFileName(1000, 1))
      const all = await listTaskRuns(h, "admin", taskId)
      expect(all.map((r) => r.id)).toEqual(["r3000", "dup", "r1000"])
      expect(await listTaskRuns(h, "admin", taskId, 1)).toHaveLength(1)
      expect(await listTaskRuns(h, "admin", taskId, 0)).toEqual([])
      // 目录不存在（从未执行过）：空清单而非报错
      expect(await listTaskRuns(h, "admin", "b".repeat(32))).toEqual([])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test("损坏文件跳过、保留上限按时间删最旧", async () => {
    const h = home()
    try {
      const taskId = "c".repeat(32)
      for (let i = 1; i <= 5; i++) await writeTaskRun(h, "admin", taskId, rec(i * 1000))
      // 手工塞一个半截文件（模拟写入中断）：读取跳过，不影响其余记录
      writeFileSync(join(taskRunsDir(h, "admin", taskId), runFileName(9999)), "{ 半截")
      expect(await listTaskRuns(h, "admin", taskId)).toHaveLength(5)
      // 上限清理：保留最新 3 条（最旧的被删）——含那个损坏文件（它名最新、留在目录但读取时跳过）
      expect(await trimTaskRuns(h, "admin", taskId, 3)).toBe(3)
      expect((await listTaskRuns(h, "admin", taskId)).map((r) => r.at)).toEqual([5000, 4000])
      expect(await trimTaskRuns(h, "admin", taskId, 3)).toBe(0)
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  test("旧内联记录导入：按时间升序落盘、幂等（目录已有记录即跳过）、超上限清理", async () => {
    const h = home()
    try {
      const taskId = "d".repeat(32)
      const legacy = [rec(3000), rec(1000), rec(2000)]
      expect(await importTaskRuns(h, "admin", taskId, legacy)).toBe(3)
      expect((await listTaskRuns(h, "admin", taskId)).map((r) => r.at)).toEqual([3000, 2000, 1000])
      // 幂等：再次导入不产生重复
      expect(await importTaskRuns(h, "admin", taskId, legacy)).toBe(0)
      expect(await listTaskRuns(h, "admin", taskId)).toHaveLength(3)
      // 导入同样受保留上限约束
      const many = Array.from({ length: TASK_RUNS_KEEP + 5 }, (_, i) => rec(1_000_000 + i))
      const h2 = home()
      try {
        await importTaskRuns(h2, "admin", taskId, many)
        expect((await listTaskRuns(h2, "admin", taskId)).length).toBe(TASK_RUNS_KEEP)
      } finally {
        rmSync(h2, { recursive: true, force: true })
      }
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})
