/**
 * 提示浮层（替换 alert）的生命周期核心——纯逻辑，DOM 装配在 `ui.ts`（浏览器单测不便，核心单独可测）。
 *
 * 两类浮层语义不同：
 * - **报错常驻**（`error`）：不自动消退，用户点关闭按钮才移除。报错信息是排查依据，自动消失后就再也看不到；
 *   同一文本去重（同一故障连报不堆成一列），条数有界（超出丢弃最旧的——常驻不消退，无上限会占满窗口）；
 * - **提示自动消退**（`ok`）：到时自动移除；同一时刻至多一条，新提示顶替旧提示（连点复制不积一列）。
 */

export type ToastKind = "error" | "ok"

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

export interface ToastCoreHandle {
  /** 推入一条浮层：`error` 常驻（需手动关闭），`ok` 自动消退。 */
  push(text: string, kind: ToastKind): void
  /** 手动移除一条（报错浮层的关闭按钮）。 */
  dismiss(id: number): void
}

export interface ToastCoreOptions {
  /** 报错浮层条数上限（超出丢弃最旧的）。 */
  maxErrors?: number
  /** 提示自动消退时长（ms）。 */
  hintMs?: number
  /** 新增一条浮层（装配层挂到浮层容器）。 */
  onAdd(item: ToastItem): void
  /** 移除一条浮层（手动关闭 / 自动消退 / 超限淘汰）。 */
  onRemove(item: ToastItem): void
}

/** 提示自动消退时长（ms）。 */
export const TOAST_HINT_MS = 3200
/** 报错浮层条数上限（条）。 */
export const TOAST_MAX_ERRORS = 4

export function createToastCore(opts: ToastCoreOptions): ToastCoreHandle {
  const maxErrors = opts.maxErrors ?? TOAST_MAX_ERRORS
  const hintMs = opts.hintMs ?? TOAST_HINT_MS
  const items: ToastItem[] = []
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextId = 1

  const drop = (id: number): void => {
    const i = items.findIndex((x) => x.id === id)
    if (i < 0) return
    const [item] = items.splice(i, 1)
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(id)
    }
    opts.onRemove(item!)
  }

  const add = (text: string, kind: ToastKind): ToastItem => {
    const item: ToastItem = { id: nextId++, text, kind }
    items.push(item)
    opts.onAdd(item)
    return item
  }

  return {
    push(text, kind) {
      if (kind === "error") {
        if (items.some((i) => i.kind === "error" && i.text === text)) return // 同文去重：同一故障连报不堆叠
        add(text, kind)
        const errors = items.filter((i) => i.kind === "error")
        for (const old of errors.slice(0, Math.max(0, errors.length - maxErrors))) drop(old.id)
        return
      }
      for (const old of items.filter((i) => i.kind === "ok")) drop(old.id) // 提示至多一条：新提示顶替旧提示
      const item = add(text, kind)
      timers.set(
        item.id,
        setTimeout(() => drop(item.id), hintMs),
      )
    },
    dismiss(id) {
      drop(id)
    },
  }
}
