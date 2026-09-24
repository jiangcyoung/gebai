/**
 * 任务执行记录存储（`users/{user}/task-runs/{taskId}/{时间}.json`）。
 *
 * 执行记录是**时序流水**而非任务定义的一部分：此前内联在 `tasks.json` 的 `runs` 数组里，两次收尾
 * （定时到期 skipped、执行结束）都要整体重写任务定义文件，记录体积与定义体积耦合，只能环形截断
 * 在内存态可承受的条数。改为按文件落盘后：一条记录一个文件（写入只碰本文件）、条数上限由清理策略
 * 决定、历史可脱离任务定义独立保留。
 *
 * 文件名即记录时间（UTC ISO，冒号替换为 `-` 以适配 Windows 文件名），字典序即时序——列表无需读内容
 * 排序，清理按名删最旧。记录内容为完整 `TaskRunRecord`（含 id/状态/耗时/输出/执行会话）。
 */
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { TaskRunRecord } from "@gebai/sdk"

/** 每任务保留的执行记录条数上限（超出按时间删除最旧）。 */
export const TASK_RUNS_KEEP = 200

/** 单个执行记录文件的大小上限（读取时防御：损坏或异常膨胀的文件不整个进内存）。 */
export const TASK_RUN_FILE_MAX_BYTES = 1024 * 1024

/** 执行记录目录（三级结构的根 + 任务 id，记录文件置于其下）。 */
export function taskRunsDir(home: string, user: string, taskId: string): string {
  return join(home, "users", user, "task-runs", taskId)
}

/** 记录文件名（记录时间为名）：UTC ISO，`:` → `-`（Windows 文件名非法字符）。
 *  同毫秒多条（定时到期 skipped 与上一次收尾可能同毫秒）追加 `_N`——`_` 的字典序大于 `.`，
 *  带序号的名字排在无序号之后（同毫秒内后写者视为更新，清理时先删先写的那条）。 */
export function runFileName(at: number, seq = 0): string {
  const iso = new Date(Number.isFinite(at) ? at : Date.now()).toISOString().replace(/:/g, "-")
  return seq > 0 ? `${iso}_${seq + 1}.json` : `${iso}.json`
}

let tmpSeq = 0

/** 写内容到已占位的记录文件（临时文件 + rename 原子替换：读方要么看到占位空文件（解析失败跳过）
 *  要么看到完整内容，不会读到半截 JSON）。 */
async function writeRunBody(seq: number, file: string, body: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${seq}.tmp`
  try {
    await writeFile(tmp, body, "utf8")
    await rename(tmp, file)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** 写单条执行记录（原子写：临时文件 + rename 覆盖自身占位；同名冲突自动加序号，不覆盖既有记录）。 */
export async function writeTaskRun(home: string, user: string, taskId: string, rec: TaskRunRecord): Promise<string> {
  const dir = taskRunsDir(home, user, taskId)
  await mkdir(dir, { recursive: true })
  const body = JSON.stringify(rec, null, 2)
  // 同毫秒两条记录（如定时到期 skipped 与上一次收尾）不能互相覆盖：以 O_EXCL 独占**占位**确认文件名
  // 归属（rename 是覆盖语义，单靠 rename 判不出冲突），占位成功即锁定该名，随后 tmp + rename 原子落内容
  for (let seq = 0; seq < 1000; seq++) {
    const name = runFileName(rec.at, seq)
    const file = join(dir, name)
    let handle
    try {
      handle = await open(file, "wx")
    } catch (err) {
      // 目标名已被占用（同毫秒已有一条）：换序号；其余错误上抛
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") continue
      throw err
    }
    await handle.close()
    await writeRunBody(tmpSeq++, file, body)
    return name
  }
  throw new Error(`执行记录文件名冲突过多（任务 ${taskId}，时间 ${new Date(rec.at).toISOString()}）`)
}

/** 执行记录文件名清单（升序=旧→新；字典序即时序，不读文件内容）。 */
async function runFileNames(home: string, user: string, taskId: string): Promise<string[]> {
  const dir = taskRunsDir(home, user, taskId)
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => n.endsWith(".json")).sort()
}

/** 读取执行记录（新→旧，最多 limit 条；损坏文件跳过不影响其余记录）。 */
export async function listTaskRuns(home: string, user: string, taskId: string, limit = TASK_RUNS_KEEP): Promise<TaskRunRecord[]> {
  const dir = taskRunsDir(home, user, taskId)
  const names = (await runFileNames(home, user, taskId)).reverse().slice(0, Math.max(0, limit))
  const out: TaskRunRecord[] = []
  for (const name of names) {
    try {
      const text = await readFile(join(dir, name), "utf8")
      if (text.length > TASK_RUN_FILE_MAX_BYTES) continue
      const rec = JSON.parse(text) as TaskRunRecord
      if (rec && typeof rec === "object" && typeof rec.at === "number") out.push(rec)
    } catch {
      /* 单条损坏不影响其余记录 */
    }
  }
  return out
}

/** 清理超出保留上限的最旧记录（返回删除条数）。 */
export async function trimTaskRuns(home: string, user: string, taskId: string, keep = TASK_RUNS_KEEP): Promise<number> {
  const names = await runFileNames(home, user, taskId)
  const excess = names.length - Math.max(0, keep)
  if (excess <= 0) return 0
  const dir = taskRunsDir(home, user, taskId)
  let removed = 0
  for (const name of names.slice(0, excess)) {
    try {
      await unlink(join(dir, name))
      removed++
    } catch {
      /* 已被并发清理：忽略 */
    }
  }
  return removed
}

/** 旧内联记录（`Task.runs`）一次性导入（逐条落文件；时间同毫秒的多条自动加序号）。
 *  幂等：目标目录已有记录则跳过——迁移只针对「从未有过执行记录目录」的旧数据，
 *  即使定义文件重写失败（下次启动会再走一遍）也不会产生重复记录。 */
export async function importTaskRuns(home: string, user: string, taskId: string, runs: TaskRunRecord[]): Promise<number> {
  if ((await runFileNames(home, user, taskId)).length > 0) return 0
  let written = 0
  // 旧记录为「新→旧」，按时间升序写（文件名唯一性与阅读顺序都更自然）
  for (const rec of [...runs].sort((a, b) => a.at - b.at)) {
    if (!rec || typeof rec !== "object" || typeof rec.at !== "number") continue
    await writeTaskRun(home, user, taskId, rec)
    written++
  }
  if (written) await trimTaskRuns(home, user, taskId)
  return written
}
