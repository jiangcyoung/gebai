/**
 * 符号提取的**统一入口**：有语法文件的语言走 tree-sitter（真语法树），其余走词法规则；
 * tree-sitter 任一步失败（运行时缺失、语法文件取不到、解析异常）自动回退词法，
 * 调用方永远拿到一份可用的结果（不会因为 wasm 不可用就整体失去符号功能）。
 *
 * 为什么单拉一个模块：`symbols-core`（词法）与 `symbols-ts`（语法树）互不依赖，
 * 调度逻辑放这里避免两者相互 import 形成环。
 */
import { extractSymbols, symbolsSupported, type Sym } from "./symbols-core"
import { extractWithTreeSitter, hasTsSupport } from "./symbols-ts"

/** 实际采用的提取方式（面板据此提示用户结果来自哪条路径）。 */
export type ExtractSource = "lsp" | "tree-sitter" | "lexical"

export interface ExtractResult {
  symbols: Sym[]
  source: ExtractSource
}

/** 该语言是否**有**符号能力（两条路径任一可用即为真）。 */
export function canExtract(language: string): boolean {
  return hasTsSupport(language) || symbolsSupported(language)
}

/**
 * 提取文件内符号：tree-sitter 优先，失败回退词法。
 * 两条路径都没有该语言时返回空数组（UI 侧按「该语言暂无符号提取」提示）。
 */
export async function extractSymbolsAsync(text: string, language: string): Promise<ExtractResult> {
  if (hasTsSupport(language)) {
    const withTreeSitter = await extractWithTreeSitter(text, language)
    if (withTreeSitter) return { symbols: withTreeSitter, source: "tree-sitter" }
  }
  return { symbols: extractSymbols(text, language), source: "lexical" }
}
