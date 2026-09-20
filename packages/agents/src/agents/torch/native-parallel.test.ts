/**
 * torch 原生后端**分块并行**的等价性测试。
 *
 * 目的：`TORCH_NATIVE_THREADS=1`（单趟直接路径）与 `=N`（分块采集 + 有序归并）必须**逐字段一致**。
 * 分块把顺序依赖状态（浅栈自身耗时、采样器蓄水池、时间线并集/分桶、显存活跃集与 TopK、
 * flow 配对与全局活动、correlation 启发表）拆成「块内记日志 + 归并阶段按全局序回放」，
 * 任何漏回放、漏携带（跨块帧、跨块活动）都会在这里暴露成字段差异。
 *
 * 为什么需要这个测试：JS 等价性测试（native.test.ts）覆盖的是**默认路径**——小文件走单趟，
 * 因此并行路径的正确性必须由「同二进制、改块数」的 A/B 来守（这也是本项目对等价性的口径：
 * 数值按相对 1e-9 容差，其余逐字段精确）。
 *
 * 未构建边车时全部跳过（`nativeBinaryPath()` 返回 null）；块数用 64 之类的大值是为了让
 * 小夹具里也出现大量块边界（嵌套帧跨块、乱序 ts 跨块等）。
 */
import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffFacts, nativeBinaryPath } from "./native.test"
import { makeRealisticTrace } from "./test-fixture"

const nativeExe = nativeBinaryPath()

/** 按指定块数调用原生 aggregate（TORCH_NATIVE_THREADS 是并行度的唯一开关）。 */
async function runNative(exe: string, path: string, threads: number): Promise<Record<string, unknown>> {
  const proc = Bun.spawn([exe], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TORCH_NATIVE_THREADS: String(threads) },
  })
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

/** 归一化到 JSON 域（与 native.test.ts 的等价性比对同口径）。 */
function toJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v) ?? "null")
}

/** 单趟 vs 并列块数逐字段比对（scanMs 是耗时度量，排除）。 */
async function expectSameAsSingleThread(exe: string, path: string, threadOptions: number[]): Promise<Record<string, unknown>> {
  const single = toJson(await runNative(exe, path, 1)) as Record<string, unknown>
  for (const t of threadOptions) {
    const par = toJson(await runNative(exe, path, t)) as Record<string, unknown>
    const diffs = diffFacts({ ...single, scanMs: 0 }, { ...par, scanMs: 0 })
    expect(`${t} 块：\n${diffs.join("\n")}`).toBe(`${t} 块：\n`)
  }
  return single
}

