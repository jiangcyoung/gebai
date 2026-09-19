/**
 * 增量 JSON 扫描器（nsight 专用）：从超大 JSON 文件中**流式抽取对象数组元素**——
 * PyTorch Profiler / Kineto 的 Chrome Trace 形如 `{"traceEvents": [ {...}, {...} ], ...}`，
 * 可达 GB 级，整文件 `JSON.parse` 会一次性物化全部事件对象（内存与文件同阶），
 * 本扫描器只维持常量状态：定位目标数组后逐个元素切片，交由调用方解析或字段提取。
 *
 * 实现取向（依实测选定，非凭直觉）：
 * - 扫描用**单趟 `charCodeAt` 状态机**（数字比较，不产生中间字符串）。同一 200 MB 样本实测：
 *   `charCodeAt` 循环 384 MB/s；`buf[i]` 逐字符（每字符生成 1 字符字符串）约 26 MB/s；
 *   「每次迭代对 5 个定界符各做一次 `indexOf`」因反复回扫只有 36 MB/s——**跳转并非总是更快**；
 * - 元素切片用 `slice`（实测 4.4 GB/s），仅在元素边界调用；
 * - **按批产出**（默认 4096 元素/批）：逐元素 `yield` 在千万级事件下会付出大量异步迭代开销；
 * - 缓冲滚动：已消费前缀定期丢弃，内存与文件规模解耦。
 *
 * 支持 gzip（`*.pt.trace.json.gz`：TensorBoard trace handler 的默认产物）——解码与解析流水化，不落中间文件。
 */

const QUOTE = 34
const BACKSLASH = 92
const BRACE_OPEN = 123
const BRACE_CLOSE = 125
const BRACKET_OPEN = 91
const BRACKET_CLOSE = 93
const COLON = 58
const COMMA = 44
const SPACE = 32
const TAB = 9
const LF = 10
const CR = 13

const isWs = (c: number): boolean => c === SPACE || c === LF || c === CR || c === TAB

