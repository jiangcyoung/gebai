import { describe, expect, test } from "bun:test"
import { createScrollIntent, type ScrollObservation } from "./scroll-intent"

/** 可控时钟 + 假定时器 + 观测辅助。 */
function setup(opts: { viewport?: number; height?: number; confirmMs?: number } = {}) {
  let t = 1000
  const timers = new Map<number, () => void>()
  let timerSeq = 0
  const intent = createScrollIntent({
    now: () => t,
    confirmMs: opts.confirmMs,
    setTimer: (fn) => {
      const id = ++timerSeq
      timers.set(id, fn)
      return id
    },
    clearTimer: (h) => {
      timers.delete(h as number)
    },
  })
  const viewport = opts.viewport ?? 800
  let height = opts.height ?? 10000
  const obs = (extra: Partial<ScrollObservation> = {}): ScrollObservation => ({ quiet: false, allowResume: true, ...extra })
  /** 模拟一次滚动到指定位置（一次位移即一次用户的滚动动作）。 */
  const to = (top: number, extra: Partial<ScrollObservation> = {}) => intent.observe(top, height, viewport, obs(extra))
  /** 模拟内容收缩/增长（高度变化，位置由调用方给出）。 */
  const shrinkTo = (next: number, top: number) => {
    height = next
    return intent.observe(top, height, viewport, obs())
  }
  const advance = (ms: number) => {
    t += ms
  }
  /** 确认时长到达（触发待确认的「离开底部」）。 */
  const fireTimers = () => {
    const fns = [...timers.values()]
    timers.clear()
    for (const fn of fns) fn()
  }
  return { intent, to, advance, viewport, obs, shrinkTo, fireTimers, pendingTimers: () => timers.size }
}

describe("意图识别：阈值内微调不解除", () => {
  test("底部微上滚（位置仍在阈值内）保持跟随", () => {
    const s = setup()
    s.to(9200) // 距底 0
    expect(s.intent.state()).toBe("follow")
    s.to(9160) // 上滚 40px：距底 40 < 64，仍在底部
    expect(s.intent.state()).toBe("follow")
    s.to(9140) // 再上滚 20px：距底 60，仍在底部
    expect(s.intent.state()).toBe("follow")
  })

  test("滚开后停手（无后续事件）：确认时长到达才解除", () => {
    const s = setup()
    s.to(9200)
    s.to(8900) // 上翻 300px：距底 300
    expect(s.intent.state()).toBe("follow") // 确认期未到（用户可能只是甩一下）
    s.fireTimers() // 确认时长到达：位置仍离开底部
    expect(s.intent.state()).toBe("hold")
  })

  test("瞬时越界后回底（回弹/惯性过冲）：不解除", () => {
    const s = setup()
    s.to(9200)
    s.to(9130) // 被带到距底 70（越界）
    s.to(9200) // 很快回底
    s.fireTimers() // 确认到点时已回底 → 不算数
    expect(s.intent.state()).toBe("follow")
  })

  test("橡皮筋回弹（位置未变）：不累计、不解除", () => {
    const s = setup()
    s.to(9200)
    s.to(9200) // 位置不变
    expect(s.pendingTimers()).toBe(0)
    expect(s.intent.state()).toBe("follow")
  })

  test("位置离开底部但本次手势无向上位移（内容变化把位置带离）：不解除", () => {
    const s = setup()
    s.to(9200)
    s.to(7200, { quiet: true }) // 程序/内容变化引起的位移：归因内部动作
    s.fireTimers()
    expect(s.intent.state()).toBe("follow")
  })
})

describe("意图识别：恢复跟随需用户向下滚到底", () => {
  test("上翻后再向下滚回底部 → 恢复跟随", () => {
    const s = setup()
    s.to(9200)
    s.to(8800)
    s.fireTimers()
    expect(s.intent.state()).toBe("hold")
    s.to(9300) // 向下滚回底部（浏览器把位置钳到底）
    expect(s.intent.state()).toBe("follow")
  })

  test("位置自然落进阈值（内容收缩）不恢复跟随", () => {
    const s = setup()
    s.to(9200)
    s.to(8800) // 上翻
    s.fireTimers()
    expect(s.intent.state()).toBe("hold")
    // 内容收缩（高度减小）→ 位置相对落回底部，但本手势无向下位移（非用户动作）
    s.shrinkTo(9000, 8800)
    expect(s.intent.state()).toBe("hold")
  })

  test("滚动条拖动中禁止恢复（拖到阈值区内不被拽到底）", () => {
    const s = setup()
    s.to(9200)
    s.to(8700) // 上翻
    s.fireTimers()
    expect(s.intent.isFollowing()).toBe(false)
    s.to(9150, { allowResume: false }) // 拖到距底 50（阈值内）但拖动中
    expect(s.intent.isFollowing()).toBe(false)
  })

  test("程序滚动的迟到事件（静默窗口）不参与判定", () => {
    const s = setup()
    s.to(9200)
    s.to(8000, { quiet: true })
    expect(s.intent.state()).toBe("follow")
    s.to(8200, { quiet: true })
    expect(s.intent.state()).toBe("follow")
  })
})

describe("意图识别：三态归属与手势聚合", () => {
  test("距底 1.5 屏内 = hold，更远 = reading", () => {
    const s = setup({ viewport: 800 })
    s.to(9200)
    s.to(7500) // 距底 1700 > 800*1.5 + 64 = 1264
    s.fireTimers()
    expect(s.intent.state()).toBe("reading")
    s.to(8500) // 向下滚到距底 700（1.5 屏内）
    expect(s.intent.state()).toBe("hold")
  })

  test("确认期间回到阈值内 → 定时器取消，不解除", () => {
    const s = setup()
    s.to(9200)
    s.to(9000) // 上翻（安排确认）
    expect(s.pendingTimers()).toBe(1)
    s.to(9200) // 回到底部
    expect(s.pendingTimers()).toBe(0)
    s.fireTimers()
    expect(s.intent.state()).toBe("follow")
  })
})

describe("意图识别：显式动作", () => {
  test("follow() 锁定跟随；stop() 解除为阅读态", () => {
    const s = setup()
    s.to(9200)
    s.to(8000)
    s.fireTimers()
    expect(s.intent.isFollowing()).toBe(false)
    s.intent.follow()
    expect(s.intent.state()).toBe("follow")
    s.intent.stop()
    expect(s.intent.state()).toBe("reading")
  })

  test("sync() 按几何同步（程序落位：贴底则跟随，否则按距离归属）", () => {
    const s = setup()
    s.intent.stop()
    s.intent.sync(9200, s.viewport * 1, s.viewport) // 落位到底（height = clientHeight → 无溢出）
    expect(s.intent.state()).toBe("follow")
    s.intent.sync(7000, 10000, s.viewport) // 落到远处
    expect(s.intent.state()).toBe("reading")
  })

  test("rebase()：程序落底后重设基准，不产生位移（不误判为用户滚动）", () => {
    const s = setup()
    s.to(9200)
    s.intent.rebase(9000) // 程序把位置移到 9000
    s.to(9000) // 随后到达的迟到事件位置未变
    expect(s.pendingTimers()).toBe(0)
    expect(s.intent.state()).toBe("follow")
  })
})
