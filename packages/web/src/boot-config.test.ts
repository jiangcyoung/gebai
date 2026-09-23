import { describe, expect, test } from "bun:test"
import {
  CONFIG_KEY,
  applyWebConfig,
  applyWebConfigStorage,
  configEnv,
  normalizeWebConfig,
  readWebConfig,
  urlPromptAllowed,
} from "./boot-config"

/** 内存版 localStorage（测试替身）。 */
function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  }
}

describe("normalizeWebConfig（容错归一化）", () => {
  test("非对象/数组/undefined 回落默认（URL 提示词默认开启）", () => {
    expect(normalizeWebConfig(undefined)).toEqual({ env: {}, envFromStorage: {}, storage: {}, allowUrlPrompt: true })
    expect(normalizeWebConfig("x")).toEqual({ env: {}, envFromStorage: {}, storage: {}, allowUrlPrompt: true })
    expect(normalizeWebConfig([1, 2])).toEqual({ env: {}, envFromStorage: {}, storage: {}, allowUrlPrompt: true })
  })

  test("env 丢弃空值与非字符串；键值 trim", () => {
    const cfg = normalizeWebConfig({ env: { A: "1", " B ": " 2 ", C: "", D: 3, "": "x", E: null } })
    expect(cfg.env).toEqual({ A: "1", B: "2" })
  })

  test("storage 支持字符串（宿主键）与对象（from/value/force）两种写法", () => {
    const cfg = normalizeWebConfig({
      storage: {
        "gebai.ui.style": "myapp.theme",
        "gebai.ui.lowPower": { value: "on" },
        "gebai.ui.approvalSkip": { from: "myapp.skip", force: true },
        "gebai.ui.bad1": {},
        "gebai.ui.bad2": 42,
      },
    })
    expect(cfg.storage).toEqual({
      "gebai.ui.style": { from: "myapp.theme" },
      "gebai.ui.lowPower": { value: "on" },
      "gebai.ui.approvalSkip": { from: "myapp.skip", force: true },
    })
  })

  test("allowUrlPrompt 只有显式 false 才关闭", () => {
    expect(normalizeWebConfig({ allowUrlPrompt: false }).allowUrlPrompt).toBe(false)
    expect(normalizeWebConfig({ allowUrlPrompt: 0 }).allowUrlPrompt).toBe(true)
    expect(normalizeWebConfig({}).allowUrlPrompt).toBe(true)
  })
})

describe("readWebConfig（从 window 读取）", () => {
  test("对象形态直读；缺失为空配置", () => {
    expect(readWebConfig({ [CONFIG_KEY]: { env: { A: "1" } } }).env).toEqual({ A: "1" })
    expect(readWebConfig({}).env).toEqual({})
  })

  test("函数形态求值；求值抛错回落空配置", () => {
    expect(readWebConfig({ [CONFIG_KEY]: () => ({ env: { A: "1" } }) }).env).toEqual({ A: "1" })
    const cfg = readWebConfig({
      [CONFIG_KEY]: () => {
        throw new Error("boom")
      },
    })
    expect(cfg.env).toEqual({})
    expect(cfg.allowUrlPrompt).toBe(true)
  })
})

describe("configEnv（配置文件预置 + 宿主存储取值）", () => {
  test("env 与 envFromStorage 合并，宿主键有值覆盖 env 同名项", () => {
    const s = store({ "myapp.key": "  host-key  " })
    const cfg = normalizeWebConfig({ env: { A: "1", B: "cfg" }, envFromStorage: { B: "myapp.key", C: "myapp.missing" } })
    expect(configEnv(cfg, s)).toEqual({ A: "1", B: "host-key" })
  })

  test("宿主存储不可用不影响静态 env", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {},
    }
    const cfg = normalizeWebConfig({ env: { A: "1" }, envFromStorage: { B: "myapp.key" } })
    expect(configEnv(cfg, throwing)).toEqual({ A: "1" })
  })
})

describe("applyWebConfigStorage（写歌白设置键）", () => {
  test("只写未设置的键，已有值不被覆盖", () => {
    const s = store({ "gebai.ui.style": "ink", "myapp.theme": "cny" })
    const cfg = normalizeWebConfig({ storage: { "gebai.ui.style": "myapp.theme", "gebai.ui.lowPower": { value: "on" } } })
    expect(applyWebConfigStorage(cfg, s)).toEqual(["gebai.ui.lowPower"])
    expect(s.dump()["gebai.ui.style"]).toBe("ink")
    expect(s.dump()["gebai.ui.lowPower"]).toBe("on")
  })

  test("force 覆盖已有值；宿主键无值时跳过", () => {
    const s = store({ "gebai.ui.style": "ink", "myapp.theme": "cny" })
    const cfg = normalizeWebConfig({
      storage: { "gebai.ui.style": { from: "myapp.theme", force: true }, "gebai.ui.cnyScheme": "myapp.missing" },
    })
    expect(applyWebConfigStorage(cfg, s)).toEqual(["gebai.ui.style"])
    expect(s.dump()["gebai.ui.style"]).toBe("cny")
    expect("gebai.ui.cnyScheme" in s.dump()).toBe(false)
  })
})

describe("applyWebConfig + urlPromptAllowed（URL 提示词开关）", () => {
  test("应用配置并据 allowUrlPrompt 收放开入口", () => {
    const s = store({ "myapp.theme": "matrix" })
    const off = applyWebConfig({ host: { [CONFIG_KEY]: { allowUrlPrompt: false, storage: { "gebai.ui.style": "myapp.theme" } } }, store: s })
    expect(off).toEqual({ written: ["gebai.ui.style"], allowUrlPrompt: false })
    expect(s.dump()["gebai.ui.style"]).toBe("matrix")
    expect(urlPromptAllowed()).toBe(false)
    applyWebConfig({ host: {}, store: s })
    expect(urlPromptAllowed()).toBe(true)
  })

  test("无配置文件时开关保持开启且不写任何键", () => {
    const s = store()
    expect(applyWebConfig({ host: {}, store: s })).toEqual({ written: [], allowUrlPrompt: true })
    expect(s.dump()).toEqual({})
  })
})
