import { describe, expect, test } from "bun:test"
import {
  CARD_FOLD_MARGIN,
  CARD_FOLD_SNAP_H,
  CARD_MAX_RATIO_NARROW,
  CARD_MIN_EXPANDED_H,
  CARD_NARROW_W,
  CARD_PREVIEW_H,
  cardMaxBodyHeight,
  readCardFoldState,
  resolveCardDrag,
  shouldOfferFold,
  shouldStartCollapsed,
} from "./card-fold"

describe("初始折叠判定（内容超过配额时一出现就是收起的预览条）", () => {
  test("内容放得下：保持全展开（不动普通卡片行为）", () => {
    // 宽屏 1000 高：配额 544；内容 200 / 544 都放得下
    expect(shouldStartCollapsed(200, 1000, 1280)).toBe(false)
    expect(shouldStartCollapsed(544, 1000, 1280)).toBe(false)
  })

  test("内容超过配额：初始收起", () => {
    expect(shouldStartCollapsed(545, 1000, 1280)).toBe(true)
    // 窄屏配额更小（844 高 → 298）：同一内容宽屏放得下、窄屏就该先收起
    expect(cardMaxBodyHeight(844, 1280)).toBe(450)
    expect(cardMaxBodyHeight(844, 390)).toBe(298)
    expect(shouldStartCollapsed(320, 844, 1280)).toBe(false)
    expect(shouldStartCollapsed(320, 844, 390)).toBe(true)
  })

  test("内容本来不高（不值得折叠）：不收起、也不提供折叠", () => {
    const small = CARD_PREVIEW_H + CARD_FOLD_MARGIN
    expect(shouldStartCollapsed(small, 400, 390)).toBe(false)
    expect(shouldOfferFold(small)).toBe(false)
  })

  test("非法内容高度不收起（宁可不折叠，不让卡片无故吞掉内容）", () => {
    expect(shouldStartCollapsed(Number.NaN, 844, 390)).toBe(false)
  })
})

describe("交互卡片高度模型（cardMaxBodyHeight）", () => {
  test("窄屏（≤860px）配额下调：手机上卡片不吃掉大半屏", () => {
    // 844 高的手机：0.42 × 844 = 354，扣卡头 56 → 298（宽屏档同尺寸为 450）
    expect(cardMaxBodyHeight(844, 390)).toBe(298)
    expect(cardMaxBodyHeight(844)).toBe(450)
    expect(CARD_MAX_RATIO_NARROW).toBeLessThan(0.6)
    // 阈值口径与 CSS 布局断点一致：860 命中窄屏档，861 走宽屏档
    expect(cardMaxBodyHeight(1000, CARD_NARROW_W)).toBe(cardMaxBodyHeight(1000, 800))
    expect(cardMaxBodyHeight(1000, CARD_NARROW_W + 1)).toBe(cardMaxBodyHeight(1000))
  })

  test("窄屏下拖拽上限同步收紧", () => {
    expect(resolveCardDrag(9999, 844, 390)).toEqual({ collapsed: false, height: cardMaxBodyHeight(844, 390) })
  })

  test("按视口比例上限换算并扣除卡头", () => {
    // 844 高的手机：0.6 × 844 = 506，扣卡头 56 → 450
    expect(cardMaxBodyHeight(844)).toBe(450)
    expect(cardMaxBodyHeight(1000)).toBe(544)
  })

  test("视口极小时不低于展开态最小高度（避免出现不可操作的卡片）", () => {
    expect(cardMaxBodyHeight(120)).toBe(CARD_MIN_EXPANDED_H)
    expect(cardMaxBodyHeight(0)).toBe(CARD_MIN_EXPANDED_H)
    expect(cardMaxBodyHeight(Number.NaN)).toBe(CARD_MIN_EXPANDED_H)
  })
})

describe("折叠按钮的出现条件（shouldOfferFold）", () => {
  test("内容不超过预览高度 + 余量时不提供折叠", () => {
    expect(shouldOfferFold(CARD_PREVIEW_H)).toBe(false)
    expect(shouldOfferFold(CARD_PREVIEW_H + CARD_FOLD_MARGIN)).toBe(false)
    expect(shouldOfferFold(CARD_PREVIEW_H + CARD_FOLD_MARGIN + 1)).toBe(true)
  })

  test("非法高度不提供折叠", () => {
    expect(shouldOfferFold(Number.NaN)).toBe(false)
  })
})

describe("拖拽求解（resolveCardDrag）", () => {
  test("低于吸附线：判为拖到底，进折叠态", () => {
    expect(resolveCardDrag(CARD_FOLD_SNAP_H - 1, 844)).toEqual({ collapsed: true, height: CARD_PREVIEW_H })
    expect(resolveCardDrag(0, 844)).toEqual({ collapsed: true, height: CARD_PREVIEW_H })
    expect(resolveCardDrag(-200, 844)).toEqual({ collapsed: true, height: CARD_PREVIEW_H })
  })

  test("吸附线之上、最小展开高度之下：钳到最小展开高度（不折叠）", () => {
    expect(resolveCardDrag(CARD_FOLD_SNAP_H, 844)).toEqual({ collapsed: false, height: CARD_MIN_EXPANDED_H })
    expect(resolveCardDrag(CARD_MIN_EXPANDED_H - 1, 844)).toEqual({ collapsed: false, height: CARD_MIN_EXPANDED_H })
  })

  test("超过视口比例上限：钳到上限", () => {
    expect(resolveCardDrag(4000, 844)).toEqual({ collapsed: false, height: cardMaxBodyHeight(844) })
  })

  test("区间内原样返回（取整）", () => {
    expect(resolveCardDrag(300.6, 844)).toEqual({ collapsed: false, height: 301 })
  })

  test("视口过小导致上限低于最小展开高度：上限优先（不越过视口约束）", () => {
    const max = cardMaxBodyHeight(120)
    expect(resolveCardDrag(9999, 120)).toEqual({ collapsed: false, height: max })
  })

  test("非法高度回落到最小展开高度", () => {
    expect(resolveCardDrag(Number.NaN, 844)).toEqual({ collapsed: false, height: CARD_MIN_EXPANDED_H })
  })
})

describe("折叠态读回（readCardFoldState）", () => {
  const fakeRoot = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement

  test("折叠标记与自定义高度一并读回", () => {
    expect(readCardFoldState(fakeRoot({ folded: "1", cardH: "320" }))).toEqual({ collapsed: true, height: 320 })
  })

  test("无标记时为展开自适应", () => {
    expect(readCardFoldState(fakeRoot({}))).toEqual({ collapsed: false, height: null })
    expect(readCardFoldState(fakeRoot({ folded: "0" }))).toEqual({ collapsed: false, height: null })
  })

  test("高度非法值按未设置处理", () => {
    expect(readCardFoldState(fakeRoot({ cardH: "abc" })).height).toBeNull()
    expect(readCardFoldState(fakeRoot({ cardH: "0" })).height).toBeNull()
    expect(readCardFoldState(fakeRoot({ cardH: "-10" })).height).toBeNull()
  })
})
