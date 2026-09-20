/**
 * 文件工作台 · 符号提取的 **tree-sitter 节点映射表**（15 种语言，声明式）。
 *
 * 与 `symbols-core.ts` 的词法规则分工：有语法文件的语言走真语法树（结构正确、字符串/注释/正则不会
 * 干扰、函数体内的局部定义不会被当成文件符号），其余语言沿用词法规则。两者输出同一种 `Sym` 结构。
 *
 * 每条映射只声明三件事：**节点类型 → 符号种类**、**名字怎么取**、**是否容器**。语言特有的形态
 * （Python 模块级赋值、Go 的类型细分、C/C++ 的声明符链）用小函数表达，其余交给通用递归：
 * - 容器 = 类性质节点（class/interface/struct/trait/enum/object）→ 其内部函数改判 `method`、
 *   与容器同名（或 `__init__` 一类）改判 `constructor`；`namespace` / `module` 不算类性质
 *   （C++ namespace、Rust mod 里的是自由函数）；
 * - `notInFunction` 标记的规则只在**不在任何函数体内**时生效（文件层与类/命名空间层都算；
 *   函数体内的 `int local = 1`、`type foo struct` 之类不是文件符号）。
 */

/** tree-sitter 节点的最小可用面（避免把 web-tree-sitter 的类型带进本模块）。 */
export interface TsNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  namedChildren: TsNode[]
  parent: TsNode | null
  childForFieldName(name: string): TsNode | null
}

/** 一条节点映射。 */
export interface TsNodeRule {
  /** 符号种类；返回空串表示「这个节点不算符号」（如不含初始化器的 C++ 声明） */
  kind: SymKindLike | ((node: TsNode) => SymKindLike)
  /** 名字取法（缺省取 `name` 字段） */
  name?: (node: TsNode) => string | undefined
  /** 只在**不在任何函数体内**时生效（文件层与类/命名空间层都算——函数体内的同名形态不是符号） */
  notInFunction?: boolean
}

export type SymKindLike = string

export interface TsLanguageSpec {
  /** 语法文件名（由服务端 `/vendor/tree-sitter/lang/<file>` 提供） */
  grammar: string
  nodes: Record<string, TsNodeRule>
}

/** 类性质容器（其内部函数是方法）。namespace / module 刻意不在内。 */
export const CLASS_LIKE_KINDS = new Set(["class", "interface", "struct", "trait", "enum", "object"])
/** 容器种类（内部成员归属它）。 */
export const CONTAINER_KINDS = new Set([...CLASS_LIKE_KINDS, "namespace", "module"])
/** 构造器名字（各语言的惯用名；另有「与容器同名」的形态）。 */
export const CTOR_NAMES = new Set(["__init__", "__new__", "__construct", "initialize", "init", "constructor"])

const field = (node: TsNode, name: string): TsNode | null => node.childForFieldName(name)

/** 在子树里找首个 identifier（C/C++ 声明符可能被 pointer_declarator 等包着）。 */
export function firstIdentifier(node: TsNode | null): string | undefined {
  if (!node) return undefined
  if (node.type === "identifier") return node.text
  for (const c of node.namedChildren) {
    const hit = firstIdentifier(c)
    if (hit) return hit
  }
  return undefined
}

/** 在子树里找首个指定类型的节点文本（Kotlin 等语言的名字不在字段上，只在子节点上）。 */
export function firstOfType(node: TsNode | null, types: string[]): string | undefined {
  if (!node) return undefined
  if (types.includes(node.type)) return node.text
  for (const c of node.namedChildren) {
    const hit = firstOfType(c, types)
    if (hit) return hit
  }
  return undefined
}

/** C/C++ 函数定义的声明符链里取函数名。 */
function cFunctionName(node: TsNode): string | undefined {
  const named = new Set(["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name", "operator_cast"])
  let d = field(node, "declarator")
  for (let i = 0; d && i < 6; i++) {
    if (named.has(d.type)) return d.text
    d = field(d, "declarator") ?? d.namedChildren[d.namedChildren.length - 1] ?? null
  }
  return undefined
}

/** C/C++ 文件层变量声明：带初始化器的定义，以及不带函数声明符的暂定定义（`static int counter;`）。 */
function cDeclaration(node: TsNode): { kind: string; name: string } | null {
  const init = node.namedChildren.find((c) => c.type === "init_declarator")
  if (init) {
    const name = firstIdentifier(init)
    return name ? { kind: "variable", name } : null
  }
  // 无初始化器：函数原型（`int f();`）不算符号，其余按变量处理
  if (node.namedChildren.some((c) => c.type === "function_declarator")) return null
  const declarator = node.childForFieldName("declarator")
  const name = firstIdentifier(declarator)
  return name ? { kind: "variable", name } : null
}

