/**
 * torch 原生后端的等价性测试。
 *
 * 目的：原生（Rust 边车）与 JS 回退实现必须**逐字段一致**——两者输出同构是回退安全的前提；
 * 一旦不一致，同一个 trace 在不同机器上会得出不同诊断（原生可用与否取决于是否构建过边车）。
 * 未构建边车时原生侧断言跳过（`nativeBinaryPath()` 返回 null），JS 路径照常覆盖。
 *
 * 夹具是**真实字段结构**的合成 trace（见 `test-fixture.ts`），覆盖步级/算子/内核/CUDA API/
 * 内存事件/fwdbwd 配对/correlation 归属/python 位置——只测结构不测分支的夹具会让本测试变成假通过。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { aggregateTorchTrace, type TorchFacts } from "./torch-trace"
import { coerceNativeFacts, NATIVE_AGGREGATE_TOOL } from "./torch-native"
import { makeRealisticTrace } from "./test-fixture"

/** 原生边车可执行文件路径（未构建时返回 null）。 */
export function nativeBinaryPath(): string | null {
  const repoRoot = resolve(import.meta.dir, "../../../../..")
  const exe = process.platform === "win32" ? "torch.exe" : "torch"
  const p = join(repoRoot, "keqing", "rust", "target", "release", exe)
  return existsSync(p) ? p : null
}

/** 归一化到 JSON 域（真实传输形态）：undefined 键会被 JSON 丢弃，两侧必须在同一口径下比。 */
function toJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v) ?? "null")
}

/** 深度比对两个事实对象，返回差异清单（数值按相对容差，数组顺序敏感）。 */
export function diffFacts(a: unknown, b: unknown, path = "", out: string[] = [], tol = 1e-9): string[] {
  if (typeof a === "number" && typeof b === "number") {
    const scale = Math.max(1e-12, Math.abs(a), Math.abs(b))
    if (Math.abs(a - b) / scale > tol) out.push(`${path}: 原生=${a} JS=${b}`)
    return out
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [...out, `${path}: 类型不符（原生=${typeof a} JS=${typeof b}）`]
    if (a.length !== b.length) out.push(`${path}: 长度 ${a.length} vs ${b.length}`)
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffFacts(a[i], b[i], `${path}[${i}]`, out, tol)
    return out
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort()
    const kb = Object.keys(b as Record<string, unknown>).sort()
    if (ka.join(",") !== kb.join(",")) out.push(`${path}: 键集不同（原生-only=${ka.filter((k) => !kb.includes(k))} JS-only=${kb.filter((k) => !ka.includes(k))}）`)
    for (const k of ka) if (kb.includes(k)) diffFacts((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, tol)
    return out
  }
  if (a !== b) out.push(`${path}: 原生=${JSON.stringify(a)} JS=${JSON.stringify(b)}`)
  return out
}

/** 按 keqing NDJSON 协议调用原生 aggregate 工具。 */
async function callNative(exe: string, path: string): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([exe], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const killer = setTimeout(() => proc.kill(), 120_000)
  proc.stdin.write(JSON.stringify({ id: 1, op: "init" }) + "\n")
  proc.stdin.write(JSON.stringify({ id: 2, op: "tool.call", tool: "aggregate", args: { path } }) + "\n")
  await proc.stdin.end()
  const text = await new Response(proc.stdout).text()
  clearTimeout(killer)
  const lines = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: number; ok: boolean; result?: Record<string, unknown>; error?: string })
  const res = lines.find((l) => l.id === 2)
  if (!res) throw new Error(`原生边车未响应：${text.slice(0, 300)}`)
  if (!res.ok) throw new Error(`原生边车报错：${res.error}`)
  const data = res.result?.data as Record<string, unknown> | undefined
  if (!data) throw new Error(`原生边车未返回 data：${text.slice(0, 300)}`)
  return data
}

const nativeExe = nativeBinaryPath()

