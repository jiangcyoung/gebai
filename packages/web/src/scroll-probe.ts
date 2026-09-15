/**
 * 滚动诊断探针（按需开启，默认关闭）：把「滚动体感类缺陷」的现场取证做成产品能力，
 * 免去让用户手贴脚本——开启后记录消息列的每次 scrollTop 写入（含调用栈）、周期性快照
 * （位置/高度/spacer/挂载块/跟随状态/视口中心命中）与滚动事件，随时导出为可粘贴文本。
 *
 * 开启方式（任选，均不落库、不联网、纯本地）：
 * - URL 参数 `?gb_scroll_probe=1`（临时排查，刷新即失效）
 * - localStorage `gebai.ui.scrollProbe` = "on"（长期开启，排查完删掉该键）
 *
 * 使用：开启后复现问题 → 控制台执行 `__gbScrollProbe()` 打印并复制报告；`__gbScrollProbeClear()` 清空记录。
 * 记录上限 SCROLL_PROBE_MAX 条（环形丢弃最旧），避免长时间开启吃内存。
 */

import { msgEl } from "./state"

const KEY = "gebai.ui.scrollProbe"
/** 记录条数上限（滚动事件密集，超出丢最旧）。 */
export const SCROLL_PROBE_MAX = 1500
/** 周期采样间隔（毫秒）：捕捉无事件的静默漂移（内容增长/异步布局）。 */
export const SCROLL_PROBE_TICK_MS = 60
/** 单条写入记录的调用栈深度（够定位到模块函数即可）。 */
const STACK_DEPTH = 4

/** 探针是否开启（URL 参数优先于持久化设置）。 */
export function isScrollProbeEnabled(loc?: { search?: string; getItem?: (k: string) => string | null }): boolean {
  const search = loc?.search ?? (typeof location !== "undefined" ? location.search : "")
  if (/(?:^|[?&])gb_scroll_probe=(?:1|on|true)(?:&|$)/.test(search)) return true
  try {
    const get = loc?.getItem ?? ((k: string) => localStorage.getItem(k))
    return get(KEY) === "on"
  } catch {
    return false
  }
}

/** 开启探针（持久化，需刷新页面生效）。 */
export function setScrollProbeEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "on")
    else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式忽略 */
  }
}

/** 单条记录：写入 / 快照 / 滚动事件。 */
interface ProbeEntry {
  t: number
  why: "WRITE" | "tick" | "scroll"
  [k: string]: unknown
}

/** 采集一次现场快照（不含写入，公开供测试与手动取样）。 */
export function probeSnapshot(c: HTMLElement = msgEl): ProbeEntry {
  const kids = Array.from(c.children)
  const spacer = kids.filter((n) => n.classList.contains("vz-spacer"))
  const rect = c.getBoundingClientRect()
  const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
  return {
    t: Math.round(performance.now()),
    why: "tick",
    top: Math.round(c.scrollTop),
    max: Math.round(c.scrollHeight - c.clientHeight),
    dist: Math.round(c.scrollHeight - c.scrollTop - c.clientHeight),
    pad: spacer.map((n) => Math.round(n.getBoundingClientRect().height)),
    blocks: kids.filter((n) => n.classList.contains("vz-block")).length,
    msgs: c.querySelectorAll(".msg").length,
    following: document.getElementById("jump-bottom")?.hidden,
    center: hit ? (hit.closest(".vz-spacer") ? "SPACER" : hit.closest(".msg") ? "msg" : (hit as HTMLElement).className || hit.tagName) : "none",
    streaming: !!c.querySelector(".streaming"),
  }
}

let installed = false
let entries: ProbeEntry[] = []
let timer: ReturnType<typeof setInterval> | null = null
let patched: { el: HTMLElement; set: (v: number) => void; original: PropertyDescriptor } | null = null

/** 安装探针（幂等；调用方按 isScrollProbeEnabled 决定是否调用）。 */
export function installScrollProbe(): boolean {
  if (installed) return false
  const c = msgEl
  if (!c) return false
  installed = true
  entries = []

  const push = (e: ProbeEntry) => {
    entries.push(e)
    if (entries.length > SCROLL_PROBE_MAX) entries.shift()
  }

  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")
  if (desc?.get && desc.set) {
    Object.defineProperty(c, "scrollTop", {
      configurable: true,
      get: () => desc.get!.call(c),
      set(v: number) {
        let src = "?"
        try {
          src = new Error().stack
            ?.split("\n")
            .slice(1, 1 + STACK_DEPTH)
            .map((s) => s.trim().replace(/^at\s+/, ""))
            .join(" | ") ?? "?"
        } catch {
          /* 栈不可用：只记数值 */
        }
        push({ t: Math.round(performance.now()), why: "WRITE", v: Math.round(v), src })
        return desc.set!.call(c, v)
      },
    })
    patched = { el: c, set: desc.set as (v: number) => void, original: desc }
  }

  c.addEventListener("scroll", () => push({ ...probeSnapshot(c), why: "scroll" }), { passive: true })
  timer = setInterval(() => push(probeSnapshot(c)), SCROLL_PROBE_TICK_MS)

  const w = window as unknown as Record<string, unknown>
  w.__gbScrollProbe = () => {
    const text = JSON.stringify(
      {
        ua: navigator.userAgent,
        viewport: [innerWidth, innerHeight],
        blocked: patched ? false : "scrollTop 未被拦截（探针装在页面脚本之前才有效）",
        log: entries,
      },
      null,
      1,
    )
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      /* 剪贴板不可用：仅打印 */
    }
    console.log(text)
    return `${text.length} 字符：已打印到控制台（并尝试复制到剪贴板）`
  }
  w.__gbScrollProbeClear = () => {
    entries = []
    return "已清空探针记录"
  }
  return true
}

/** 卸载探针（恢复原始 scrollTop 描述符，清记录与定时器）。 */
export function uninstallScrollProbe(): void {
  if (!installed) return
  if (timer) clearInterval(timer)
  timer = null
  if (patched) {
    Object.defineProperty(patched.el, "scrollTop", patched.original)
    patched = null
  }
  const w = window as unknown as Record<string, unknown>
  delete w.__gbScrollProbe
  delete w.__gbScrollProbeClear
  entries = []
  installed = false
}

/** 当前记录条数（测试 / 排查用）。 */
export function scrollProbeCount(): number {
  return entries.length
}
