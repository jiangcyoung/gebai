/**
 * 底部跟随的意图识别（纯逻辑核；sticky-follow.ts 负责 DOM 绑定）：
 *
 * 从「单信号 + 几何取证」升级为**位移意图判定**——只看用户真实造成的位移量，不看事件来源：
 * - 滚轮向上、触摸上滑、键盘、中键自动滚动、查找定位……一律经 scroll 事件的位移体现，
 *   故无需按事件类型列举（也就不存在「某个来源没覆盖到」的漏判）。
 * - 位置没动就没有位移（橡皮筋回弹、惯性过冲、已在边界）：不累计、不解除。
 *
 * 三态：
 * - `follow`  追最新：视口钉底，内容增长继续跟随。
 * - `hold`    停在此处（距底 ≤ threshold + 1.5 屏）：就地观看，内容增长不推视口。
 * - `reading` 阅读历史（更远）：同上，语义上明确在读历史。
 *
 * 判定规则：
 * 1. **解除跟随**（follow → hold/reading）需位置确实离开底部，且满足二者之一：
 *    - 手势内累计向上位移 ≥ `upIntentPx`（明确上翻）；
 *    - 位置持续离开底部超过 `confirmMs`（其余输入来源：中键自动滚动、查找定位；回弹与惯性
 *      的短暂越界因很快回底而被豁免）。
 *    微调（位移不足、位置仍在阈值内）不解除。
 * 2. **恢复跟随**（hold/reading → follow）需用户在底部**向下滚动**（手势内有向下位移）——
 *    单纯「位置落在阈值内」（内容收缩、程序落位）不恢复，避免把视口从阅读位置拽回底部。
 * 3. 程序滚动 / 内容变化的迟到事件（静默窗口内）不参与判定，只更新基准位置。
 */

export type FollowState = "follow" | "hold" | "reading"

