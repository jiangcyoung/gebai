/**
 * 行内 blame 的纯逻辑（`files/blame.ts`）：注释文本、悬浮提示、行号索引。
 * 这三种都是「显示口径」，改动容易悄悄影响两种形态（侧边列与光标行行尾），用单测钉住。
 */
import { describe, expect, test } from "bun:test"
import { blameHover, blameLabel, toBlameIndex, type BlameLine } from "./blame"

const line = (over: Partial<BlameLine> = {}): BlameLine => ({
  line: 1,
  hash: "abcdef1234567890abcdef1234567890abcdef12",
  author: "xuxinle",
  time: Date.now() - 2 * 60 * 60 * 1000,
  summary: "feat: 某次提交",
  uncommitted: false,
  ...over,
})

describe("blameLabel（作者 · 时间）", () => {
  test("普通行：作者 + 相对时间", () => {
    expect(blameLabel(line({ time: Date.now() - 2 * 60 * 60 * 1000 }))).toBe("xuxinle · 2 小时前")
  })

  test("超长作者名截到 14 字符（列宽固定，超出即省略）", () => {
    const long = "abcdefghijklmnopqrstuvwxyz"
    expect(blameLabel(line({ author: long }))).toBe(`${long.slice(0, 14)} · 2 小时前`)
  })

  test("作者缺失回落「未知」", () => {
    expect(blameLabel(line({ author: "" }))).toBe("未知 · 2 小时前")
  })

  test("未提交行只标「未提交」：不写占位作者（Not Committed）", () => {
    expect(blameLabel(line({ author: "Not Committed", uncommitted: true }))).toBe("未提交")
  })
})

describe("blameHover（悬浮提示）", () => {
  test("含短哈希 + 作者 + 绝对时间 + 摘要", () => {
    const t = Date.now()
    const out = blameHover(line({ hash: "abcdef1234567890abcdef1234567890abcdef12", time: t, summary: "fix: 修好了" }))
    expect(out.startsWith("abcdef12 · xuxinle · ")).toBe(true)
    expect(out.endsWith(" · fix: 修好了")).toBe(true)
    expect(out).toContain(new Date(t).toLocaleString())
  })

  test("未提交行：写「未提交」而不是时间戳；无摘要时不留尾部分隔符", () => {
    const out = blameHover(line({ uncommitted: true, summary: "" }))
    expect(out).toBe("abcdef12 · xuxinle · 未提交")
  })
})

describe("toBlameIndex（行号索引）", () => {
  test("按行号建表，非法行号丢弃", () => {
    const map = toBlameIndex([line({ line: 3 }), line({ line: 0 }), line({ line: 7 })])
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([3, 7])
    expect(map.get(3)?.author).toBe("xuxinle")
  })

  test("同一行重复时后者覆盖（服务端逐行结果不应重复，但别让脏数据画出两行）", () => {
    const map = toBlameIndex([line({ line: 5, author: "a" }), line({ line: 5, author: "b" })])
    expect(map.get(5)?.author).toBe("b")
  })
})
