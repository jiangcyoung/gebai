/**
 * 低性能模式：用户开关（设置面板「外观」）+ 设备信号默认值。
 * - 存储：localStorage `gebai.ui.lowPower` = "on" / "off"（用户显式选择，两种都落盘——"off" 要能压过设备默认值）
 * - 未显式选择时按设备信号取默认：系统「减少动态效果」、省流模式、低内存设备（见 deviceDefaultLowPower）
 * - 生效方式：根元素 `data-low-power="on"`（CSS 降级动画/毛玻璃等特效）；图表导出降采样等经 isLowPower() 读取
 */

export type LowPowerSetting = "on" | "off"

const KEY = "gebai.ui.lowPower"
/** 低内存阈值（GiB）：Chromium 的 deviceMemory 上报上限为 8，≤ 此值的移动设备跑毛玻璃/粒子特效代价明显。 */
const LOW_MEMORY_GIB = 4

/** 用户显式存储值（未设置返回 null，旧三态值 "auto"/其它一律忽略）。 */
function storedSetting(): LowPowerSetting | null {
  try {
    const v = localStorage.getItem(KEY)
    if (v === "on" || v === "off") return v
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return null
}

/** 设备是否在要求「别跑重特效」：系统减少动态效果 / 省流模式 / 低内存设备。 */
export function deviceDefaultLowPower(): boolean {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true
  } catch {
    /* matchMedia 不可用时忽略 */
  }
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } })
  if (!nav) return false
  if (nav.connection?.saveData === true) return true
  return typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 && nav.deviceMemory <= LOW_MEMORY_GIB
}

/** 当前设置：用户显式选择优先，未选择时取设备默认值。 */
export function getLowPowerSetting(): LowPowerSetting {
  return storedSetting() ?? (deviceDefaultLowPower() ? "on" : "off")
}

/** 当前是否处于低性能模式。 */
export function isLowPower(): boolean {
  return getLowPowerSetting() === "on"
}

/** 应用低性能模式：设置根元素 data-low-power 标记；值变化时派发事件（设置面板等刷新显示）。 */
export function applyLowPower(): void {
  const on = isLowPower()
  const el = document.documentElement
  const prev = el.dataset.lowPower
  const next = on ? "on" : undefined
  if (next) el.dataset.lowPower = next
  else delete el.dataset.lowPower
  if (prev !== next) {
    document.dispatchEvent(new CustomEvent("gebai:low-power-change", { detail: { low: on } }))
  }
}

/** 手动设置（设置面板「外观」）：on=开启；off=关闭。显式落盘（能压过设备默认值）+ 立即生效。 */
export function setLowPowerSetting(v: LowPowerSetting): void {
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* ignore */
  }
  applyLowPower()
}

/** 初始化：应用当前设置，并跟随跨标签页修改与系统「减少动态效果」变化（未显式选择时后者决定默认值）。 */
export function initLowPower(): void {
  applyLowPower()
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return
    applyLowPower()
  })
  try {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    mq?.addEventListener?.("change", () => applyLowPower())
  } catch {
    /* matchMedia 不可用时忽略 */
  }
}
