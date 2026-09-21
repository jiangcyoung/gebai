/**
 * LSP 能力协商测试（`lsp-capabilities.ts`）：纯函数 + 登记表，不起服务器也不碰 Monaco。
 *
 * 这层决定「哪些请求**不发**」——判错了会静默失去能力（多判）或反复换回无谓错误（少判），
 * 因此逐条钉住。
 */
import { describe, expect, test } from "bun:test"
import { capabilityOfMethod, isMethodNotFoundError, supportsMethod, UnsupportedMethods } from "./lsp-capabilities"

describe("能力字段映射", () => {
  test("已知方法映射到 ServerCapabilities 的键；未知方法不参协商", () => {
    expect(capabilityOfMethod("textDocument/hover")).toBe("hoverProvider")
    expect(capabilityOfMethod("textDocument/documentSymbol")).toBe("documentSymbolProvider")
    expect(capabilityOfMethod("textDocument/rangeFormatting")).toBe("documentRangeFormattingProvider")
    expect(capabilityOfMethod("workspace/symbol")).toBeUndefined()
  })
})

describe("是否值得发请求", () => {
  test("未声明 → 不发（gopls 不给 documentRangeFormattingProvider 就是这情形）", () => {
    const caps = { hoverProvider: true, documentFormattingProvider: true }
    expect(supportsMethod(caps, "textDocument/rangeFormatting")).toBe(false)
    expect(supportsMethod(caps, "textDocument/hover")).toBe(true)
  })

  test("显式 false / null 一律不发", () => {
    expect(supportsMethod({ hoverProvider: false }, "textDocument/hover")).toBe(false)
    expect(supportsMethod({ hoverProvider: null }, "textDocument/hover")).toBe(false)
  })

  test("能力表为空或缺失 → 放行（服务器没给能力表，不凭空假设不支持）", () => {
    expect(supportsMethod(undefined, "textDocument/hover")).toBe(true)
    expect(supportsMethod({}, "textDocument/rangeFormatting")).toBe(true)
  })

  test("对象形态的能力（含子开关）按存在性判定", () => {
    expect(supportsMethod({ completionProvider: { triggerCharacters: ["."] } }, "textDocument/completion")).toBe(true)
    expect(supportsMethod({ renameProvider: { prepareProvider: true } }, "textDocument/rename")).toBe(true)
  })

  test("completionItem/resolve 额外要求 resolveProvider === true（clangd 给 false）", () => {
    expect(supportsMethod({ completionProvider: { resolveProvider: false } }, "completionItem/resolve")).toBe(false)
    expect(supportsMethod({ completionProvider: { resolveProvider: true } }, "completionItem/resolve")).toBe(true)
    // 只给 triggerCharacters 的对象不算支持 resolve
    expect(supportsMethod({ completionProvider: { triggerCharacters: ["."] } }, "completionItem/resolve")).toBe(false)
    // 但普通补全仍然支持（两个方法共用一个能力字段，判定要分叉）
    expect(supportsMethod({ completionProvider: { triggerCharacters: ["."] } }, "textDocument/completion")).toBe(true)
  })
})

describe("method not found 的识别与登记", () => {
  test("只认 -32601（超时/其它错误不记）", () => {
    expect(isMethodNotFoundError('JSON RPC method not found: "RangeFormatting" not yet implemented (-32601)')).toBe(true)
    expect(isMethodNotFoundError("textDocument/hover 超时（15s）")).toBe(false)
    expect(isMethodNotFoundError("语言服务器已退出")).toBe(false)
    expect(isMethodNotFoundError(undefined)).toBe(false)
  })

  test("记下后同一服务器不再发；换服务器不受影响；重启（clear）后恢复", () => {
    const reg = new UnsupportedMethods()
    const caps = { hoverProvider: true }
    expect(reg.allows("gopls", caps, "textDocument/rangeFormatting")).toBe(false) // 能力表就没声明
    expect(reg.note("gopls", "textDocument/rangeFormatting", "…(-32601)")).toBe(true)
    expect(reg.has("gopls", "textDocument/rangeFormatting")).toBe(true)
    expect(reg.allows("gopls", {}, "textDocument/rangeFormatting")).toBe(false) // 记过就不再发
    expect(reg.allows("clangd", {}, "textDocument/rangeFormatting")).toBe(true) // 别的服务器不受影响
    reg.clear("gopls")
    expect(reg.allows("gopls", {}, "textDocument/rangeFormatting")).toBe(true)
  })

  test("重复记同一条返回 false（调用方据此只记一次日志）", () => {
    const reg = new UnsupportedMethods()
    expect(reg.note("gopls", "completionItem/resolve", "x (-32601)")).toBe(true)
    expect(reg.note("gopls", "completionItem/resolve", "x (-32601)")).toBe(false)
    expect(reg.note("gopls", "textDocument/hover", "超时（15s）")).toBe(false)
  })
})