/** Go 的类型定义按内层类型细分（struct / interface / 其余按类型别名）。 */
function goTypeKind(node: TsNode): string {
  const t = field(node, "type")
  return t?.type === "struct_type" ? "struct" : t?.type === "interface_type" ? "interface" : "type"
}

/** Python 模块级赋值：全大写当常量，其余当变量（下划线开头同样按命名判断）。 */
function pyAssignment(node: TsNode): { kind: string; name: string } | null {
  const left = field(node, "left")
  if (!left || left.type !== "identifier") return null
  return { kind: /^_*[A-Z][A-Z0-9_]*$/.test(left.text) ? "constant" : "variable", name: left.text }
}

/** 语言 id（Monaco 语言 id，与 `core/fs/mime.ts:languageForPath` 同口径）→ 映射规格。 */
export const TS_LANGUAGES: Record<string, TsLanguageSpec> = {
  python: {
    grammar: "tree-sitter-python.wasm",
    nodes: {
      class_definition: { kind: "class" },
      function_definition: { kind: "function" },
      assignment: {
        kind: (n) => pyAssignment(n)?.kind ?? "",
        name: (n) => pyAssignment(n)?.name,
        notInFunction: true,
      },
    },
  },
  go: {
    grammar: "tree-sitter-go.wasm",
    nodes: {
      function_declaration: { kind: "function" },
      method_declaration: { kind: "method" },
      type_spec: { kind: goTypeKind },
      const_spec: { kind: "constant", notInFunction: true },
      var_spec: { kind: "variable", notInFunction: true },
    },
  },
  rust: {
    grammar: "tree-sitter-rust.wasm",
    nodes: {
      function_item: { kind: "function" },
      function_signature_item: { kind: "function" }, // extern "system" { fn ... }
      struct_item: { kind: "struct" },
      enum_item: { kind: "enum" },
      trait_item: { kind: "trait" },
      impl_item: { kind: "class", name: (n) => field(n, "type")?.text ?? field(n, "name")?.text },
      mod_item: { kind: "module" },
      const_item: { kind: "constant" },
      static_item: { kind: "constant" },
      type_item: { kind: "type" },
      macro_definition: { kind: "macro", name: (n) => field(n, "name")?.text },
    },
  },
  c: {
    grammar: "tree-sitter-c.wasm",
    nodes: {
      function_definition: { kind: "function", name: cFunctionName },
      struct_specifier: { kind: "struct" },
      enum_specifier: { kind: "enum" },
      type_definition: { kind: "type" },
      preproc_def: { kind: "macro" },
      declaration: { kind: (n) => cDeclaration(n)?.kind ?? "", name: (n) => cDeclaration(n)?.name, notInFunction: true },
    },
  },
  cpp: {
    grammar: "tree-sitter-cpp.wasm",
    nodes: {
      function_definition: { kind: "function", name: cFunctionName },
      class_specifier: { kind: "class" },
      struct_specifier: { kind: "struct" },
      enum_specifier: { kind: "enum" },
      namespace_definition: { kind: "namespace" },
      preproc_def: { kind: "macro" },
      declaration: { kind: (n) => cDeclaration(n)?.kind ?? "", name: (n) => cDeclaration(n)?.name, notInFunction: true },
    },
  },
  java: {
    grammar: "tree-sitter-java.wasm",
    nodes: {
      class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      annotation_type_declaration: { kind: "interface" },
      enum_declaration: { kind: "enum" },
      record_declaration: { kind: "class" },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "constructor" },
      // 字段名在 declarator（variable_declarator）的 name 上，不在 field_declaration 自身
      field_declaration: { kind: "field", name: (n) => (n.childForFieldName("declarator")?.type === "variable_declarator" ? field(n.childForFieldName("declarator")!, "name")?.text : undefined) },
    },
  },
  kotlin: {
    grammar: "tree-sitter-kotlin.wasm",
    nodes: {
      // Kotlin 的名字不在字段上（节点无个叫 name 的子项），取首个标识符类子节点
      class_declaration: { kind: "class", name: kotlinName },
      object_declaration: { kind: "object", name: kotlinName },
      function_declaration: { kind: "function", name: kotlinName },
      property_declaration: { kind: "property", name: kotlinName },
      type_alias: { kind: "type", name: kotlinName },
    },
  },
  scala: {
    grammar: "tree-sitter-scala.wasm",
    nodes: {
      class_definition: { kind: "class" },
      object_definition: { kind: "object" },
      trait_definition: { kind: "trait" },
      function_definition: { kind: "function" },
      // 无方法体的声明（`def draw(): Unit`）在 scala 语法里是另一个节点
      function_declaration: { kind: "function" },
      val_definition: { kind: "property", name: (n) => field(n, "pattern")?.text },
      var_definition: { kind: "property", name: (n) => field(n, "pattern")?.text },
      type_definition: { kind: "type" },
    },
  },
  swift: {
    grammar: "tree-sitter-swift.wasm",
    nodes: {
      // swift 语法把 class / struct / enum / actor 都归在 class_declaration 下，按关键字二次判定
      class_declaration: { kind: swiftDeclarationKind },
      protocol_declaration: { kind: "interface" },
      protocol_function_declaration: { kind: "function" },
      function_declaration: { kind: "function" },
      function_declaration_in_type: { kind: "function" },
      property_declaration: { kind: "property" },
      property_declaration_with_value: { kind: "property" },
      typealias_declaration: { kind: "type" },
    },
  },
  dart: {
    grammar: "tree-sitter-dart.wasm",
    nodes: {
      class_definition: { kind: "class" },
      mixin_declaration: { kind: "class" },
      extension_declaration: { kind: "class" },
      enum_declaration: { kind: "enum" },
      function_signature: { kind: "function" },
      method_signature: { kind: "method" },
      // 顶层 const/final（dart 复用 static_final_* 节点）
      static_final_declaration: { kind: "constant", name: (n) => firstOfType(n, ["initialized_identifier", "identifier"]) },
      // 类成员声明：带参数表的（`Point(this.x);`）是方法/构造器，否则是字段
      declaration: {
        kind: (n) => (n.text.includes("(") ? "method" : "field"),
        name: (n) => firstOfType(n, ["initialized_identifier", "identifier"]),
        notInFunction: true,
      },
    },
  },
  ruby: {
    grammar: "tree-sitter-ruby.wasm",
    nodes: {
      class: { kind: "class" },
      module: { kind: "class" }, // Ruby module 也是方法容器（与词法侧同一口径）
      method: { kind: "function" },
      singleton_method: { kind: "function" },
      // 常量赋值（Ruby 的大写标识符是 constant 节点，名字在 left 字段上）
      assignment: { kind: "constant", name: (n) => field(n, "left")?.text, notInFunction: true },
    },
  },
  php: {
    grammar: "tree-sitter-php.wasm",
    nodes: {
      class_declaration: { kind: "class" },
      interface_declaration: { kind: "interface" },
      trait_declaration: { kind: "trait" },
      enum_declaration: { kind: "enum" },
      function_definition: { kind: "function" },
      method_declaration: { kind: "method" },
      namespace_definition: { kind: "namespace" },
      const_declaration: { kind: "constant", notInFunction: true },
    },
  },
  lua: {
    grammar: "tree-sitter-lua.wasm",
    nodes: {
      function_definition_statement: { kind: "function" },
      local_function_definition_statement: { kind: "function" },
      local_variable_declaration: { kind: "variable", name: (n) => firstOfType(n, ["variable"]), notInFunction: true },
    },
  },
  shell: {
    grammar: "tree-sitter-bash.wasm",
    nodes: {
      function_definition: { kind: "function" },
      variable_assignment: { kind: "variable", notInFunction: true },
    },
  },
  elixir: {
    grammar: "tree-sitter-elixir.wasm",
    nodes: {
      // Elixir 的 def/defmodule 都是宏调用（call 节点），按被调用的标识符判定
      call: { kind: elixirCallKind, name: (n) => elixirCallName(n) },
    },
  },
}

