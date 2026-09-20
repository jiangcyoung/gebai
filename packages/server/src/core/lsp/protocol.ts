/**
 * LSP · JSON-RPC over stdio 的帧编解码（`Content-Length: N\r\n\r\n<json>`）。
 *
 * 只做「字节流 ↔ 报文体」这一层：不解析 JSON 语义、不管请求关联（那是 session 的职责）——
 * 单测可直接喂分片 / 粘连 / 畸形输入；将来换传输（socket / WS 直连）也不动上层。
 *
 * 两个易错点在此收口：
 * - 长度按**字节**计（UTF-8 中文体按字符数截会错位），所以游标一律走 Buffer 下标，
 *   整帧到齐后才解码字符串；
 * - 头分隔规范是 `\r\n\r\n`，另有实现只发 `\n\n`，两种都认（`\r\n\r\n` 自身含 `\n\n`，
 *   判定时取更早出现的那个）。
 */

const CRLFCRLF = Buffer.from("\r\n\r\n")
const LFLF = Buffer.from("\n\n")

/** 报文 → 帧（`Content-Length` 头 + UTF-8 体）。 */
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(typeof message === "string" ? message : JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

/** 头部里的 Content-Length（大小写不敏感；缺失/非法返回 -1）。 */
export function parseContentLength(header: string): number {
  for (const line of header.split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i < 0) continue
    if (line.slice(0, i).trim().toLowerCase() !== "content-length") continue
    const n = Number(line.slice(i + 1).trim())
    return Number.isInteger(n) && n >= 0 ? n : -1
  }
  return -1
}

/** 头部结束位置（`index` = 该处之前是头部；`end` = 体起始下标）。 */
function headEnd(buf: Buffer): { index: number; end: number } | null {
  const crlf = buf.indexOf(CRLFCRLF)
  const lf = buf.indexOf(LFLF)
  // `\r\n\r\n` 内的 `\n\n` 起点比它自身晚 1 字节，故 lf < crlf 只可能是真的纯 `\n\n` 头
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { index: lf, end: lf + LFLF.length }
  if (crlf >= 0) return { index: crlf, end: crlf + CRLFCRLF.length }
  return null
}

/**
 * 增量帧读取器：`push` 任意粒度的字节块，返回本次凑齐的报文体（0..n 条）。
 * 一次 push 可能跨多帧（服务器把多条应答写在一起），也可能只到半条。
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  /** 体起始下标；-1 = 头部未齐。 */
  private bodyStart = -1
  private length = -1
  private droppedBytes = 0

  push(chunk: Buffer | string): string[] {
    const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    if (b.length) this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b
    const out: string[] = []
    for (;;) {
      if (this.bodyStart < 0) {
        const head = headEnd(this.buf)
        if (!head) break
        this.length = parseContentLength(this.buf.subarray(0, head.index).toString("latin1"))
        this.bodyStart = head.end
      }
      if (this.length < 0) {
        // 畸形头（无 Content-Length）：长度不可知，只能丢弃这段头继续找下一帧
        this.droppedBytes += this.bodyStart
        this.buf = this.buf.subarray(this.bodyStart)
        this.bodyStart = -1
        this.length = -1
        continue
      }
      if (this.buf.length - this.bodyStart < this.length) break
      const end = this.bodyStart + this.length
      out.push(this.buf.subarray(this.bodyStart, end).toString("utf8"))
      this.buf = this.buf.subarray(end)
      this.bodyStart = -1
      this.length = -1
    }
    return out
  }

  /** 丢弃残留字节（进程重启 / 会话取消后复用读取器时调用）。 */
  reset(): void {
    this.buf = Buffer.alloc(0)
    this.bodyStart = -1
    this.length = -1
  }

  /** 已因畸形头丢弃的字节数（诊断用）。 */
  get dropped(): number {
    return this.droppedBytes
  }

  /** 当前未消费的字节数（测试/诊断用）。 */
  get pending(): number {
    return this.buf.length
  }
}