/** 对抗夹具：嵌套帧跨块 + 乱序 ts + flow/fwdbwd + 显存 + correlation + 多线程。 */
function makeAdversarialTrace(path: string): void {
  const ev: string[] = []
  const pad = "    "
  const mk = (body: string): string => `{\n${pad}${body}\n  }`
  let ts = 6_866_517_959_465.076
  let corr = 1
  let flowId = 100
  // 多线程/多进程：同一进程三线程 + 一个 kernel 线程
  for (let w = 0; w < 3; w++) {
    ev.push(mk(`"ph": "M",\n${pad}"name": "thread_name",\n${pad}"pid": 4964,\n${pad}"tid": ${22044 + w},\n${pad}"args": {\n${pad}${pad}"name": "worker${w}"\n${pad}}`))
  }
  for (let i = 0; i < 600; i++) {
    const tid = 22044 + (i % 3)
    // 外层帧：跨越大量后续事件（必跨块）
    if (i % 40 === 0) {
      ev.push(mk(`"ph": "X",\n${pad}"cat": "python_function",\n${pad}"name": "train.py(${i}): outer",\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${ts.toFixed(3)},\n${pad}"dur": 4200`))
    }
    const dur = 30 + ((i * 37) % 260)
    ev.push(mk(`"ph": "X",\n${pad}"cat": "cpu_op",\n${pad}"name": "aten::op${i % 5}",\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${(ts + 2).toFixed(3)},\n${pad}"dur": ${(dur - 4).toFixed(3)},\n${pad}"args": {\n${pad}${pad}"Input Dims": [[4, 32]], "Input type": ["float"]\n${pad}}`))
    // 乱序：反向算子写在两个时间点之外，触发「与栈顶不成包含关系 → 清栈」分支
    ev.push(mk(`"ph": "X",\n${pad}"cat": "cpu_op",\n${pad}"name": "AddmmBackward0",\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${(ts + dur).toFixed(3)},\n${pad}"dur": ${(dur * 0.6).toFixed(3)}`))
    const fid = flowId++
    ev.push(mk(`"ph": "s",\n${pad}"cat": "fwdbwd",\n${pad}"name": "fwdbwd",\n${pad}"id": ${fid},\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${(ts + 2).toFixed(3)}`))
    if (i % 4 !== 0) {
      ev.push(mk(`"ph": "f",\n${pad}"cat": "fwdbwd",\n${pad}"name": "fwdbwd",\n${pad}"id": ${fid},\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${(ts + dur).toFixed(3)}`))
    }
    ev.push(mk(`"ph": "X",\n${pad}"cat": "cuda_runtime",\n${pad}"name": "cudaLaunchKernel",\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${(ts + 6).toFixed(3)},\n${pad}"dur": 4.5,\n${pad}"args": {\n${pad}${pad}"correlation": ${corr}\n${pad}}`))
    ev.push(mk(`"ph": "X",\n${pad}"cat": "kernel",\n${pad}"name": "sm90_gemm",\n${pad}"pid": 0,\n${pad}"tid": 7,\n${pad}"ts": ${(ts + 16).toFixed(3)},\n${pad}"dur": ${(dur * 0.5).toFixed(3)},\n${pad}"args": {\n${pad}${pad}"correlation": ${corr}, "stream": 7, "device": 0, "grid": [128, 1, 1], "block": [256, 1, 1], "shared memory": 49152\n${pad}}`))
    corr++
    if (i % 3 === 0) {
      ev.push(mk(`"ph": "i",\n${pad}"cat": "cpu_instant_event",\n${pad}"s": "t",\n${pad}"name": "[memory]",\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${ts.toFixed(3)},\n${pad}"args": {\n${pad}${pad}"Device Id": ${i % 2}, "Bytes": ${i % 7 === 0 ? -2048 : 4096}, "Addr": ${9000 + (i % 50)}, "Total Allocated": ${1 << 20}, "Total Reserved": ${1 << 21}\n${pad}}`))
    }
    if (i % 50 === 0) {
      ev.push(mk(`"ph": "X",\n${pad}"cat": "user_annotation",\n${pad}"name": "ProfilerStep#${i / 50 + 1}",\n${pad}"pid": 4964,\n${pad}"tid": ${tid},\n${pad}"ts": ${ts.toFixed(3)},\n${pad}"dur": 800`))
    }
    ts += dur + 3
  }
  const head = `{\n    "schemaVersion": 1,\n    "record_shapes": 1,\n    "profile_memory": 1,\n    "with_stack": 1,\n    "traceEvents": [\n`
  writeFileSync(path, `${head}${ev.join(",\n")}\n]}`)
}

describe("torch 原生后端分块并行（单趟 vs 多块逐字段一致）", () => {
  test.skipIf(!nativeExe)("真实结构夹具：2/8/64 块与单趟完全一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-par-"))
    const path = join(dir, "realistic.pt.trace.json")
    makeRealisticTrace(path, 8, 9)
    try {
      const single = await expectSameAsSingleThread(nativeExe!, path, [2, 8, 64])
      // 防「都空所以一致」的假通过：关键维度必须有内容
      const scale = single.scale as { events: number }
      expect(scale.events).toBeGreaterThan(50)
      expect((single.ops as unknown[]).length).toBeGreaterThan(0)
      expect((single.kernelAttribution as unknown[]).length).toBeGreaterThan(0)
      expect((single.pythonSites as unknown[]).length).toBeGreaterThan(0)
      expect((single.memory as { events: number }).events).toBeGreaterThan(0)
      expect((single.fwdBwd as { marks: number }).marks).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!nativeExe)("对抗夹具：跨块嵌套帧 / 乱序清栈 / 流事件 / 显存 / 多线程：3/16 块一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-par-adv-"))
    const path = join(dir, "adv.pt.trace.json")
    makeAdversarialTrace(path)
    try {
      const single = await expectSameAsSingleThread(nativeExe!, path, [3, 16])
      const timeline = single.timeline as { cpuBusyUs: number; gpuBusyUs: number; gpuGapCount: number }
      expect(timeline.cpuBusyUs).toBeGreaterThan(0)
      expect(timeline.gpuBusyUs).toBeGreaterThan(0)
      expect((single.kernelAttribution as unknown[]).length).toBeGreaterThan(0)
      expect((single.scale as { threads: number }).threads).toBeGreaterThan(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(!nativeExe)("gz 形态：gzip 解压后的分块边界与单趟一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-torch-par-gz-"))
    const plain = join(dir, "t.pt.trace.json")
    const gz = `${plain}.gz`
    makeRealisticTrace(plain, 6, 7)
    const { readFileSync } = await import("node:fs")
    writeFileSync(gz, gzipSync(readFileSync(plain)))
    try {
      await expectSameAsSingleThread(nativeExe!, gz, [2, 8])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
