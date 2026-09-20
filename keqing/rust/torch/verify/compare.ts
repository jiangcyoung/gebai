/**
 * 原生聚合后端 vs TS 实现的**逐字段等价性验证 + 吞吐/RSS 实测**。
 *
 * 用法（在仓库根或本目录均可）：
 *   bun keqing/rust/torch/verify/compare.ts            # 全部三个输入
 *   bun keqing/rust/torch/verify/compare.ts real       # 只跑真实 trace
 *   bun keqing/rust/torch/verify/compare.ts gz synth
 *
 * 三个输入：
 *   1. real  —— 真实 trace（含 fwdbwd/flows/python_function）
 *   2. gz    —— 其 gzip 形态（临时目录自建）
 *   3. synth —— 真实字段结构的合成大文件（默认 105 万事件；`TORCH_VERIFY_EVENTS` 可改）
 *
 * 比对口径：
 *   - 两侧结果先经 `JSON.parse(JSON.stringify(x))` 归一（TS 侧的 NaN/Infinity→null、undefined 键丢弃，
 *     正是协议上 JSON 的语义），再递归比对；
 *   - 数值：先比精确相等，不等时按相对容差 1e-9 判定「近似一致」（记录最大相对偏差）；
 *   - 数组：顺序与长度必须一致；对象：键集合与值都要一致（多出/缺少字段均为不一致）；
 *   - `scanMs` 是两侧各自的墙钟耗时，声明为**不可比对**字段，单独打印。
 */
import { existsSync, mkdirSync, statSync, createWriteStream } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { aggregateTorchTrace } from "../../../../packages/agents/src/agents/torch/torch-trace"

const REPO = resolve(import.meta.dir, "../../../..")
const EXE = join(REPO, "keqing/rust/target/release/torch.exe")
const REAL = join(
  REPO,
  "users/admin/sessions/c9/f0/c9f0c63d238146c09b565eceee6522b1/tmp/torch-probe/real-cpu.pt.trace.json",
)
const ARTIFACTS = process.env.TORCH_VERIFY_DIR ?? join(tmpdir(), "gebai-torch-verify")
const SYNTH_EVENTS = Number(process.env.TORCH_VERIFY_EVENTS ?? 1_050_000)
const TOL = 1e-9

// ------------------------------------------------------------------ 工具

const mb = (n: number): string => (n / 1048576).toFixed(1)

