/**
 * PyTorch / Kineto trace 事件的**字段级高速解析**（nsight 专用）。
 *
 * 为什么不用 `JSON.parse`：trace 可达 GB 级、事件数千万，逐个元素 `JSON.parse` 会为每个事件
 * 构造带全部键的 JS 对象（kineto 事件含 `args` 子对象与形状数组），实测在千万级事件上
 * 成为主成本。本模块只提取聚合真正需要的字段（`ph`/`cat`/`name`/`ts`/`dur`/`pid`/`tid`
 * 与 `args` 原始切片），字符串值按需反转义、嵌套值按需切片——**不构造中间对象**。
 *
 * 正确性兜底：字段提取失败（形态不符）时返回 null，调用方回退到 `JSON.parse` 单元素解析；
 * 单元素解析也失败才跳过该事件并计入规模——不让个别脏事件中断整体分析。
 */

/** 提取后的事件（`argsText` 为 `args` 对象的原始 JSON 切片，按需再取值）。 */
export interface FastEvent {
  ph: string
  cat: string
  name: string
  pid: number | string
  tid: number | string
  ts: number
  dur: number
  /** `args` 对象的原始文本（无则 undefined）。 */
  argsText?: string
}

const WANTED = new Set(["ph", "cat", "name", "ts", "dur", "pid", "tid", "args"])
/** 匹配 `"key":`（含转义键），用于定位键与值起点。 */
const KEY_RE = /"((?:[^"\\]|\\.)*)"\s*:/g

/** 反转义 JSON 字符串内容（仅在含反斜杠时解析，避免常态开销）。 */
export function unescapeJson(slice: string): string {
  if (!slice.includes("\\")) return slice
  try {
    return JSON.parse(`"${slice}"`) as string
  } catch {
    return slice
  }
}

/**
 * 从 `text[i]` 处读取一个完整 JSON 值，返回其原始切片与结束位置。
 * 字符串按转义规则推进；对象/数组按括号平衡推进（其中字符串状态被正确跳过）。
 */
function readValue(text: string, i: number): { raw: string; end: number; isString: boolean } {
  const n = text.length
  while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++
  const start = i
  const c = text[i]
  if (c === '"') {
    let j = i + 1
    while (j < n) {
      const ch = text[j]!
      if (ch === "\\") {
        j += 2
        continue
      }
      if (ch === '"') {
        j++
        break
      }
      j++
    }
    return { raw: text.slice(start + 1, j - 1), end: j, isString: true }
  }
  if (c === "{" || c === "[") {
    let depth = 0
    let j = i
    let inStr = false
    while (j < n) {
      const ch = text[j]!
      if (inStr) {
        if (ch === "\\") {
          j += 2
          continue
        }
        if (ch === '"') inStr = false
      } else if (ch === '"') inStr = true
      else if (ch === "{" || ch === "[") depth++
      else if (ch === "}" || ch === "]") {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
      j++
    }
    return { raw: text.slice(start, j), end: j, isString: false }
  }
  // 数字 / true / false / null
  let j = i
  while (j < n && text[j] !== "," && text[j] !== "}" && text[j] !== "]" && text[j] !== " ") j++
  return { raw: text.slice(start, j), end: j, isString: false }
}

/**
 * 解析单个事件元素的所需字段。
 * @returns 字段齐备时返回事件；`ph` 缺失（非事件对象）时返回 null（调用方回退 `JSON.parse`）。
 */
export function parseEventFast(text: string): FastEvent | null {
  let ph: string | undefined
  let cat = ""
  let name = ""
  let pid: number | string = 0
  let tid: number | string = 0
  let ts = 0
  let dur = 0
  let argsText: string | undefined
  let seen = 0

  KEY_RE.lastIndex = 0
  for (;;) {
    const m = KEY_RE.exec(text)
    if (!m) break
    const keyRaw = m[1]!
    const key = keyRaw.includes("\\") ? unescapeJson(keyRaw) : keyRaw
    if (!WANTED.has(key)) continue
    // 只取**首个**出现（kineto 输出中顶层字段先于 args 内的同名键）
    const value = readValue(text, KEY_RE.lastIndex)
    KEY_RE.lastIndex = value.end
    switch (key) {
      case "ph":
        if (ph === undefined) {
          ph = value.isString ? unescapeJson(value.raw) : value.raw
          seen++
        }
        break
      case "cat":
        if (cat === "" && value.isString) {
          cat = unescapeJson(value.raw)
          seen++
        }
        break
      case "name":
        if (name === "" && value.isString) {
          name = unescapeJson(value.raw)
          seen++
        }
        break
      case "ts":
        if (ts === 0) {
          ts = Number(value.raw)
          seen++
        }
        break
      case "dur":
        if (dur === 0) {
          dur = Number(value.raw)
          seen++
        }
        break
      case "pid":
        pid = value.isString ? unescapeJson(value.raw) : Number(value.raw)
        seen++
        break
      case "tid":
        tid = value.isString ? unescapeJson(value.raw) : Number(value.raw)
        seen++
        break
      case "args":
        argsText = value.raw
        seen++
        break
      default:
        break
    }
    // 需要的字段都已到手即可停止（后面只剩无关键）
    if (seen >= 8 || (ph !== undefined && argsText !== undefined && cat !== "" && name !== "")) break
  }
  if (ph === undefined) return null
  return { ph, cat, name, pid, tid, ts: Number.isFinite(ts) ? ts : NaN, dur: Number.isFinite(dur) ? dur : NaN, argsText }
}

/** 从 `args` 原始切片取数值字段（缺失返回 undefined）。 */
export function argNumber(argsText: string | undefined, key: string): number | undefined {
  if (!argsText) return undefined
  const i = argsText.indexOf(`"${key}"`)
  if (i < 0) return undefined
  const colon = argsText.indexOf(":", i + key.length + 2)
  if (colon < 0) return undefined
  const v = readValue(argsText, colon + 1)
  if (v.isString) {
    const n = Number(unescapeJson(v.raw))
    return Number.isFinite(n) ? n : undefined
  }
  const n = Number(v.raw)
  return Number.isFinite(n) ? n : undefined
}

/** 从 `args` 原始切片取任意值的原始文本（字符串返回内容、数组/对象返回原文）。 */
export function argRaw(argsText: string | undefined, key: string): string | undefined {
  if (!argsText) return undefined
  const i = argsText.indexOf(`"${key}"`)
  if (i < 0) return undefined
  const colon = argsText.indexOf(":", i + key.length + 2)
  if (colon < 0) return undefined
  const v = readValue(argsText, colon + 1)
  return v.isString ? unescapeJson(v.raw) : v.raw
}

/** 把 `["float","float"]` 形态的类型列表归一为 `float,float`（与 JS 路径口径一致）。 */
export function normalizeTypeList(raw: string): string {
  return raw.replace(/[[\]"\s]/g, "")
}

/** 把 `[[128,512],[1024,512]]` 形态的形状列表归一为紧凑文本（限长）。 */
export function normalizeShapeList(raw: string, max = 120): string {
  const compact = raw.replace(/\s+/g, "")
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}
