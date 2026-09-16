/**
 * 文件工作台 · 变更监听中枢（`/api/v1/fs/watch` 的后端）。
 *
 * 为什么要有它：工作台的目录树、变更面板、Git 装饰都该「自己变」——用户在终端里跑 git、Agent 在
 * 另一个会话里改文件、别的编辑器保存，页面此前只能靠手动 F5。纯前端轮询「变没变」在大仓上很贵
 * （全量列举目录 + `git status` 进程），而「有没有变」这件事操作系统本来就有事件。于是这里的形态是
 * **前端长轮询 + 后端 fs.watch**：前端把「当前展开的目录」带上来，服务端只给这些目录挂 watch，
 * 有变化立刻把在途的长轮询唤醒（对前端等价于推送），没变化就挂到超时再返回（一次心跳）。
 *
 * 成本控制（本模块存在的主要理由，每条都有对应实现）：
 * - **只监听请求点名的目录**，不做递归全仓监听（大仓的 inotify watch 数量会直接顶到上限）；
 * - **同名目录在多个连接/多轮请求之间共享同一个 watcher**（引用计数 + 宽限期），不重复 syscall；
 * - **事件合并**（debounce）：一次保存 / 一次 git 操作往往触发一串事件，合并成一拍通知；
 * - **挂不上的目录记失败并退避**（ENOSPC/EMFILE/目录被删不该每轮都重试一遍）；
 * - **无变化时零工作**：长轮询挂在 Promise 上，不占 CPU、不 spawn 任何进程；
 * - 变更路径只保留最近 `recentTtlMs`（多个客户端共享同一份「最近变化」，互不吞事件）。
 */
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs"
import { join, resolve } from "node:path"

export interface FsWatchHubOptions {
  /** 事件合并窗口（毫秒）。 */
  debounceMs?: number
  /** 无订阅者后 watcher 的保留时长（毫秒）：前端长轮询循环之间不留缝，避免 watcher 反复建/拆。 */
  graceMs?: number
  /** 单次订阅最多监听多少个目录（上限兜底，前端已先夹一次）。 */
  maxDirs?: number
  /** 通知里最多带多少条变更路径；超过则给 null（前端据此做一次「可见部分全刷」）。 */
  maxPaths?: number
  /** 变更路径的保留时长（毫秒）。 */
  recentTtlMs?: number
  /** 挂不上的目录的重试间隔（毫秒）。 */
  retryFailedMs?: number
}

/** 订阅项：目录绝对路径 + 它是否 git 元数据目录（`.git` 一类，事件带 git 标记）。
 *  `recursive` 只给**小树**用（`.git/refs`：分支/远程引用各是一层子目录里的文件）；工作区目录一律非递归。 */
export interface WatchTarget {
  path: string
  git?: boolean
  recursive?: boolean
}

/** 一次读取的结果：单调修订号 + 最近的变更路径（null = 太多/未知，前端按全量刷新处理）+ 是否涉及 git。 */
export interface WatchSnapshot {
  rev: number
  paths: string[] | null
  git: boolean
}

const DEFAULTS: Required<FsWatchHubOptions> = {
  debounceMs: 120,
  graceMs: 45_000,
  maxDirs: 128,
  maxPaths: 200,
  recentTtlMs: 15_000,
  retryFailedMs: 30_000,
}

interface Entry {
  watcher: FSWatcher | null
  recursive: boolean
  /** 当前订阅者数（一个在途的长轮询 = 1）。 */
  users: number
  lastUsed: number
  git: boolean
  /** debounce 窗口内累积的变更路径（绝对路径）。 */
  pending: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** 挂不上时的下次重试时间（0 = 可尝试）。 */
  retryAt: number
}

interface Waiter {
  resolve: () => void
  timer: ReturnType<typeof setTimeout> | null
}

