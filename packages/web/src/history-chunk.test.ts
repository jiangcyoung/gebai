import { describe, expect, test } from "bun:test"
import { planMessageChunks, type RunMessageLike } from "./history-chunk"

/** 普通消息（不进折叠容器）。 */
const plain = (): RunMessageLike => ({})
/** 执行过程消息（同一 runId 归入同一折叠容器）。 */
const run = (runId: string): RunMessageLike => ({ subSession: true, subSessionId: runId })

describe("窗口化块划分（planMessageChunks）", () => {
  test("空列表与不足一块：单块覆盖", () => {
    expect(planMessageChunks([], 20)).toEqual([0])
    expect(planMessageChunks([plain(), plain()], 20)).toEqual([0, 2])
  })

  test("恰好整除与有余数：边界均匀且末块收尾", () => {
    expect(planMessageChunks(Array.from({ length: 40 }, plain), 20)).toEqual([0, 20, 40])
    expect(planMessageChunks(Array.from({ length: 45 }, plain), 20)).toEqual([0, 20, 40, 45])
  })

  test("边界落在执行过程组内：向后吞并整组（不拆容器）", () => {
    // 组 [18..24] 同一 runId，块大小 20 → 第二块起点 20 落在组内 → 首块吞并到 25
    const msgs: RunMessageLike[] = [...Array.from({ length: 18 }, plain), ...Array.from({ length: 7 }, () => run("r1")), ...Array.from({ length: 30 }, plain)]
    expect(planMessageChunks(msgs, 20)).toEqual([0, 25, 45, 55])
  })

  test("相邻两组不同 runId：组边界就是块边界（不越组吞并）", () => {
    const msgs: RunMessageLike[] = [...Array.from({ length: 5 }, plain), ...Array.from({ length: 10 }, () => run("r1")), ...Array.from({ length: 10 }, () => run("r2")), ...Array.from({ length: 5 }, plain)]
    // run(r1) 组占 [5..14]、run(r2) 组占 [15..24]；块起点落在组内 → 各自吞并到组尾
    expect(planMessageChunks(msgs, 5)).toEqual([0, 5, 15, 25, 30])
  })

  test("组跨越多个块容量：块吞并到组尾后继续划分", () => {
    const msgs: RunMessageLike[] = [...Array.from({ length: 3 }, plain), ...Array.from({ length: 12 }, () => run("r1")), ...Array.from({ length: 20 }, plain)]
    // run(r1) 组占 [3..14]，首块吞并到 15；之后按 5 划到末尾
    expect(planMessageChunks(msgs, 5)).toEqual([0, 15, 20, 25, 30, 35])
  })

  test("chunkSize 非法值按 1 处理", () => {
    expect(planMessageChunks([plain(), plain()], 0)).toEqual([0, 1, 2])
    expect(planMessageChunks([plain(), plain()], -3)).toEqual([0, 1, 2])
  })
})