describe("torch 原生后端接线（coerceNativeFacts 校验，不需要边车）", () => {
  test("工具名与 nsight 同款约定", () => {
    expect(NATIVE_AGGREGATE_TOOL).toBe("torch_aggregate")
  })

  test("字段缺失/类型不符即抛错（保证回退而不是脏数据）", () => {
    const jsFacts = {
      source: "x",
      scanMs: 1,
      scale: { events: 1, scannedChars: 2, byCategory: {}, processes: [], threads: 1, flags: {} },
      hasGpuEvents: false,
      hasMemoryEvents: false,
      steps: [],
      stepStats: { count: 0, avgUs: 0, medianUs: 0, p90Us: 0, minUs: 0, maxUs: 0 },
      categories: [],
      ops: [],
      kernels: [],
      cudaApis: [],
      annotations: [],
      opGroups: 0,
      kernelGroups: 0,
      transfers: [],
      transferCount: 0,
      transferBytes: 0,
      memory: { available: false, events: 0, allocCount: 0, freeCount: 0, peakAllocatedBytes: 0, peakReservedBytes: 0 },
      timeline: {
        spanUs: 0,
        cpuBusyUs: 0,
        cpuUtilization: 0,
        gpuBusyUs: 0,
        gpuUtilization: 0,
        gpuGapCount: 0,
        gpuGapTotalUs: 0,
        overlapUs: 0,
        gpuGaps: [],
        cpuSeries: [],
        gpuSeries: [],
      },
      pythonSites: [],
      kernelAttribution: [],
      fwdBwd: { available: false, marks: 0, linked: 0, forwardUs: 0, backwardUs: 0, backwardShare: 0, perStep: [], samples: [] },
      flows: { available: false, pairs: 0, kernelLinks: 0 },
      notes: [],
    }
    expect(() => coerceNativeFacts(jsFacts as unknown as Record<string, unknown>)).not.toThrow()
    // 顶层缺 ops
    const noOps = { ...jsFacts, ops: undefined }
    expect(() => coerceNativeFacts(noOps as unknown as Record<string, unknown>)).toThrow(/ops/)
    // timeline 缺关键数值（会让诊断静默漏判）
    const badTimeline = { ...jsFacts, timeline: { ...jsFacts.timeline, gpuBusyUs: undefined } }
    expect(() => coerceNativeFacts(badTimeline as unknown as Record<string, unknown>)).toThrow(/gpuBusyUs/)
    // memory 关键字段缺失（防「看起来有值其实读不到」）
    const badMemory = { ...jsFacts, memory: { ...jsFacts.memory, peakAllocatedBytes: undefined } }
    expect(() => coerceNativeFacts(badMemory as unknown as Record<string, unknown>)).toThrow(/peakAllocatedBytes/)
    // fwdBwd.available 类型不符
    const badFwd = { ...jsFacts, fwdBwd: { ...jsFacts.fwdBwd, available: "yes" } }
    expect(() => coerceNativeFacts(badFwd as unknown as Record<string, unknown>)).toThrow(/fwdBwd\.available/)
  })
})

describe("torch 原生后端等价性（真实字段结构合成 trace）", () => {
  test.skipIf(!nativeExe)("原生与 JS 逐字段一致：规模/步级/算子/内核/显存/时间线/fwdbwd/flows/归属/python 位置", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-native-eq-"))
    const path = join(dir, "realistic.pt.trace.json")
    makeRealisticTrace(path, 5, 8)
    try {
      const jsFacts: TorchFacts = await aggregateTorchTrace(path, { budgetMs: 0 })
      const nativeRaw = await callNative(nativeExe!, path)
      const nativeFacts = coerceNativeFacts(nativeRaw)
      // scanMs 为耗时度量，两侧天然不同——比对时排除（其余必须逐字段一致）
      // 归一化到 JSON 域：原生经协议传输，undefined 键本就不存在；JS 侧对象可能带 undefined 键，
      // 不归一化会得到「假差异」（比的是序列化前的对象，而非两边实际拿到的数据）。
      const diffs = diffFacts(
        toJson({ ...(nativeFacts as unknown as Record<string, unknown>), scanMs: 0 }),
        toJson({ ...(jsFacts as unknown as Record<string, unknown>), scanMs: 0 }),
      )
      expect(diffs.join("\n")).toBe("")
      // 关键维度确实被覆盖到（防「都空所以一致」的假通过）
      expect(jsFacts.scale.events).toBeGreaterThan(10)
      expect(jsFacts.ops.length).toBeGreaterThan(0)
      expect(jsFacts.steps.length).toBe(5)
      expect(jsFacts.fwdBwd.marks).toBeGreaterThan(0)
      expect(jsFacts.memory.events).toBeGreaterThan(0)
      expect(jsFacts.pythonSites.length).toBeGreaterThan(0)
      expect(jsFacts.cudaApis.length).toBeGreaterThan(0)
      expect(jsFacts.kernelAttribution.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