export class FsWatchHub {
  private readonly opts: Required<FsWatchHubOptions>
  private entries = new Map<string, Entry>()
  /** 最近变化的绝对路径 → 时间戳（TTL 内保留，多客户端共享）。 */
  private recent = new Map<string, number>()
  /** 最近一次 git 元数据变化的时间戳（0 = 没有）。 */
  private recentGit = 0
  private rev = 0
  private waiters = new Set<Waiter>()
  /** 宽限期后回收无订阅者 watcher 的定时器（见 scheduleSweep）。 */
  private sweepTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: FsWatchHubOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  /** 单调修订号：任何被监听目录发生变化即自增（前端据此判断「有没有变」）。 */
  get revision(): number {
    return this.rev
  }

  /** 当前监听中的目录数（诊断/测试用）。 */
  get watching(): number {
    return this.entries.size
  }

  /**
   * 订阅一组目录；返回释放函数（幂等）。
   * 重复订阅同一路径只增引用计数——多个工作台标签页/同一页的多轮长轮询共用同一个 watcher。
   */
  subscribe(targets: WatchTarget[]): () => void {
    const now = Date.now()
    const taken = new Map<string, Entry>()
    for (const t of targets.slice(0, this.opts.maxDirs)) {
      if (!t.path || taken.has(t.path)) continue
      const entry = this.ensure(t, now)
      if (!entry) continue
      entry.users += 1
      entry.lastUsed = now
      taken.set(t.path, entry)
    }
    this.sweep(now)
    let released = false
    return () => {
      if (released) return
      released = true
      const ts = Date.now()
      for (const [path, entry] of taken) {
        if (this.entries.get(path) !== entry) continue
        entry.users = Math.max(0, entry.users - 1)
        entry.lastUsed = ts
        // 最后一个订阅者走了：定一个宽限期后的回收时刻。
        // 不这么做的话 watcher 会一直挂着——下次有了事件才会触发惰性回收，而「没人订阅」时本来就不会有事件
        // （关掉标签页就是这种情形：fd 与 inotify watch 白占着，直到进程重启）。
        if (entry.users === 0) this.scheduleSweep(this.opts.graceMs + 50)
      }
    }
  }

  /** 读取当前快照（`paths` 是 TTL 内的变更路径；过多则 null）。 */
  snapshot(): WatchSnapshot {
    const now = Date.now()
    this.pruneRecent(now)
    const paths = this.recent.size > this.opts.maxPaths ? null : [...this.recent.keys()]
    return { rev: this.rev, paths, git: now - this.recentGit < this.opts.recentTtlMs }
  }