export interface ScrollIntentOptions {
  /** 距底部阈值（<= 该值视为在底部）。 */
  threshold?: number
  /** 手势聚合间隔：两次位移间隔超过该值视为新手势（累计重置）。 */
  gestureGapMs?: number
  /** 离开底部的确认时长：用户滚开后停手时无后续事件，靠定时器到点复查才解除；
   *  瞬时越界（回弹/惯性过冲）在这期间回底就不算数。 */
  confirmMs?: number
  /** `hold` 的最大距底（视口高度倍数）：超过则为 `reading`。 */
  holdScreens?: number
  /** 时钟注入（测试）。 */
  now?: () => number
  /** 定时器注入（测试：假定时器手动推进）。 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** 一次 scroll 观测的上下文。 */
export interface ScrollObservation {
  /** 程序滚动 / 内容变化后的静默窗口内（迟到事件）：只更新基准，不参与判定。 */
  quiet: boolean
  /** 是否允许「向下滚到底」恢复跟随（滚动条拖动中禁止——拖到阈值区内不应被拽到最底）。 */
  allowResume: boolean
}

export interface ScrollIntentHandle {
  state(): FollowState
  /** 是否处于追最新（窗口化据此判定 DOM 变更后是否保持贴底）。 */
  isFollowing(): boolean
  /** 观测一次滚动位置（每次 scroll 事件调用）。 */
  observe(scrollTop: number, scrollHeight: number, viewport: number, obs: ScrollObservation): FollowState
  /** 显式锁定跟随（发送消息 / 会话加载 / 点击回到最新）。 */
  follow(): void
  /** 显式解除（导航跳转：用户要去看那条消息）。 */
  stop(): FollowState
  /** 程序落位后按几何同步（会话切回的历史位置记忆）。 */
  sync(scrollTop: number, scrollHeight: number, viewport: number): FollowState
  /** 仅重设基准位置（程序落底/内容修正后调用）：不产生位移，也不改状态。 */
  rebase(scrollTop: number): void
  /** 本手势内是否有向下位移（用户往最新方向滚）。 */
  movingDown(): boolean
  /** 本手势内是否有向上位移（用户往历史方向滚）。 */
  hasUpIntent(): boolean
}

export function createScrollIntent(opts: ScrollIntentOptions = {}): ScrollIntentHandle {
  const threshold = opts.threshold ?? 64
  const gestureGapMs = opts.gestureGapMs ?? 180
  const confirmMs = opts.confirmMs ?? 60
  const holdScreens = opts.holdScreens ?? 1.5
  const now = opts.now ?? (() => performance.now())
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let state: FollowState = "follow"
  let lastTop = 0
  let upAccum = 0
  let downAccum = 0
  let lastMoveAt = 0
  /** 待确认的「离开底部」（确认定时器句柄 + 到点时复查用的几何）。 */
  let exitTimer: unknown = null
  let pending = { distance: 0, viewport: 0 }

  /** 按距底距离归属非跟随状态：近处 = 停在此处，远处 = 阅读历史。 */
  const reach = (distance: number, viewport: number): FollowState => (distance > threshold + viewport * holdScreens ? "reading" : "hold")

  const resetGesture = () => {
    upAccum = 0
    downAccum = 0
  }

  function cancelExit() {
    if (exitTimer !== null) {
      clearTimer(exitTimer)
      exitTimer = null
    }
  }

  /** 安排「离开底部」的确认：用户滚开后停手时没有后续事件，靠定时器到点复查才解除。 */
  function scheduleExit(distance: number, viewport: number) {
    pending = { distance, viewport }
    if (exitTimer !== null) return
    exitTimer = setTimer(() => {
      exitTimer = null
      if (pending.distance > threshold) state = reach(pending.distance, pending.viewport)
    }, confirmMs)
  }

  return {
    state: () => state,
    isFollowing: () => state === "follow",
    observe(scrollTop, scrollHeight, viewport, obs) {
      const t = now()
      // 基准从 0 起算：用户一次滚轮到位的位移可能只产生一个 scroll 事件，首次观测不能白白丢了；
      // 程序落位（页面加载落底、会话恢复）由调用方先打静默时间戳，其事件不参与判定
      const delta = scrollTop - lastTop
      const distance = scrollHeight - scrollTop - viewport
      lastTop = scrollTop
      if (obs.quiet) return state // 程序滚动/内容变化的迟到事件：只更新基准
      if (t - lastMoveAt > gestureGapMs) resetGesture()
      // 方向翻转即重置反向累计（手势内的净方向）：否则上翻后残留的向下位移会在位置自然
      // 落入阈值时被当成「用户向下滚到底」而误恢复跟随
      if (delta < 0) {
        upAccum -= delta
        downAccum = 0
      } else if (delta > 0) {
        downAccum += delta
        upAccum = 0
      }
      if (delta !== 0) lastMoveAt = t

      if (distance <= threshold) {
        cancelExit()
        // 向下滚到底（用户动作）才恢复跟随；位置自然落进阈值（内容收缩等）不恢复
        if (state !== "follow" && obs.allowResume && downAccum > 0) state = "follow"
        return state
      }
      if (state !== "follow") {
        cancelExit()
        state = reach(distance, viewport)
        return state
      }
      // 追最新中：位置离开底部且本手势确有向上位移（用户滚开）→ 确认后解除；
      // 无向上位移（内容变化/程序落位的过期位置）或瞬时越界（回弹）不算数
      if (upAccum > 0) scheduleExit(distance, viewport)
      else cancelExit()
      return state
    },
    follow() {
      state = "follow"
      resetGesture()
      cancelExit()
    },
    stop() {
      resetGesture()
      cancelExit()
      state = "reading"
      return state
    },
    sync(scrollTop, scrollHeight, viewport) {
      const distance = scrollHeight - scrollTop - viewport
      resetGesture()
      cancelExit()
      lastTop = scrollTop
      state = distance <= threshold ? "follow" : reach(distance, viewport)
      return state
    },
    rebase(scrollTop) {
      resetGesture()
      cancelExit()
      lastTop = scrollTop
    },
    movingDown: () => downAccum > 0,
    hasUpIntent: () => upAccum > 0,
  }
}