/** Kotlin：名字不在字段上，取首个标识符类子节点。 */
function kotlinName(node: TsNode): string | undefined {
  return firstOfType(node, ["simple_identifier", "type_identifier"])
}

/** Swift：class_declaration 涵盖 class / struct / enum / actor，按声明关键字判定。 */
function swiftDeclarationKind(node: TsNode): string {
  const head = node.text.trimStart()
  if (head.startsWith("struct")) return "struct"
  if (head.startsWith("enum")) return "enum"
  return "class"
}

/** Elixir：`defmodule Foo` / `def bar` / `defp bar` 这类宏调用的符号种类。 */
function elixirCallKind(node: TsNode): string {
  const head = node.namedChildren[0]
  const name = head?.type === "identifier" ? head.text : ""
  if (name === "defmodule") return "module"
  if (/^(def|defp|defmacro|defmacrop|defguard|defguardp)$/.test(name)) return "function"
  return ""
}

function elixirCallName(node: TsNode): string | undefined {
  const args = node.childForFieldName("arguments") ?? node.namedChildren.find((c) => c.type === "arguments") ?? null
  const first = args?.namedChildren[0]
  if (!first) return undefined
  if (first.type === "alias") return first.text
  return first.namedChildren.find((c) => c.type === "identifier")?.text ?? first.text.split(/[\s(]/)[0]
}
