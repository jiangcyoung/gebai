import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { def, inferHome, listModels, loadProfiles, modelsDir, profileModel, profilesPath, requiresApproval } from "./local_infer"

const tmp = mkdtempSync(join(tmpdir(), "gebai-localinfer-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function makeHome(): string {
  const home = join(tmp, `home-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(home, "config"), { recursive: true })
  return home
}

describe("local_infer 子Agent 定义", () => {
  test("名称与工具集符合契约", () => {
    expect(def.name).toBe("local_infer")
    expect(def.preload).toBe(false)
    for (const t of ["status", "models", "start", "stop", "bench", "inspect"]) {
      expect(def.tools![t]).toBeDefined()
    }
    // 只读工具免审批，会改变系统状态的工具需审批
    expect(requiresApproval).toEqual({ start: true, stop: true, bench: true })
    expect(def.tools!.status.requiresApproval).toBeUndefined()
    expect(def.tools!.models.requiresApproval).toBeUndefined()
    expect(def.tools!.inspect.requiresApproval).toBeUndefined()
    expect(def.tools!.start.requiresApproval).toBe(true)
  })

  test("工具名不含非法字符（命名空间前缀由引擎拼接）", () => {
    for (const t of Object.keys(def.tools!)) expect(t).toMatch(/^[a-zA-Z0-9_]+$/)
  })

  test("环境变量声明白名单以 LOCAL_INFER_ 前缀", () => {
    expect(def.envVars!.length).toBeGreaterThan(0)
    for (const v of def.envVars!) {
      expect(v.name.startsWith("LOCAL_INFER_")).toBe(true)
      expect(v.description.length).toBeGreaterThan(0)
    }
  })

  test("input schema 参数名为蛇形", () => {
    for (const tool of Object.values(def.tools!)) {
      for (const key of Object.keys(tool.parameters.properties ?? {})) {
        expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
      }
    }
  })
})

describe("路径与环境解析", () => {
  test("LOCAL_INFER_HOME 绝对路径直接采用（POSIX 与 Windows 形态跨平台识别）", () => {
    expect(inferHome({ LOCAL_INFER_HOME: "C:\\infer-x" })).toBe("C:\\infer-x")
    expect(inferHome({ LOCAL_INFER_HOME: "C:/infer-x" })).toBe("C:/infer-x")
    expect(inferHome({ LOCAL_INFER_HOME: "\\\\srv\\share\\infer" })).toBe("\\\\srv\\share\\infer")
    expect(inferHome({ LOCAL_INFER_HOME: "/mnt/data/infer" })).toBe("/mnt/data/infer")
  })

  test("LOCAL_INFER_HOME 相对路径按 cwd 解析", () => {
    expect(inferHome({ LOCAL_INFER_HOME: "sub/infer" })).toBe(join(process.cwd(), "sub/infer"))
  })

  test("未配置时推导到子项目 infer/（不以分隔符结尾）", () => {
    const home = inferHome({})
    expect(home.endsWith(`${join("", "infer")}`)).toBe(true)
    expect(home.includes("agents")).toBe(false)
  })

  test("档位与模型路径挂在子项目根下", () => {
    expect(profilesPath("/x/infer")).toBe(join("/x/infer", "config", "profiles.json"))
  })

  test("模型目录缺省为子项目同级 resources 下（可被 LOCAL_INFER_MODELS_DIR 覆盖）", () => {
    expect(modelsDir("/x/infer", {})).toBe(resolve("/x/infer", "..", "resources", "models", "infer"))
    expect(modelsDir("/x/infer", { LOCAL_INFER_MODELS_DIR: "C:\\m" })).toBe("C:\\m")
  })
})

describe("档位定义读取", () => {
  test("正常读取", () => {
    const home = makeHome()
    writeFileSync(
      profilesPath(home),
      JSON.stringify({
        engine_dir: "vendor/engine",
        default_profile: "fast",
        default_model: "m.gguf",
        profiles: { fast: { model: "a.gguf", n_cpu_moe: 0 }, quality: { model: "b.gguf", n_cpu_moe: 8 } },
      }),
    )
    const p = loadProfiles(home)!
    expect(p.default_profile).toBe("fast")
    expect(profileModel(p, "fast")).toBe("a.gguf")
    expect(profileModel(p, "quality")).toBe("b.gguf")
  })

  test("档位未指定模型时回退到全局默认", () => {
    const home = makeHome()
    writeFileSync(
      profilesPath(home),
      JSON.stringify({ engine_dir: "e", default_profile: "x", default_model: "d.gguf", profiles: { x: {} } }),
    )
    expect(profileModel(loadProfiles(home)!, "x")).toBe("d.gguf")
  })

  test("文件缺失或损坏时返回 null（不抛错）", () => {
    const home = makeHome()
    expect(loadProfiles(home)).toBeNull()
    writeFileSync(profilesPath(home), "{ 不是 JSON")
    expect(loadProfiles(home)).toBeNull()
    writeFileSync(profilesPath(home), JSON.stringify({ engine_dir: "e" }))
    expect(loadProfiles(home)).toBeNull()
  })
})

describe("模型清单", () => {
  test("只列 GGUF，标注未完成下载，并按名称排序", () => {
    const dir = join(tmp, `models-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "b.gguf"), "x".repeat(32))
    writeFileSync(join(dir, "a.gguf.incomplete"), "x".repeat(16))
    writeFileSync(join(dir, "notes.txt"), "x")
    const list = listModels(dir)
    expect(list.map((m) => m.name)).toEqual(["a.gguf.incomplete", "b.gguf"])
    expect(list[0].incomplete).toBe(true)
    expect(list[1].incomplete).toBe(false)
    expect(list[1].gb).toBeGreaterThan(0)
  })

  test("目录不存在时返回空数组", () => {
    expect(listModels(join(tmp, "nope"))).toEqual([])
  })
})