/** 文本分块（含可选 gzip 解压），供扫描器消费。 */
export async function* textChunks(path: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<string> {
  const raw = Bun.file(path).stream() as unknown as ReadableStream<Uint8Array>
  const gunzip = new DecompressionStream("gzip")
  const stream: ReadableStream<Uint8Array> = /\.gz$/i.test(path)
    ? (raw.pipeThrough(gunzip as unknown as TransformStream<Uint8Array, Uint8Array>) as unknown as ReadableStream<Uint8Array>)
    : raw
  const decoder = new TextDecoder("utf-8")
  const reader = stream.getReader()
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error("扫描已中断")
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield decoder.decode(value, { stream: true })
    }
    const tail = decoder.decode()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

export interface JsonArrayScanOptions {
  /** 目标数组键名（默认 `traceEvents`）。 */
  key?: string
  /** 单个元素的字符上限（超过即判定格式异常，防脏文件把内存吃满）。 */
  maxItemChars?: number
  /** 每批产出的元素数（默认 4096）。 */
  batchSize?: number
  signal?: AbortSignal
}

export interface JsonArrayScanStats {
  /** 已扫描的字符数（进度与规模统计）。 */
  scannedChars: number
  /** 已产出的元素数。 */
  items: number
  /** 是否命中目标数组（未命中说明不是预期格式）。 */
  found: boolean
}

export interface JsonArrayBatch {
  /** 本批元素的原始 JSON 文本（元素间逗号与空白已剥离）。 */
  texts: string[]
  stats: JsonArrayScanStats
}

/**
 * 按批产出目标数组的元素原始 JSON 文本。
 * 状态机：定位 `"<key>"` → `:` → `[` → 按括号深度与字符串状态切出每个顶层元素 → `]` 结束。
 */
export async function* scanJsonArrayItems(
  path: string,
  opts: JsonArrayScanOptions = {},
): AsyncGenerator<JsonArrayBatch, JsonArrayScanStats, void> {
  const key = `"${opts.key ?? "traceEvents"}"`
  const keyCodes = new Uint8Array(key.length)
  for (let i = 0; i < key.length; i++) keyCodes[i] = key.charCodeAt(i)
  const maxItemChars = opts.maxItemChars ?? 64 * 1024 * 1024
  const batchTarget = Math.max(1, opts.batchSize ?? 4_096)
  const stats: JsonArrayScanStats = { scannedChars: 0, items: 0, found: false }

  const chunks = textChunks(path, { signal: opts.signal })
  let buf = ""
  let dropped = 0
  let pos = 0
  /** 0=找键 1=找数组起点 2=数组内 3=结束 */
  let state = 0
  let keyMatch = 0
  let inElement = false
  let depth = 0
  let inString = false
  let escaped = false
  let elementStart = -1
  let ended = false
  let batch: string[] = []
  let batchesSinceGc = 0

  const flush = (): JsonArrayBatch | null => {
    if (!batch.length) return null
    const out = batch
    batch = []
    // 每若干批提示一次回收：元素文本是短命大对象，不提示时 RSS 会明显高于实际活跃集
    batchesSinceGc++
    if (batchesSinceGc >= 256) {
      batchesSinceGc = 0
      Bun.gc(false)
    }
    return { texts: out, stats }
  }

  for (;;) {
    const n = buf.length
    let consumedTo = pos
    while (pos < n) {
      const c = buf.charCodeAt(pos)
      if (state === 0) {
        if (c === keyCodes[keyMatch]!) {
          keyMatch++
          pos++
          if (keyMatch === keyCodes.length) {
            state = 1
            keyMatch = 0
          }
        } else {
          keyMatch = c === keyCodes[0]! ? 1 : 0
          pos++
        }
        continue
      }
      if (state === 1) {
        if (c === BRACKET_OPEN) {
          state = 2
          stats.found = true
          pos++
          continue
        }
        if (c === COLON || isWs(c)) {
          pos++
          continue
        }
        state = 0
        keyMatch = 0
        continue
      }
      if (state === 3) {
        pos = n
        break
      }
      // state === 2：数组内
      if (!inElement) {
        if (isWs(c) || c === COMMA) {
          pos++
          continue
        }
        if (c === BRACKET_CLOSE) {
          state = 3
          pos++
          continue
        }
        inElement = true
        elementStart = pos
        depth = 0
        inString = false
        escaped = false
      }
      if (inString) {
        if (escaped) escaped = false
        else if (c === BACKSLASH) escaped = true
        else if (c === QUOTE) inString = false
        pos++
        continue
      }
      if (c === QUOTE) {
        inString = true
        pos++
        continue
      }
      if (c === BRACE_OPEN || c === BRACKET_OPEN) {
        depth++
        pos++
        continue
      }
      if (c === BRACE_CLOSE || c === BRACKET_CLOSE) {
        depth--
        pos++
        if (depth === 0) {
          const text = buf.slice(elementStart, pos)
          if (text.length > maxItemChars) {
            throw new Error(`trace 元素超过 ${Math.round(maxItemChars / 1048576)} MB 上限，疑似格式异常（键：${opts.key ?? "traceEvents"}）`)
          }
          stats.items++
          stats.scannedChars = dropped + pos
          inElement = false
          elementStart = -1
          consumedTo = pos
          batch.push(text)
          if (batch.length >= batchTarget) {
            const out = flush()!
            yield out
          }
          continue
        }
        if (depth < 0) {
          // 结构异常（多余闭合符）：结束数组，避免误吞后续内容
          inElement = false
          elementStart = -1
          state = 3
          continue
        }
        continue
      }
      // 顶层标量元素：以分隔符结束
      if (depth === 0 && (c === COMMA || c === BRACKET_CLOSE || isWs(c))) {
        const text = buf.slice(elementStart, pos)
        stats.items++
        stats.scannedChars = dropped + pos
        inElement = false
        elementStart = -1
        batch.push(text)
        if (batch.length >= batchTarget) {
          const out = flush()!
          yield out
        }
        if (c === BRACKET_CLOSE) {
          state = 3
          pos++
        } else if (c === COMMA) {
          pos++
        }
        consumedTo = pos
        continue
      }
      pos++
    }
    if (state === 3 || ended) break
    // 缓冲滚动：丢弃已消费前缀（元素内未完成部分保留）
    const keepFrom = inElement && elementStart >= 0 ? elementStart : Math.min(consumedTo, buf.length)
    if (keepFrom > 1 << 20) {
      buf = buf.slice(keepFrom)
      dropped += keepFrom
      pos -= keepFrom
      if (elementStart >= 0) elementStart -= keepFrom
    }
    const next = await chunks.next()
    if (next.done) {
      ended = true
      continue
    }
    buf += next.value
  }
  const rest = flush()
  if (rest) yield rest
  if (!stats.found) {
    throw new Error(
      `未在文件中找到 "${opts.key ?? "traceEvents"}" 数组——这不是预期的 Chrome Trace（PyTorch Profiler）格式。` +
        `请确认导出方式：torch.profiler.profile(...).export_chrome_trace(path) 或 TensorBoard 的 *.pt.trace.json(.gz)。`,
    )
  }
  return stats
}
