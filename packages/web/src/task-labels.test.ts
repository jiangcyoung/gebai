import { beforeEach, describe, expect, test } from "bun:test"
import { clearTaskLabels, rememberTaskLabels, taskLabel } from "./task-labels"

/** 服务端任务文本样例（格式取自 packages/server/src/core/tools/{exec,agent}.ts 的 shTaskLine / subSessionLine 与启动结果）。 */
const SH_RUNNING = "taskId t3f8a1b2 [running] 12s — bun run build"
const SH_DONE = "taskId t3f8a1b2 [done] 34s（exit 0） — bun run build"
const SH_KILLED = "taskId t0aa11bb [killed] 5s [已手动终止] — bun test"
const SH_START = "[后台任务已启动] taskId: t77cc99dd\n命令: bun run typecheck\n（后台执行中不阻塞会话——可先处理其他任务，之后用 bg_task action=status id=t77cc99dd 查询输出）"
const SUB_RUNNING = "runId s9c2e1b0「调研A」 [running] 8s — 隔离上下文 · 子Agent code（已 3 轮回复、5 次工具调用）"
const SUB_DONE = "runId s9c2e1b0「调研A」 [done] 61s — 继承上下文（已完成，报告已合入父会话）"
const SUB_START = "[子会话已后台启动] 共 1 个并行执行（隔离上下文），完成后用 bg_task 取回最终结果（过程实时推送到前端）:\n- 「调研A」 runId: s9c2e1b0（fast）· 子Agent code"

describe("后台任务身份表（task-labels）", () => {
  beforeEach(() => clearTaskLabels())

  test("命令任务状态行：running/done/终止形态都登记命令", () => {
    rememberTaskLabels(`${SH_RUNNING}\n${SH_KILLED}`)
    expect(taskLabel("t3f8a1b2")).toBe("命令 bun run build")
    expect(taskLabel("t0aa11bb")).toBe("命令 bun test")
    // 结束态行（命令前的 `（exit 0）` 中间段）同样解析
    rememberTaskLabels(SH_DONE)
    expect(taskLabel("t3f8a1b2")).toBe("命令 bun run build")
  })

  test("命令任务启动结果：taskId 下一行的「命令:」登记", () => {
    rememberTaskLabels(SH_START)
    expect(taskLabel("t77cc99dd")).toBe("命令 bun run typecheck")
  })

  test("子会话状态行与启动结果：两种字段顺序都登记名称", () => {
    rememberTaskLabels(`${SUB_RUNNING}\n${SUB_DONE}\n${SUB_START}`)
    expect(taskLabel("s9c2e1b0")).toBe("子会话「调研A」")
  })

  test("子会话启动结果可单独解析（名在 id 之前）", () => {
    rememberTaskLabels(SUB_START)
    expect(taskLabel("s9c2e1b0")).toBe("子会话「调研A」")
  })

  test("bg_task list 的多行清单：逐行登记（含两类任务混排）", () => {
    rememberTaskLabels(`本会话后台任务（2 个，按启动顺序——t 开头为命令任务、s 开头为子会话运行）:\n${SH_RUNNING}\n${SUB_RUNNING}`)
    expect(taskLabel("t3f8a1b2")).toBe("命令 bun run build")
    expect(taskLabel("s9c2e1b0")).toBe("子会话「调研A」")
  })

  test("无任务行的文本不登记；未知 id 返回 undefined", () => {
    rememberTaskLabels("工具结果：taskId 形如 tXXXXXXXX（说明文本，非任务行）\nrunId 以 subsession_run 返回为准")
    rememberTaskLabels("")
    expect(taskLabel("tXXXXXXXX")).toBeUndefined()
    expect(taskLabel("s9c2e1b0")).toBeUndefined()
  })

  test("重复出现的 id 以最新身份覆盖（名称可变更）", () => {
    rememberTaskLabels("runId s1234abcd「旧名」 [running] 1s — 隔离上下文")
    rememberTaskLabels("runId s1234abcd「新名」 [done] 9s — 隔离上下文（已完成）")
    expect(taskLabel("s1234abcd")).toBe("子会话「新名」")
  })

  test("表容量上限：超出后淘汰最早的登记", () => {
    for (let i = 0; i < 520; i++) rememberTaskLabels(`taskId t${i.toString(16).padStart(8, "0")} [running] 1s — cmd${i}`)
    // 最早的若干条被淘汰、最新的仍在
    expect(taskLabel(`t${(0).toString(16).padStart(8, "0")}`)).toBeUndefined()
    expect(taskLabel(`t${(519).toString(16).padStart(8, "0")}`)).toBe("命令 cmd519")
  })
})