/** 查询进程峰值工作集（Windows：PeakWorkingSet64；非 Windows 返回 0）。 */
function peakRssMb(pid: number): number {
  if (process.platform !== "win32") return 0
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PeakWorkingSet64`], {
      encoding: "utf8",
    })
    const v = Number(String(r.stdout).trim())
    return Number.isFinite(v) && v > 0 ? v / 1048576 : 0
  } catch {
    return 0
  }
}

interface NativeCall {
  data: Record<string, unknown>
  output: string
  wallMs: number
  peakRssMb: number
}

/** 按 keqing NDJSON 协议调用原生 `aggregate` 工具。 */
async function callNative(path: string, budgetMs = 0): Promise<NativeCall> {
  const proc = Bun.spawn([EXE], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const t0 = performance.now()
  proc.stdin.write(JSON.stringify({ id: 1, op: "init" }) + "\n")
  proc.stdin.write(
    JSON.stringify({
      id: 2,
      op: "tool.call",
      tool: "aggregate",
      args: { path, budget_ms: budgetMs },
      ctx: { cwd: REPO, sessionId: "verify", user: "verify", env: {}, sandboxed: false },
    }) + "\n",
  )
  proc.stdin.flush()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let line: string | null = null
  while (line === null) {
    const nl = buf.indexOf("\n")
    if (nl >= 0) {
      const l = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const msg = JSON.parse(l) as { id?: number }
      if (msg.id === 2) {
        line = l
        break
      }
      continue
    }
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  const wallMs = performance.now() - t0
  const peak = peakRssMb(proc.pid)
  reader.releaseLock()
  proc.stdin.end()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  if (!line) throw new Error(`边车无响应（stderr: ${stderr.slice(0, 400)}）`)
  const msg = JSON.parse(line) as {
    ok?: boolean
    error?: string
    result?: { output?: string; data?: Record<string, unknown> }
  }
  if (msg.ok === false) throw new Error(`边车报错：${msg.error}`)
  const data = msg.result?.data
  if (!data) throw new Error("边车未返回结构化数据")
  return { data, output: msg.result?.output ?? "", wallMs, peakRssMb: peak }
}

// ------------------------------------------------------------------ 逐字段比对

interface DiffItem {
  path: string
  expected: unknown
  actual: unknown
  reason: string
}

interface DiffStat {
  exact: number
  tolerated: number
  maxRel: number
  maxRelPath: string
}

const short = (v: unknown): string => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)
  return s === undefined ? String(v) : s.length > 160 ? `${s.slice(0, 160)}…` : s
}

function diff(expected: unknown, actual: unknown, path: string, out: DiffItem[], st: DiffStat): void {
  if (expected === actual) {
    st.exact++
    return
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isFinite(expected) && Number.isFinite(actual)) {
      const rel = Math.abs(expected - actual) / Math.max(Math.abs(expected), Math.abs(actual), Number.MIN_VALUE)
      if (rel <= TOL) {
        st.tolerated++
        if (rel > st.maxRel) {
          st.maxRel = rel
          st.maxRelPath = path
        }
        return
      }
      out.push({ path, expected, actual, reason: `数值差异（rel=${rel.toExponential(3)}）` })
      return
    }
    out.push({ path, expected, actual, reason: "非有限数值不一致" })
    return
  }
  if (expected === null || actual === null) {
    out.push({ path, expected, actual, reason: "null 与非 null 不一致" })
    return
  }
  const ea = Array.isArray(expected)
  const aa = Array.isArray(actual)
  if (ea !== aa) {
    out.push({ path, expected, actual, reason: "数组/对象形态不一致" })
    return
  }
  if (ea && aa) {
    const e = expected as unknown[]
    const a = actual as unknown[]
    if (e.length !== a.length) {
      out.push({ path, expected: `长度 ${e.length}`, actual: `长度 ${a.length}`, reason: "数组长度不一致" })
    }
    for (let i = 0; i < Math.min(e.length, a.length); i++) diff(e[i], a[i], `${path}[${i}]`, out, st)
    return
  }
  if (typeof expected === "object" && typeof actual === "object") {
    const e = expected as Record<string, unknown>
    const a = actual as Record<string, unknown>
    const keys = new Set([...Object.keys(e), ...Object.keys(a)])
    for (const k of keys) {
      if (!(k in e)) {
        out.push({ path: `${path}.${k}`, expected: "<缺失>", actual: a[k], reason: "原生多出字段" })
        continue
      }
      if (!(k in a)) {
        out.push({ path: `${path}.${k}`, expected: e[k], actual: "<缺失>", reason: "原生缺少字段" })
        continue
      }
      diff(e[k], a[k], `${path}.${k}`, out, st)
    }
    return
  }
  out.push({ path, expected, actual, reason: `类型不一致（${typeof expected} vs ${typeof actual}）` })
}

/** TS 事实 vs 原生 data：跳过声明为不可比对的字段（耗时）。 */
function compareFacts(tsFacts: unknown, nativeData: Record<string, unknown>): { diffs: DiffItem[]; st: DiffStat } {
  const expected = JSON.parse(JSON.stringify(tsFacts)) as Record<string, unknown>
  const actual = JSON.parse(JSON.stringify(nativeData)) as Record<string, unknown>
  const st: DiffStat = { exact: 0, tolerated: 0, maxRel: 0, maxRelPath: "" }
  const out: DiffItem[] = []
  const skip = new Set(["scanMs"])
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const k of keys) {
    if (skip.has(k)) continue
    if (!(k in expected)) {
      out.push({ path: k, expected: "<缺失>", actual: actual[k], reason: "原生多出字段" })
      continue
    }
    if (!(k in actual)) {
      out.push({ path: k, expected: expected[k], actual: "<缺失>", reason: "原生缺少字段" })
      continue
    }
    diff(expected[k], actual[k], k, out, st)
  }
  return { diffs: out, st }
}

// ------------------------------------------------------------------ 合成大文件

/** 合成大文件（分块写出；块间与块内元素统一加逗号）。 */
async function makeSyntheticFixed(outPath: string, events: number): Promise<void> {
  const real = JSON.parse(await Bun.file(REAL).text()) as { traceEvents: Record<string, unknown>[] }
  const templates = real.traceEvents
  const stream = createWriteStream(outPath)
  const write = (s: string) =>
    new Promise<void>((res, rej) => {
      stream.write(s, (err) => (err ? rej(err) : res()))
    })
  await write(
    '{"schemaVersion":1,"deviceProperties":[],"record_shapes":1,"profile_memory":1,"with_stack":1,"displayTimeUnit":"ms","traceEvents":[',
  )
  let rng = 0x1234abcd
  const rnd = () => {
    rng ^= rng << 13
    rng >>>= 0
    rng ^= rng >> 17
    rng ^= rng << 5
    rng >>>= 0
    return rng / 4294967296
  }
  const SPAN = 2_000_000
  const parts: string[] = []
  for (let i = 0; i < events; i++) {
    const t = templates[i % templates.length]!
    const cycle = Math.floor(i / templates.length)
    const ev: Record<string, unknown> = { ...t }
    if (typeof ev.ts === "number") ev.ts = (ev.ts as number) + cycle * SPAN + (i % 7) * 0.25
    if (typeof ev.dur === "number") ev.dur = Math.round((ev.dur as number) * (0.5 + rnd()) * 1000) / 1000
    if (typeof ev.id === "number") ev.id = (ev.id as number) + (i % 97)
    parts.push(JSON.stringify(ev))
    if (parts.length >= 2000) {
      await write(parts.join(",") + ",")
      parts.length = 0
    }
  }
  if (parts.length) await write(parts.join(","))
  await write("]}")
  stream.end()
  await new Promise<void>((res) => stream.once("close", () => res()))
}

// ------------------------------------------------------------------ 单目标验证

async function verifyOne(
  label: string,
  path: string,
  opts: { tsAllowed?: boolean } = {},
): Promise<boolean> {
  if (!existsSync(path)) {
    console.log(`\n### ${label}：文件不存在，跳过 —— ${path}`)
    return false
  }
  const size = statSync(path).size
  console.log(`\n${"=".repeat(78)}\n### ${label}：${path}\n规模：${mb(size)} MB`)
  const native = await callNative(path)
  const nativeEvents = Number((native.data.scale as Record<string, unknown>)?.events ?? 0)
  const nativeScanMs = Number(native.data.scanMs)
  console.log(
    `原生：墙钟 ${native.wallMs.toFixed(1)} ms（自报 scanMs ${nativeScanMs.toFixed(1)} ms）｜` +
      `吞吐 ${(size / 1048576 / (nativeScanMs / 1000)).toFixed(1)} MB/s、` +
      `${(nativeEvents / (nativeScanMs / 1000) / 1000).toFixed(0)} K 事件/s｜峰值 RSS ${native.peakRssMb.toFixed(0)} MB`,
  )
  console.log(`原生 output：${native.output}`)

  if (opts.tsAllowed === false) return true

  let tsFacts: unknown
  let tsMs = 0
  let tsPeak = 0
  {
    let peak = 0
    const timer = setInterval(() => {
      const rss = process.memoryUsage().rss
      if (rss > peak) peak = rss
    }, 25)
    const t0 = performance.now()
    tsFacts = await aggregateTorchTrace(path, { budgetMs: 0 })
    tsMs = performance.now() - t0
    const rss = process.memoryUsage().rss
    if (rss > peak) peak = rss
    clearInterval(timer)
    tsPeak = peak / 1048576
  }
  const tsEvents = Number((tsFacts as { scale: { events: number } }).scale.events)
  console.log(
    `TS  ：${tsMs.toFixed(1)} ms｜吞吐 ${(size / 1048576 / (tsMs / 1000)).toFixed(1)} MB/s、` +
      `${(tsEvents / (tsMs / 1000) / 1000).toFixed(0)} K 事件/s｜进程 RSS 峰值 ~${tsPeak.toFixed(0)} MB（含脚本自身）`,
  )
  console.log(
    `加速比：${(tsMs / nativeScanMs).toFixed(1)}×（TS 墙钟 / 原生自报 scanMs）`,
  )

  const { diffs, st } = compareFacts(tsFacts, native.data)
  console.log(
    `比对：精确一致 ${st.exact} 项，容差内 ${st.tolerated} 项（最大相对偏差 ${st.maxRel.toExponential(3)} @ ${st.maxRelPath || "-"}），不一致 ${diffs.length} 项`,
  )
  console.log(
    `非比对字段：scanMs TS=${Number((tsFacts as { scanMs: number }).scanMs).toFixed(1)} ms / 原生=${nativeScanMs.toFixed(1)} ms`,
  )
  if (diffs.length) {
    console.log(`不一致清单（最多打印 40 条）：`)
    for (const d of diffs.slice(0, 40)) {
      console.log(`  ✗ ${d.path}　${d.reason}\n      TS=${short(d.expected)}\n      原生=${short(d.actual)}`)
    }
    if (diffs.length > 40) console.log(`  … 其余 ${diffs.length - 40} 条省略`)
    return false
  }
  console.log("✓ 逐字段一致")
  return true
}

