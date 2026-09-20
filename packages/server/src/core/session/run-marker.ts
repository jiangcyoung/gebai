/** 在途任务标记（服务中断的留痕）：任务运行期间在会话目录写 run.json，正常收尾（成功/失败/取消）删除。
 *  残留标记即「上一进程死在任务中途」——启动时据此对中断的会话补一条可见说明（见 boot/compose），
 *  否则这类会话只剩「用户问了、助手一个字都没有」，用户无从知道发生了什么，也无法判断要不要重发。
 *
 *  标记刻意与会话数据（chat.json/env.json 等）分离：它是进程级运行态、不是会话内容，进程死亡即失效，
 *  不参与上下文与列表统计。 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** 标记文件名（会话目录内，与 chat.json 并列）。 */
export const RUN_MARKER_FILE = "run.json"

/** 标记内容（写入时机：本轮用户消息已落盘之后）。 */
export interface RunMarker {
  sessionId: string
  /** 归属用户（补记说明时定位会话目录）。 */
  user: string
  startedAt: number
  /** 本轮用户输入摘要（中断说明里回显，便于识别中断的是哪一次任务）。 */
  prompt: string
  /** 写标记的进程 pid：同一 GEBAI_HOME 下可能有多个实例（桌面 + 服务端/多个端口），
   *  只有「写标记的进程已不在」才算中断——否则新实例启动会把另一活实例正在跑的任务误报为中断。 */
  pid?: number
}

export function writeRunMarker(sessionDir: string, marker: RunMarker): void {
  try {
    writeFileSync(join(sessionDir, RUN_MARKER_FILE), JSON.stringify(marker), "utf8")
  } catch {
    /* 写失败静默：标记只是中断留痕，不参与任务执行 */
  }
}

export function clearRunMarker(sessionDir: string): void {
  try {
    rmSync(join(sessionDir, RUN_MARKER_FILE), { force: true })
  } catch {
    /* 已删除/无权限：忽略 */
  }
}

/** 服务中断的任务终止说明（启动期补写到会话记录；与其余引擎注入同为 user 角色 + engineNote 标记，
 *  UI 渲染为弱化通知条，模型下一轮也看得见「上一轮被打断了」）。 */
export function interruptedRunNote(marker: RunMarker): string {
  const at = new Date(marker.startedAt).toLocaleString("zh-CN")
  const head = marker.prompt.trim().replace(/\s+/g, " ")
  const brief = head ? `「${head.length > 60 ? `${head.slice(0, 60)}…` : head}」` : ""
  return `⚠️ 上一轮任务因服务进程中断而终止（开始于 ${at}）${brief}，未产出结果。你可以重新发送，或让我接着上次的进度继续。`
}

/** 扫描全部用户的残留标记（**启动期调用一次**）：返回仍需补记的会话目录与标记。
 *  仍属活进程的标记（pid 存活）不返回——同一 GEBAI_HOME 多实例并存时，另一个实例正在跑的任务不是中断。 */
export function scanRunMarkers(home: string): Array<{ dir: string; marker: RunMarker }> {
  const out: Array<{ dir: string; marker: RunMarker }> = []
  const usersDir = join(home, "users")
  for (const user of safeDirs(usersDir)) {
    const sessionsDir = join(usersDir, user, "sessions")
    for (const sid of safeDirs(sessionsDir)) {
      const dir = join(sessionsDir, sid)
      const file = join(dir, RUN_MARKER_FILE)
      if (!existsSync(file)) continue
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as RunMarker
        if (typeof raw?.startedAt === "number" && typeof raw?.prompt === "string") {
          if (typeof raw.pid === "number" && isProcessAlive(raw.pid)) continue // 另一实例仍在跑：不是中断
          out.push({ dir, marker: { ...raw, sessionId: raw.sessionId || sid, user: raw.user || user } })
          continue
        }
      } catch {
        /* 损坏标记按无效处理 */
      }
      // 无效标记直接清掉：否则每次启动重复处理同一条
      clearRunMarker(dir)
    }
  }
  return out
}

/** 进程存活判定（信号 0 = 只探测不发送）：EPERM 表示进程存在但无权限操作，同样算存活。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 目录下的子目录名（不存在/不可读返回空）。 */
function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * 启动期补偿：把残留在途标记对应的会话补一条可见说明（写会话记录的能力由调用方以 append 提供），
 * 并清标记防重复补记。补记失败（会话已删等）同样清标记（否则每次启动重复处理），只计数不外抛。
 */
export async function reportInterruptedRuns(
  home: string,
  append: (sessionId: string, user: string, content: string) => Promise<void>,
): Promise<{ reported: number; failed: number }> {
  let reported = 0
  let failed = 0
  for (const { dir, marker } of scanRunMarkers(home)) {
    try {
      await append(marker.sessionId, marker.user, interruptedRunNote(marker))
      reported++
    } catch {
      failed++
    }
    clearRunMarker(dir)
  }
  return { reported, failed }
}
