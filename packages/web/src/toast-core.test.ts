import { describe, expect, test } from "bun:test"
import { TOAST_MAX_ERRORS, createToastCore, type ToastItem } from "./toast-core"

/** 装配记录：onAdd/onRemove 即「浮层上屏/下屏」。 */
function makeCore(opts?: { maxErrors?: number; hintMs?: number }) {
  const added: ToastItem[] = []
  const removed: number[] = []
  const core = createToastCore({
    maxErrors: opts?.maxErrors,
    hintMs: opts?.hintMs ?? 10,
    onAdd: (item) => void added.push(item),
    onRemove: (item) => void removed.push(item.id),
  })
  return { core, added, removed }
}

describe("toast-core：报错常驻", () => {
  test("超过消退时长仍在屏（不自动消退），手动关闭才移除", async () => {
    const { core, added, removed } = makeCore({ hintMs: 10 })
    core.push("保存失败：EACCES", "error")
    await Bun.sleep(40)
    expect(added).toHaveLength(1)
    expect(removed).toEqual([]) // 报错信息不自动消失
    core.dismiss(added[0]!.id)
    expect(removed).toEqual([added[0]!.id])
  })

  test("同一文本去重：同一故障连报不堆成一列", () => {
    const { core, added } = makeCore()
    core.push("连接失败", "error")
    core.push("连接失败", "error")
    core.push("连接失败", "error")
    expect(added).toHaveLength(1)
  })

  test("条数有界：超出上限淘汰最旧的（常驻不消退，无上限会占满窗口）", () => {
    const { core, added, removed } = makeCore({ maxErrors: 2 })
    core.push("错误一", "error")
    core.push("错误二", "error")
    core.push("错误三", "error")
    expect(added.map((i) => i.text)).toEqual(["错误一", "错误二", "错误三"])
    expect(removed).toEqual([added[0]!.id]) // 只淘汰最旧的一条
  })

  test("默认上限 4 条", () => {
    const { core, added } = makeCore()
    for (let i = 1; i <= TOAST_MAX_ERRORS + 2; i++) core.push(`错误 ${i}`, "error")
    expect(added).toHaveLength(TOAST_MAX_ERRORS + 2)
    expect(TOAST_MAX_ERRORS).toBe(4)
  })
})

describe("toast-core：提示自动消退", () => {
  test("到时自动移除", async () => {
    const { core, added, removed } = makeCore({ hintMs: 10 })
    core.push("已复制", "ok")
    await Bun.sleep(40)
    expect(removed).toEqual([added[0]!.id])
  })

  test("同一时刻至多一条：新提示顶替旧提示（连点复制不积一列）", () => {
    const { core, added, removed } = makeCore()
    core.push("已复制", "ok")
    core.push("已复制路径", "ok")
    expect(added).toHaveLength(2)
    expect(removed).toEqual([added[0]!.id])
  })

  test("提示与报错互不干扰：报错不因提示到来被顶替", async () => {
    const { core, added, removed } = makeCore({ hintMs: 10 })
    core.push("解析失败", "error")
    core.push("已复制", "ok")
    await Bun.sleep(40)
    expect(removed).toEqual([added[1]!.id]) // 只有提示消退
  })
})
