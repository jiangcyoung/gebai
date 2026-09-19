/**
 * 性能分析两个子Agent（`nsight` 与 `torch`）的**共装载与解耦守护测试**。
 *
 * 设计要求（两条硬约束，均在此锁定）：
 * 1. **可同时装载**：两者的对外工具名（`{agent}_{tool}`）必须互不重叠——宿主注册表对重名直接抛错，
 *    一旦出现同名，同时装载会失败。工具面各自演进时这条约束容易被无声打破，故用测试固定。
 * 2. **互不耦合**：任一面的源码不得引用另一面的模块（各自只依赖共用基建 `src/core/perf/` 与 SDK）。
 *    解耦让两者可独立装载、独立演进、独立排障（也保证任一面出错不牵连另一面）。
 *
 * 依赖检查按**路径解析**判定（而非正则匹配字符串），避免相对层级变化导致误判。
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const AGENTS_SRC = resolve(import.meta.dir, "..", "..", "agents")
const NSIGHT_DIR = join(AGENTS_SRC, "nsight")
const TORCH_DIR = join(AGENTS_SRC, "torch")
const CORE_DIR = resolve(import.meta.dir, "..")

const nsightDef = await import(join(NSIGHT_DIR, "nsight.ts"))
const torchDef = await import(join(TORCH_DIR, "torch.ts"))

/** 宿主注册表的对外命名规则：`{agent}_{tool}`（见 server/src/core/base/registry.ts）。 */
export function exposedToolNames(agent: string, tools: Record<string, unknown>): string[] {
  return Object.keys(tools).map((t) => `${agent}_${t}`)
}

/** 递归收集目录下的 TS 源码。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (e.name.endsWith(".ts")) out.push(p)
  }
  return out
}

const files = [
  ...sourceFiles(NSIGHT_DIR).map((p) => ({ p, owner: "nsight" as const })),
  ...sourceFiles(TORCH_DIR).map((p) => ({ p, owner: "torch" as const })),
]

describe("共装载：两个性能分析子Agent 的工具命名空间互不重叠", () => {
  test("对外工具名无交集，且前缀与所属面一致", () => {
    const nsightNames = exposedToolNames(nsightDef.name, nsightDef.tools as Record<string, unknown>)
    const torchNames = exposedToolNames(torchDef.name, torchDef.tools as Record<string, unknown>)
    expect(nsightDef.name).toBe("nsight")
    expect(torchDef.name).toBe("torch")
    for (const n of nsightNames) expect(n.startsWith("nsight_")).toBe(true)
    for (const n of torchNames) expect(n.startsWith("torch_")).toBe(true)
    // 交集必须为空——否则宿主注册表重名报错、同时装载失败
    expect(nsightNames.filter((n) => torchNames.includes(n))).toEqual([])
  })

  test("两面都注册了可执行的工具（不是空壳）", () => {
    for (const def of [nsightDef, torchDef]) {
      const entries = Object.entries(def.tools as Record<string, { execute?: unknown; description?: unknown }>)
      expect(entries.length).toBeGreaterThan(0)
      for (const [key, tool] of entries) {
        expect(typeof tool.execute, `${def.name}.${key} 应有 execute`).toBe("function")
        expect(String(tool.description ?? "").length, `${def.name}.${key} 应有描述`).toBeGreaterThan(10)
      }
    }
  })

  test("子Agent 名称符合作命名规则（小写字母/数字/下划线）", () => {
    for (const def of [nsightDef, torchDef]) expect(/^[a-z0-9_]+$/.test(def.name)).toBe(true)
  })
})

describe("解耦：两面互不引用，只依赖共用基建", () => {
  /** 收集文件的相对导入（解析为绝对路径），非相对导入另列。 */
  function importsOf(file: string): Array<{ spec: string; resolved?: string }> {
    const src = readFileSync(file, "utf8")
    return [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => {
      const spec = m[1]!
      return spec.startsWith(".") ? { spec, resolved: resolve(dirname(file), spec) } : { spec }
    })
  }

  test("任一面都不引用另一面的目录", () => {
    const violations: string[] = []
    for (const { p, owner } of files) {
      const other = owner === "nsight" ? TORCH_DIR : NSIGHT_DIR
      for (const imp of importsOf(p)) {
        if (!imp.resolved) continue
        const rel = relative(other, imp.resolved)
        if (!rel.startsWith("..") && !rel.includes(":")) violations.push(`${p} → ${imp.spec}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("两面的跨目录依赖只允许指向核心基建（src/core/）", () => {
    const violations: string[] = []
    for (const { p } of files) {
      const ownDir = dirname(p)
      for (const imp of importsOf(p)) {
        if (imp.resolved) {
          // 同目录内引用（相对路径不以 .. 开头）允许
          if (!imp.spec.startsWith("..")) continue
          const relToCore = relative(CORE_DIR, imp.resolved)
          if (relToCore.startsWith("..") || relToCore.includes(":")) violations.push(`${p} → ${imp.spec}`)
        } else if (!/^(@gebai\/|node:|bun:)/.test(imp.spec)) {
          violations.push(`${p} → ${imp.spec}（只允许 @gebai/*、node:*、bun:* 外部依赖）`)
        }
      }
      void ownDir
    }
    expect(violations).toEqual([])
  })

  test("共用基建自身不反向依赖任何分析面（core 不引用 agents）", () => {
    const violations: string[] = []
    for (const p of sourceFiles(import.meta.dir)) {
      for (const imp of importsOf(p)) {
        if (!imp.resolved) continue
        const rel = relative(AGENTS_SRC, imp.resolved)
        if (!rel.startsWith("..") && !rel.includes(":")) violations.push(`${p} → ${imp.spec}`)
      }
    }
    expect(violations).toEqual([])
  })
})
