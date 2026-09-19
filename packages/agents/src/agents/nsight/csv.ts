/**
 * CSV 流式解析（nsight 专用）：Nsight Compute 的报告页在大型采集下可达数百 MB，
 * 必须逐行消费而不把文件读入内存。处理 RFC4180 引号规则（含字段内换行与转义引号）。
 */

export type CsvRow = string[]

/** 逐行流式解析 CSV 文件（内存与文件大小解耦）。 */
export async function* streamCsvFile(path: string): AsyncGenerator<CsvRow> {
  const file = Bun.file(path)
  const decoder = new TextDecoder("utf-8")
  let field = ""
  let row: CsvRow = []
  let inQuotes = false
  let pendingQuote = false

  const flushRow = function* (): Generator<CsvRow> {
    row.push(field)
    field = ""
    if (row.some((c) => c.length)) yield row
    row = []
  }

  for await (const chunk of file.stream() as unknown as AsyncIterable<Uint8Array>) {
    const text = decoder.decode(chunk, { stream: true })
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false
          if (ch === '"') {
            field += '"'
            continue
          }
          inQuotes = false
          // 引号闭合后继续处理当前字符
        } else if (ch === '"') {
          pendingQuote = true
          continue
        } else {
          field += ch
          continue
        }
      }
      if (ch === '"') {
        inQuotes = true
        pendingQuote = false
      } else if (ch === ",") {
        row.push(field)
        field = ""
      } else if (ch === "\n") {
        yield* flushRow()
      } else if (ch !== "\r") {
        field += ch
      }
    }
  }
  if (field.length || row.length) yield* flushRow()
}

/** 表头索引（按列名取值，不依赖列序——不同 ncu 版本的列集有差异）。 */
export function headerIndex(header: CsvRow): Map<string, number> {
  const map = new Map<string, number>()
  header.forEach((h, i) => {
    if (!map.has(h)) map.set(h, i)
  })
  return map
}

export function cellAt(row: CsvRow, index: Map<string, number>, name: string): string | undefined {
  const i = index.get(name)
  if (i === undefined) return undefined
  return row[i]
}

/** 数值解析：容忍空值、千分位、单位后缀（如 "90,985" / "89.73" / "1.04"）。 */
export function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cleaned = value.replace(/,/g, "").trim()
  if (!cleaned || cleaned === "-") return undefined
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : undefined
}

/** 百分比解析（"88.69 %" → 88.69）。 */
export function pct(value: string | undefined): number | undefined {
  return num(value)
}

/** 解析 SASS 指令所属的 stall 原因列（列名形如 `stall_wait` / `stall_long_sb (Not Issued)`）。 */
export function stallColumns(header: CsvRow): Array<{ name: string; index: number }> {
  const out: Array<{ name: string; index: number }> = []
  header.forEach((h, i) => {
    if (/^stall_/.test(h) && !/ \(Not Issued\)$/.test(h)) out.push({ name: h.replace(/^stall_/, ""), index: i })
  })
  return out
}