  /**
   * 等到 `sinceRev` 之后有新的变化，或超时返回。
   * 已经有更新（rev > sinceRev）时立即返回——调用方不必先比一次。
   */
  async wait(sinceRev: number, timeoutMs: number): Promise<WatchSnapshot> {
    if (this.rev > sinceRev || timeoutMs <= 0) return this.snapshot()
    await new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve()
      }, timeoutMs)
      // 定时器不该拖住进程退出（服务被 stop 时立刻可退）
      ;(waiter.timer as unknown as { unref?: () => void }).unref?.()
      this.waiters.add(waiter)
    })
    return this.snapshot()
  }

  /** 关闭全部 watcher（服务停止/测试收尾用）。 */
  dispose(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer)
    this.sweepTimer = null
    for (const [path] of this.entries) this.close(path)
    this.entries.clear()
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve()
    }
    this.waiters.clear()
    this.recent.clear()
    this.recentGit = 0
  }

  /* ------------------------------ 内部 ------------------------------ */

  private ensure(target: WatchTarget, now: number): Entry | null {
    const path = target.path
    const existing = this.entries.get(path)
    if (existing) {
      if (target.git) existing.git = true
      if (!existing.watcher && existing.retryAt && existing.retryAt <= now) {
        existing.retryAt = 0
        this.attach(path, existing)
      }
      return existing
    }
    const entry: Entry = { watcher: null, recursive: target.recursive === true, users: 0, lastUsed: now, git: target.git === true, pending: new Set(), timer: null, retryAt: 0 }
    this.entries.set(path, entry)
    this.attach(path, entry)
    return entry
  }

  /** 挂 watcher；失败（目录不存在 / inotify 上限 / 权限）只记退避，不影响请求本身。 */
  private attach(path: string, entry: Entry): void {
    try {
      const watcher = watch(path, { persistent: true, recursive: entry.recursive }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : filename ? String(filename) : ""
        this.onEvent(path, name)
      })
      watcher.on?.("error", () => {
        // watch 中途失效（目录被删/被移走）：关掉并交给退避重试，事件本身不再有价值
        try {
          watcher.close()
        } catch {
          /* 已关闭 */
        }
        entry.watcher = null
        entry.retryAt = Date.now() + this.opts.retryFailedMs
      })
      entry.watcher = watcher
      entry.retryAt = 0
    } catch {
      entry.watcher = null
      entry.retryAt = Date.now() + this.opts.retryFailedMs
    }
  }

  private onEvent(dir: string, name: string): void {
    const entry = this.entries.get(dir)
    if (!entry) return
    // 事件不带文件名时（少数平台/场景）退化成「目录本身变了」，仍是一次有效通知
    entry.pending.add(name ? join(dir, name) : dir)
    if (entry.timer) return
    entry.timer = setTimeout(() => this.flush(dir), this.opts.debounceMs)
    ;(entry.timer as unknown as { unref?: () => void }).unref?.()
  }

  /** debounce 窗口结束：把这一拍的变更并入「最近变化」并唤醒等待者。 */
  private flush(dir: string): void {
    const entry = this.entries.get(dir)
    if (!entry) return
    entry.timer = null
    if (!entry.pending.size) return
    const now = Date.now()
    for (const p of entry.pending) this.recent.set(p, now)
    entry.pending.clear()
    if (entry.git) this.recentGit = now
    this.rev += 1
    this.pruneRecent(now)
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve()
    }
    this.waiters.clear()
    this.sweep(now)
  }

  private pruneRecent(now: number): void {
    for (const [p, ts] of this.recent) {
      if (now - ts > this.opts.recentTtlMs) this.recent.delete(p)
    }
    if (now - this.recentGit > this.opts.recentTtlMs) this.recentGit = 0
  }

  /** 回收无订阅者且超出宽限期的 watcher（两处触发：每次 subscribe/flush 顺手扫一遍，或 release 排的定时器——见 scheduleSweep）。 */
  private sweep(now: number): void {
    this.sweepTimer = null
    for (const [path, entry] of this.entries) {
      if (entry.users > 0) continue
      if (now - entry.lastUsed < this.opts.graceMs) continue
      this.close(path)
    }
  }

  /** 定一次未来某个时刻的回收（已有定时器就不重复排；`unref` 不拖住进程退出）。 */
  private scheduleSweep(delayMs: number): void {
    if (this.sweepTimer) return
    this.sweepTimer = setTimeout(() => this.sweep(Date.now()), delayMs)
    ;(this.sweepTimer as unknown as { unref?: () => void }).unref?.()
  }

  private close(path: string): void {
    const entry = this.entries.get(path)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      try {
        entry.watcher?.close()
      } catch {
        /* 已关闭 */
      }
    }
    this.entries.delete(path)
  }
}

/**
 * git 元数据监听项：`.git` 本体（index / HEAD / ORIG_HEAD / MERGE_HEAD / packed-refs 等）+ `refs` 子树递归。
 *
 * 为什么值得单独挂：仓库外部的 git 动作（内置终端里 `git commit`、别的工具切分支）不改工作区文件，
 * 只有这两处会变——工作区目录的 watch 完全看不到「历史变了但文件没变」。
 * `.git` 也可能是**文件**（worktree / 子模块：内容形如 `gitdir: /path/to/real`），此时按它指到真目录。
 */
export function gitWatchDirs(repoRoot: string): WatchTarget[] {
  const dot = join(repoRoot, ".git")
  let gitDir: string | null = null
  try {
    const st = statSync(dot)
    if (st.isDirectory()) gitDir = dot
    else if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/im.exec(readFileSync(dot, "utf8"))
      if (m) gitDir = resolve(repoRoot, m[1]!.trim())
    }
  } catch {
    gitDir = null
  }
  if (!gitDir || !existsSync(gitDir)) return []
  const out: WatchTarget[] = [{ path: gitDir, git: true }]
  const refs = join(gitDir, "refs")
  if (existsSync(refs)) out.push({ path: refs, git: true, recursive: true })
  return out
}
