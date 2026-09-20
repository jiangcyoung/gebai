/**
 * 浏览器端符号提取（tree-sitter wasm）支持的**语言 → 语法文件名**表。
 *
 * 为什么放 SDK：这份表有两个消费方，且必须一致——服务端静态路由据此做白名单（
 * `/vendor/tree-sitter/lang/:name.wasm`），web 端据此加载语法文件。放在共享包里就只有一份真相，
 * 不会出现「前端取的语言服务端没放行」这类静默失配。
 *
 * 只列**浏览器侧需要**的语言：TypeScript / JavaScript / JSON / CSS / HTML 由 Monaco 自带语言服务
 * 提供符号，不走这里；csharp / objective-c 不在服务端内嵌语法集里（取不到就别声称支持）。
 * 文件名与 `tree-sitter-wasms` 包的命名一致（服务端分析器用同一份资源）。
 */
export const TREE_SITTER_GRAMMAR: Record<string, string> = {
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  java: "tree-sitter-java.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  swift: "tree-sitter-swift.wasm",
  dart: "tree-sitter-dart.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  lua: "tree-sitter-lua.wasm",
  shell: "tree-sitter-bash.wasm",
  elixir: "tree-sitter-elixir.wasm",
}

/** 该语言是否有可用的语法文件（浏览器侧据此决定走语法树还是词法规则）。 */
export function hasTreeSitterGrammar(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(TREE_SITTER_GRAMMAR, language)
}
