/** LSP 帧编解码测试：字节长度、分片、粘连、`\n\n` 头、畸形头丢弃。 */
import { describe, expect, test } from "bun:test"
import { FrameReader, encodeFrame, parseContentLength } from "./protocol"

/** 帧 → { header, body }。 */
function split(frame: Buffer): { header: string; body: string } {
  const text = frame.toString("utf8")
  const i = text.indexOf("\r\n\r\n")
  return { header: text.slice(0, i), body: text.slice(i + 4) }
}

describe("LSP 帧编解码", () => {
  test("encodeFrame：Content-Length 按 UTF-8 字节计（中文体不按字符数）", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", method: "textDocument/hover", params: { text: "中文内容" } })
    const { header, body } = split(frame)
    expect(header).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}`)
    expect(JSON.parse(body).params.text).toBe("中文内容")
  })

  test("FrameReader：一次 push 收到粘连的多帧", () => {
    const reader = new FrameReader()
    const chunk = Buffer.concat([encodeFrame({ id: 1 }), encodeFrame({ id: 2 }), encodeFrame({ id: 3 })])
    expect(reader.push(chunk).map((b) => JSON.parse(b).id)).toEqual([1, 2, 3])
  })

  test("FrameReader：头与体分片到达（逐字节喂也能拼齐）", () => {
    const reader = new FrameReader()
    const frame = encodeFrame({ id: 7, result: { ok: true } })
    const bodies: string[] = []
    for (const byte of frame) bodies.push(...reader.push(Buffer.from([byte])))
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0] as string).id).toBe(7)
  })

  test("FrameReader：多字节字符被切在两个 chunk 之间也不乱码", () => {
    const reader = new FrameReader()
    const frame = encodeFrame({ result: "中文" })
    const cut = frame.length - 2 // 体末尾切在 UTF-8 字符中间
    expect(reader.push(frame.subarray(0, cut))).toEqual([])
    const out = reader.push(frame.subarray(cut))
    expect(JSON.parse(out[0] as string).result).toBe("中文")
  })

  test("FrameReader：只发 \\n\\n 分隔头的实现同样解析", () => {
    const reader = new FrameReader()
    const body = JSON.stringify({ id: 9 })
    const out = reader.push(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\n\n${body}`, "utf8"))
    expect(JSON.parse(out[0] as string).id).toBe(9)
  })

  test("FrameReader：缺 Content-Length 的头被丢弃，后续正常帧仍能解析", () => {
    const reader = new FrameReader()
    const bad = Buffer.from("X-Whatever: 1\r\n\r\n", "utf8")
    const good = encodeFrame({ id: 11 })
    expect(reader.push(Buffer.concat([bad, good])).map((b) => JSON.parse(b).id)).toEqual([11])
    expect(reader.dropped).toBe(bad.length)
  })

  test("FrameReader：不足一帧时保持 pending，reset 清空", () => {
    const reader = new FrameReader()
    reader.push(encodeFrame({ id: 1 }).subarray(0, 5))
    expect(reader.pending).toBeGreaterThan(0)
    reader.reset()
    expect(reader.pending).toBe(0)
  })

  test("parseContentLength：大小写不敏感、非法值（-1）", () => {
    expect(parseContentLength("Content-Length: 12")).toBe(12)
    expect(parseContentLength("content-length:3")).toBe(3)
    expect(parseContentLength("Content-Type: application/json")).toBe(-1)
    expect(parseContentLength("Content-Length: abc")).toBe(-1)
  })
})
