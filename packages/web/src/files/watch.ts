/**
 * 工作台变更监听客户端：**长轮询 + 后端 fs.watch**（见服务端 `core/fs/watch.ts`）。
 *
 * 形态：循环发 `/api/v1/fs/watch`，把「当前展开的目录」带上去；后端给这些目录挂 fs.watch，
 * 有变化立刻把在途请求唤醒（等价于推送），没变化就挂到 `waitSeconds` 再回一个心跳。于是：
 * - 变化延迟 ≈ 事件延迟（毫秒级），而不是轮询周期；
 * - 空闲时一轮请求里服务端什么都不做（不列举、不 spawn git）——这正是「不要占用太多后端性能」的落点；
 * - 前端这一侧是**轮询**（自控节奏、断线可退避），后端那一侧是**事件**（推送）。
 *
 * 兜底：连续失败（接口 404/500、代理截断长连接、服务端重启）达到阈值后退化为纯轮询——
 * 每 `fallbackMs` 主动拉一次「全刷」回调，页面仍能自己变，只是慢一点。
 * 目录集变化（用户展开/收起）时 `poke()` 会立刻断开重连，把新目录带上，不必等这一轮超时。
 */
import type { FsApi } from "./api"
import { backoffMs, normalizeWatchDirs, WATCH_DIR_CAP } from "./watch-core"

export interface FsWatchHooks {
  api: FsApi
  /** 当前根（切根即重连）。 */
  root: () => string
  /** 需要监听的根内目录：展开目录 + 根 + 打开文件的父目录（`[]` = 只监听 git 元数据）。 */
  dirs: () => string[]
  /** git 元数据（index / HEAD / refs）发生变化：提交、切分支、外部 git 操作。 */
  onGitChange: () => void
  /** 工作区发生变化：`paths` 为根内相对路径；null / 空数组 = 未知（太多或别的客户端已消费）→ 可见部分全刷。 */
  onFsChange: (paths: string[] | null) => void
  /** 是否一并监听 git 元数据（根不是仓库时可返回 false，省两次 watcher）。 */
  git?: () => boolean
  /** 无变化时的挂起秒数（默认 20；服务端上限 30）。 */
  waitSeconds?: number
  /** 连续失败后的兜底轮询间隔（默认 20s，与长轮询挂起时长同一节奏）。 */
  fallbackMs?: number
}

export interface FsWatcher {
  /** 开始（后台标签页不启动，等切到前台再起）。 */
  start: () => void
  /** 停止并断开在途请求。 */
  stop: () => void
  /** 目录集变了 / 需要立刻重新同步（断开在途长轮询，立即发新一轮）。 */
  poke: () => void
  /** 是否正在运行。 */
  readonly running: boolean
}

const DEFAULT_WAIT = 20
const DEFAULT_FALLBACK = 20_000
/** 连续失败到这个次数就转兜底轮询（接口不可用时不必一直贴身重试）。 */
const DEGRADE_AFTER = 3

export function createFsWatcher(hooks: FsWatchHooks): FsWatcher {
  const wait = Math.min(Math.max(hooks.waitSeconds ?? DEFAULT_WAIT, 0), 30)
  const fallbackMs = Math.max(2_000, hooks.fallbackMs ?? DEFAULT_FALLBACK)
  let started = false
  let running = false
  let controller: AbortController | null = null
  /** 在途请求超时定时器（服务端卡住时自己断开，避免整个循环僵死）。 */
  let timeoutTimer: number | null = null
  /** poke 触发的主动断开：循环据此立刻重试而不是走失败退避。 */
  let restart = false
  let rev: number | null = null
  let failures = 0

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })

  function abortInFlight(): void {
    if (timeoutTimer !== null) {
      window.clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    controller?.abort()
    controller = null
  }

  async function loop(): Promise<void> {
    while (running) {
      const dirs = normalizeWatchDirs(hooks.dirs(), WATCH_DIR_CAP)
      controller = new AbortController()
      const current = controller
      timeoutTimer = window.setTimeout(() => current.abort(), (wait + 8) * 1000)
      try {
        const res = await hooks.api.fsWatch(hooks.root(), dirs, {
          rev: rev ?? undefined,
          wait,
          git: hooks.git ? hooks.git() : true,
          signal: current.signal,
        })
        if (timeoutTimer !== null) {
          window.clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
        controller = null
        failures = 0
        if (!running) return
        // 服务端关掉了监听（GEBAI_FS_WATCH=false）：退化为纯轮询，每轮主动刷一次
        if (res.enabled === false) {
          rev = null
          await sleep(fallbackMs)
          if (!running) return
          hooks.onGitChange()
          hooks.onFsChange(null)
          continue
        }
        const known = rev !== null
        const changed = res.changed || (known && res.rev !== rev)
        rev = res.rev
        if (changed) {
          if (res.git) hooks.onGitChange()
          hooks.onFsChange(res.paths && res.paths.length ? res.paths : null)
        }
      } catch (err) {
        if (timeoutTimer !== null) {
          window.clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
        controller = null
        if (!running) return
        if (restart) {
          // poke（目录集变了）主动断开：立刻重连，不计失败
          restart = false
          continue
        }
        failures += 1
        await sleep(failures >= DEGRADE_AFTER ? fallbackMs : backoffMs(failures))
        if (!running) return
        // 退化路径：接口用不了（或长连接被中间层掐断）时，主动做一次「可见部分全刷」
        if (failures >= DEGRADE_AFTER) {
          hooks.onGitChange()
          hooks.onFsChange(null)
        }
      }
    }
  }

  function onVisibility(): void {
    if (document.hidden) {
      // 后台标签页：断开在途请求（服务端那一侧 watcher 由宽限期回收），切回前台再续
      if (running) {
        running = false
        abortInFlight()
      }
      return
    }
    if (started && !running) start()
  }

  function start(): void {
    started = true
    if (running || document.hidden) return
    running = true
    failures = 0
    void loop()
  }

  function stop(): void {
    running = false
    abortInFlight()
  }

  document.addEventListener("visibilitychange", onVisibility)

  return {
    start,
    stop,
    poke(): void {
      if (!running) return
      // 没有在途请求（正在退避/等待重试）：下一轮自然会带上新目录，不必打断
      if (!controller) return
      restart = true
      abortInFlight()
    },
    get running(): boolean {
      return running
    },
  }
}
