import { afterAll, describe, expect, test } from "bun:test"
import { deviceDefaultLowPower, getLowPowerSetting, isLowPower, setLowPowerSetting } from "./low-power"

/** bun test 无 DOM：提供最小 localStorage mock（low-power 内部 try/catch 兜底，mock 用于验证存取语义）。 */
const store = new Map<string, string>()
const prevLocalStorage = (globalThis as Record<string, unknown>).localStorage
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
} as unknown as Storage
// 用完全局存储要放回基线那一份：整体替换而不还原会泄漏给后续测试文件（见 scripts/test-preload.ts）
afterAll(() => {
  ;(globalThis as Record<string, unknown>).localStorage = prevLocalStorage
})
// setLowPowerSetting → applyLowPower 需要 document：只补自己需要的字段，
// 不整体替换（基线 DOM 由 scripts/test-preload.ts 提供，整体替换会把它盖掉，
// 后续测试文件里模块顶层的 getElementById 之类就会炸）
const lowPowerDoc = ((globalThis as Record<string, unknown>).document ??= {}) as Record<string, unknown>
lowPowerDoc.documentElement ??= { dataset: {} }
lowPowerDoc.dispatchEvent ??= () => true
lowPowerDoc.addEventListener ??= () => {}
lowPowerDoc.removeEventListener ??= () => {}

/** 设备信号由 window.matchMedia 与 navigator 表达——用例按需替换这两个全局，用完还原。 */
const prevNavigator = (globalThis as Record<string, unknown>).navigator
const prevWindow = (globalThis as Record<string, unknown>).window
const prevMatchMedia = (globalThis as Record<string, unknown>).matchMedia

function setDeviceSignals(opts: { reducedMotion?: boolean; saveData?: boolean; deviceMemory?: number }): void {
  ;(globalThis as Record<string, unknown>).navigator = {
    connection: { saveData: opts.saveData === true },
    deviceMemory: opts.deviceMemory,
  }
  ;(globalThis as Record<string, unknown>).window = {
    matchMedia: (q: string) => ({ matches: q.includes("reduced-motion") && opts.reducedMotion === true, addEventListener: () => {} }),
  }
}

afterAll(() => {
  ;(globalThis as Record<string, unknown>).navigator = prevNavigator
  ;(globalThis as Record<string, unknown>).window = prevWindow
  ;(globalThis as Record<string, unknown>).matchMedia = prevMatchMedia
})

describe("low-power setting（用户开关 + 设备默认值）", () => {
  test("无设备信号且未显式选择：默认关闭；旧三态存储值一律忽略", () => {
    store.clear()
    setDeviceSignals({})
    expect(getLowPowerSetting()).toBe("off")
    expect(isLowPower()).toBe(false)
    store.set("gebai.ui.lowPower", "auto") // 旧三态
    expect(getLowPowerSetting()).toBe("off")
    store.set("gebai.ui.lowPower", "bogus")
    expect(getLowPowerSetting()).toBe("off")
    store.set("gebai.ui.lowPower", "on")
    expect(getLowPowerSetting()).toBe("on")
    expect(isLowPower()).toBe(true)
  })

  test("设备信号默认值：系统减少动态效果 / 省流模式 / 低内存设备", () => {
    store.clear()
    setDeviceSignals({ reducedMotion: true })
    expect(deviceDefaultLowPower()).toBe(true)
    setDeviceSignals({ saveData: true })
    expect(deviceDefaultLowPower()).toBe(true)
    setDeviceSignals({ deviceMemory: 4 })
    expect(deviceDefaultLowPower()).toBe(true)
    setDeviceSignals({ deviceMemory: 8 })
    expect(deviceDefaultLowPower()).toBe(false)
    // 设备默认值只在「未显式选择」时生效
    setDeviceSignals({ deviceMemory: 2 })
    expect(getLowPowerSetting()).toBe("on")
    store.set("gebai.ui.lowPower", "off")
    expect(getLowPowerSetting()).toBe("off")
    expect(isLowPower()).toBe(false)
  })

  test("set on / off 均显式落盘（off 能压过设备默认值）", () => {
    store.clear()
    setDeviceSignals({ deviceMemory: 2 })
    setLowPowerSetting("on")
    expect(store.get("gebai.ui.lowPower")).toBe("on")
    setLowPowerSetting("off")
    expect(store.get("gebai.ui.lowPower")).toBe("off")
    expect(getLowPowerSetting()).toBe("off")
    expect(isLowPower()).toBe(false)
  })
})