// ------------------------------------------------------------------ 入口

async function main(): Promise<void> {
  if (!existsSync(EXE)) {
    console.log(`原生边车未构建：${EXE}\n请先运行：cargo build --release -p torch --manifest-path keqing/rust/Cargo.toml`)
    process.exit(2)
  }
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true })
  const gzPath = join(ARTIFACTS, "real-cpu.pt.trace.json.gz")
  if (!existsSync(gzPath)) {
    const raw = await Bun.file(REAL).arrayBuffer()
    await Bun.write(gzPath, Bun.gzipSync(new Uint8Array(raw)))
    console.log(`已生成 gz 形态：${gzPath}（${mb(statSync(gzPath).size)} MB）`)
  }
  const synthPath = join(ARTIFACTS, `synthetic-${SYNTH_EVENTS}.json`)
  if (!existsSync(synthPath) || statSync(synthPath).size < 1024) {
    const t0 = performance.now()
    await makeSyntheticFixed(synthPath, SYNTH_EVENTS)
    console.log(`已生成合成大文件：${synthPath}（${mb(statSync(synthPath).size)} MB，${((performance.now() - t0) / 1000).toFixed(1)}s）`)
  }

  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  const want = (k: string): boolean => !only.length || only.includes(k)
  const results: Array<[string, boolean]> = []
  if (want("real")) results.push(["real（真实 trace）", await verifyOne("real（真实 trace）", REAL)])
  if (want("gz")) results.push(["gz（真实 trace 的 gzip 形态）", await verifyOne("gz（真实 trace 的 gzip 形态）", gzPath)])
  if (want("synth")) results.push([`synth（合成 ${SYNTH_EVENTS} 事件）`, await verifyOne(`synth（合成 ${SYNTH_EVENTS} 事件）`, synthPath)])

  console.log(`\n${"=".repeat(78)}\n汇总：`)
  for (const [k, ok] of results) console.log(`  ${ok ? "✓" : "✗"} ${k}`)
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}

await main()
