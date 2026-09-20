/**
 * 文件工作台 · 文件内符号提取（**词法级**，纯函数、无 DOM、无依赖）。
 *
 * 目标：让工作台的 Monaco 编辑器具备「转到符号」与「跳到定义」——F12 / Ctrl+Click 跳定义、
 * Ctrl+Shift+O 列符号。用**逐行正则 + 作用域栈**做，不引入 LSP / 语言服务器 / wasm 解析器：
 * 文件内跳转只需要当前文件的词法结构，而 LSP 要为每种语言配一个进程与一条协议链路，
 * 体积、部署与进程管理成本远超收益（局域网/离线环境下尤其明显）。
 *
 * 三条实现约定：
 * ① **掩码后匹配**（`maskLines`）：注释与字符串内容先替换成**等长空格**再跑规则。等长保证了
 *    行号列号与原文一一对应，替换保证 `"def foo()"`、`# class Bar` 这类内容不会被当成定义。
 * ② **作用域三种口径**（`LangSpec.scope`）：`brace`（花括号语言：按行首花括号深度分层）、
 *    `indent`（缩进语言：Python / YAML / Ruby）、`level`（自带层级的标记语言：Markdown 标题、
 *    INI 节、LaTeX section）。分层信号取自源码结构本身，不需要语法树。
 * ③ **kind 二次修正**：规则只声明「这是个函数」，落在类内则改判 `method`、与容器同名则改判
 *    `constructor`——这样每种语言的规则表能保持几行，而不必为「类方法」单写一套。
 *
 * 局限（有意为之）：不做类型推断与重载解析（同名多定义按作用域就近 + 出现顺序给候选）、
 * 一行内的多个定义只取先命中的那个、跨文件不处理。这些属于语义层，交给编辑器内置语言服务或
 * 后续能力，本模块只解决「文件内快速定位」——TypeScript / JavaScript / JSON / CSS 系 / HTML
 * 因此不在覆盖之列：那几种语言由 Monaco 自带的语言服务（本地 worker）解析，质量高于词法规则。
 */

import { fuzzyMatch } from "./quick-open-core"

/** 符号种类（映射到 Monaco `SymbolKind` 由 `symbols.ts` 完成；本模块不依赖 monaco 类型）。 */
export type SymKind =
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "interface"
  | "struct"
  | "trait"
  | "enum"
  | "enumMember"
  | "event"
  | "function"
  | "method"
  | "constructor"
  | "field"
  | "property"
  | "variable"
  | "constant"
  | "type"
  | "macro"
  | "heading"
  | "section"
  | "key"
  | "label"
  | "table"
  | "view"
  | "procedure"
  | "resource"
  | "object"

/** 一个符号（可含子符号，构成大纲树）。行号与列号均为 **0 基**，列号指向名字首字符。 */
export interface Sym {
  name: string
  kind: SymKind
  line: number
  column: number
  /** 结束行（0 基，含）；用于大纲高亮范围与折叠提示 */
  endLine: number
  children: Sym[]
}

/** 一条定义规则：正则须以 `^\s*` 式的行首锚定，并用命名组 `name` 给出符号名。 */
export interface SymRule {
  /** 定义行匹配（带 `d` 标志以取名字精确列号） */
  re: RegExp
  kind: SymKind
  /** 名字取自其它捕获组或需要拼接时给出（缺省用命名组 `name`） */
  name?: (m: RegExpMatchArray) => string | undefined
  /** 按匹配内容决定 kind（缺省用 `kind`） */
  kindOf?: (m: RegExpMatchArray) => SymKind
  /** 自带层级（`level` 口径）：缺省 0 */
  level?: (m: RegExpMatchArray) => number
  /** 仅在作用域内（花括号/缩进深度 > 0）生效（如 GraphQL 字段定义） */
  innerOnly?: boolean
  /** 仅在顶层（深度 0）生效（如 C 的全局变量：函数体内的局部变量不是符号） */
  topOnly?: boolean
}

/** 一种语言的提取规格。 */
export interface LangSpec {
  /** 分层口径 */
  scope: "brace" | "indent" | "level"
  /** 行注释前缀（可多个，最长者优先判定） */
  line?: string[]
  /** 块注释起止（支持跨行状态） */
  block?: [string, string]
  /** 三引号字符串（Python / Kotlin 等的 docstring） */
  triple?: string[]
  /** 保留字符串内容不掩码（配置语言里引号内的名字也是符号的一部分，如 INI 的 `[remote "origin"]`） */
  keepStrings?: boolean
  /**
   * 识别正则字面量（`/.../`）并一并掩码。Ruby 这类语言里正则内部的花括号会被 brace 口径误计成
   * 代码块边界（`#{}` 插值、`\{` 都看得到），把一个文件的大纲整个挂错层——正则必须先掩掉。
   */
  regexLiterals?: boolean
  /** 缩进口径下用几个空格当一级（缺省 4）——只影响层级比较的相对值 */
  tabWidth?: number
  /** 保留的最大层级（0 = 只留顶层；缺省不限）——YAML 这种层级很深的配置用得上 */
  maxDepth?: number
  rules: SymRule[]
}

/** 展平后的符号（面板列表按它渲染）。 */
export interface FlatSym {
  name: string
  /** 全限定名（`Class.method`），面板据此模糊匹配与显示归属 */
  qualified: string
  kind: SymKind
  line: number
  column: number
  /** 所在层级（0 = 顶层） */
  depth: number
}

/**
 * 掩码：注释与字符串内容替换成等长空格（换行保留），使行/列号与原文严格一致。
 *
 * 跨行状态（块注释、三引号）在行间传递；字符串按**同行闭合**近似处理（跨行裸字符串罕见，
 * 漏掉只影响该行后续内容的匹配，不会误报符号）。
 */
export function maskLines(lines: readonly string[], spec: Pick<LangSpec, "line" | "block" | "triple" | "keepStrings" | "regexLiterals">): string[] {
  const lineMarks = (spec.line ?? []).slice().sort((a, b) => b.length - a.length)
  const block = spec.block
  const triples = spec.triple ?? []
  const out: string[] = []
  let inBlock: string | null = null
  let inTriple: string | null = null

  for (const raw of lines) {
    const chars = raw.split("")
    const blank = (from: number, to: number): void => {
      for (let k = from; k < to && k < chars.length; k++) chars[k] = " "
    }
    let i = 0
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf(inBlock, i)
        const stop = end < 0 ? raw.length : end + inBlock.length
        blank(i, stop)
        i = stop
        if (end >= 0) inBlock = null
        continue
      }
      if (inTriple) {
        const end = raw.indexOf(inTriple, i)
        const stop = end < 0 ? raw.length : end + inTriple.length
        blank(i, stop)
        i = stop
        if (end >= 0) inTriple = null
        continue
      }
      const trip = triples.find((t) => raw.startsWith(t, i))
      if (trip) {
        blank(i, i + trip.length)
        i += trip.length
        inTriple = trip
        continue
      }
      const mark = lineMarks.find((m) => raw.startsWith(m, i))
      if (mark) {
        blank(i, raw.length)
        break
      }
      if (block && raw.startsWith(block[0], i)) {
        blank(i, i + block[0].length)
        i += block[0].length
        inBlock = block[1]
        continue
      }
      const c = chars[i]!
      if (spec.regexLiterals && c === "/" && isRegexStart(raw, i)) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < raw.length) {
          const ch = raw[j]!
          if (ch === "\\") {
            j += 2
            continue
          }
          if (ch === "[") inClass = true
          else if (ch === "]") inClass = false
          else if (ch === "/" && !inClass) {
            closed = true
            break
          }
          j++
        }
        if (closed) {
          blank(i, j + 1)
          i = j + 1
          continue
        }
      }
      if (!spec.keepStrings && (c === '"' || c === "'" || c === "`")) {
        let j = i + 1
        let closed = false
        while (j < raw.length) {
          if (chars[j] === "\\") {
            j += 2
            continue
          }
          if (chars[j] === c) {
            closed = true
            break
          }
          j++
        }
        const stop = closed ? j + 1 : raw.length
        blank(i, stop)
        i = stop
        continue
      }
      i++
    }
    out.push(chars.join(""))
  }
  return out
}

/**
 * 行内 `/` 是正则字面量的开头还是除法运算：看**前一个非空字符**（标识符/右括号后面是除法，
 * 运算符、逗号、左括号、关键字后面是正则）。这是各编辑器语法高亮的通行启发式，无需完整词法分析。
 */
function isRegexStart(line: string, at: number): boolean {
  let k = at - 1
  while (k >= 0 && (line[k] === " " || line[k] === "\t")) k--
  if (k < 0) return true
  const prev = line[k]!
  if ("([{,;:=!&|?+-*%~^<".includes(prev)) return true
  if (/[\w$)\]"'`]/.test(prev)) {
    // `return /re/`、`typeof /re/` 这类关键字后面跟的正则（识别词尾，避免把 `myreturn` 当地关键字）
    const tail = line.slice(Math.max(0, k - 11), k + 1)
    return /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await|instanceof)$/.test(tail)
  }
  return true
}

/** 行首缩进宽度（tab 按 `tabWidth` 计）。 */
function indentWidth(line: string, tabWidth: number): number {
  let w = 0
  for (const c of line) {
    if (c === " ") w += 1
    else if (c === "\t") w += tabWidth
    else break
  }
  return w
}

/* --------------------------- 语言规则表 --------------------------- */

/**
 * C 家族共用的定义形态（C / C++ / Objective-C）：
 * - 函数：行尾以 `{` 收口（K&R 风格），或 Allman 风格的行尾 `)`（定义体在下一行）；
 * - 声明（以 `;` 结尾的调用语句）由「行尾必须是 `{` 或行尾 `)`」天然排除；
 * - 控制关键字用负向前瞻挡掉——`if (x) {` 与函数定义长得一模一样。
 */
const C_FAMILY: SymRule[] = [
  { re: /^\s*#\s*define\s+(?<name>[A-Za-z_]\w*)/d, kind: "macro" },
  {
    re: /^\s*(?!\s*(?:return|if|for|while|switch|do|else|case|sizeof)\b)(?:[\w*&:<>,.\[\]]+\s+)*\s*\**\s*(?<name>[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/d,
    kind: "function",
  },
  {
    re: /^\s*(?!\s*(?:return|if|for|while|switch|do|else|case|sizeof)\b)(?:[\w*&:<>,.\[\]]+\s+)*\s*\**\s*(?<name>[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?$/d,
    kind: "function",
  },
  {
    re: /^\s*(?:typedef\s+)?(?:struct|union|enum)\s+(?<name>[A-Za-z_]\w*)/d,
    kind: "struct",
    kindOf: (m) => (/\benum\b/.test(m[0]) ? "enum" : "struct"),
  },
  { re: /^\s*typedef\b[\w\s*&:<>,.\[\]]*(?<name>[A-Za-z_]\w*)\s*;/d, kind: "type" },
  {
    re: /^\s*(?:(?:static|const|extern|volatile|unsigned|signed|struct|union|enum)\s+|[\w*&:<>,.\[\]]+\s+)*\s*\**\s*(?<name>[A-Za-z_]\w*)\s*(?:=|,|;)/d,
    kind: "variable",
    topOnly: true,
  },
]

/**
 * 语言 id → 提取规格。键名与 `core/fs/mime.ts:languageForPath` 的返回值**同口径**
 * （即 Monaco 语言 id）——它同时决定 Monaco 语言选择器里注册哪些语言，漂移会静默失效。
 *
 * 不含 TypeScript / JavaScript / JSON / CSS 系 / HTML：Monaco 自带语言服务（本地 worker，非 LSP）
 * 已提供这些语言的符号与定义跳转（实测：工作台的内存 model 就在它的脚本清单里，
 * `getNavigationTree` / `getDefinitionAtPosition` 均正常返回），重复注册只会让符号列表出现两份。
 */
export const LANG_RULES: Record<string, LangSpec> = {
  python: {
    scope: "indent",
    line: ["#"],
    triple: ['"""', "'''"],
    rules: [
      { re: /^\s*(?:async\s+)?def\s+(?<name>[A-Za-z_]\w*)\s*(?:\(|$)/d, kind: "function" },
      { re: /^\s*class\s+(?<name>[A-Za-z_]\w*)/d, kind: "class" },
      // 模块级常量（全大写）：Python 没有声明式常量，这是社区一致的命名约定
      { re: /^(?<name>[A-Z][A-Z0-9_]{2,})\s*(?::[^=\n]+)?=/d, kind: "constant", topOnly: true },
    ],
  },

  go: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^\s*func\s+\(\s*\w+\s+\*?(?<recv>[\w\[\]*.]+)\s*\)\s*(?<name>\w+)/d, kind: "method" },
      { re: /^\s*func\s+(?<name>\w+)/d, kind: "function" },
      {
        re: /^\s*type\s+(?<name>\w+)\s+(?<kw>struct|interface|func|map|chan|\[|\w)/d,
        kind: "type",
        kindOf: (m) => (m.groups?.kw === "struct" ? "struct" : m.groups?.kw === "interface" ? "interface" : "type"),
      },
    ],
  },

  rust: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s*(?:pub\s+)?struct\s+(?<name>\w+)/d, kind: "struct" },
      { re: /^\s*(?:pub\s+)?enum\s+(?<name>\w+)/d, kind: "enum" },
      { re: /^\s*(?:pub\s+)?(?:unsafe\s+)?trait\s+(?<name>\w+)/d, kind: "trait" },
      { re: /^\s*(?:pub\s+)?impl(?:<[^>]*>)?\s+(?<name>[\w:]+)/d, kind: "class" },
      { re: /^\s*(?:pub\s+)?mod\s+(?<name>\w+)/d, kind: "module" },
      { re: /^\s*(?:pub\s+)?(?:const|static)\s+(?:mut\s+)?(?<name>\w+)/d, kind: "constant" },
      { re: /^\s*(?:pub\s+)?type\s+(?<name>\w+)/d, kind: "type" },
      { re: /^\s*macro_rules!\s*(?<name>\w+)/d, kind: "macro" },
    ],
  },

  java: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^[\w\s@.]*?@interface\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^[\w\s@.]*?\binterface\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^[\w\s@.]*?\benum\s+(?<name>\w+)/d, kind: "enum" },
      { re: /^[\w\s@.]*?\brecord\s+(?<name>\w+)\s*\(/d, kind: "class" },
      { re: /^[\w\s@.]*?\bclass\s+(?<name>\w+)/d, kind: "class" },
      {
        re: /^(?!\s*(?:if|for|while|switch|catch|return|synchronized|try|new)\b)[\w\s@,.<>\[\]]*?\b(?<name>[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:throws\s+[\w\s,.]+)?(?:\{|$)/d,
        kind: "method",
      },
      { re: /^\s*(?:public|private|protected)\s+(?:static\s+|final\s+|volatile\s+|transient\s+)*[\w,.<>\[\]]+\s+(?<name>\w+)\s*(?:=[^;]*)?;/d, kind: "field" },
    ],
  },

  kotlin: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    triple: ['"""'],
    rules: [
      { re: /^[\w\s@.]*?\bfun\s+(?:<[^>]*>\s*)?(?:[\w,.<>?\[\]]+\.)?(?<name>[A-Za-z_]\w*)\s*\(/d, kind: "function" },
      { re: /^[\w\s@.]*?\b(?:data\s+|sealed\s+|abstract\s+|open\s+|inner\s+|enum\s+|annotation\s+|value\s+|inline\s+)*class\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\binterface\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^[\w\s@.]*?\bobject\s+(?<name>\w+)/d, kind: "object" },
      { re: /^[\w\s@.]*?\btypealias\s+(?<name>\w+)/d, kind: "type" },
      { re: /^(?:public|private|protected|internal|override|lateinit|const|open|abstract|actual|expect|\s)*\b(?:val|var)\s+(?<name>[A-Za-z_]\w*)/d, kind: "property" },
    ],
  },

  scala: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^[\w\s@.]*?\bdef\s+(?<name>[A-Za-z_]\w*)/d, kind: "function" },
      { re: /^[\w\s@.]*?\b(?:case\s+)?class\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\b(?:case\s+)?object\s+(?<name>\w+)/d, kind: "object" },
      { re: /^[\w\s@.]*?\btrait\s+(?<name>\w+)/d, kind: "trait" },
      { re: /^[\w\s@.]*?\b(?:val|var)\s+(?<name>[A-Za-z_]\w*)/d, kind: "property" },
      { re: /^[\w\s@.]*?\btype\s+(?<name>\w+)/d, kind: "type" },
    ],
  },

  groovy: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^\s*(?:def|void|[\w<>,.\[\]]+)\s+(?<name>[A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/d, kind: "function" },
      { re: /^[\w\s@.]*?\bclass\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\binterface\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^[\w\s@.]*?\btrait\s+(?<name>\w+)/d, kind: "trait" },
      { re: /^\s*(?:final\s+|static\s+)*[\w<>,.\[\]]+\s+(?<name>[A-Za-z_]\w*)\s*(?:=|$)/d, kind: "property", topOnly: true },
    ],
  },

  c: { scope: "brace", line: ["//"], block: ["/*", "*/"], rules: C_FAMILY },

  cpp: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      {
        re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?<name>[A-Za-z_]\w*)/d,
        kind: "class",
        kindOf: (m) => (/\bstruct\b/.test(m[0]) ? "struct" : "class"),
      },
      { re: /^\s*(?:inline\s+)?namespace\s+(?<name>\w+)/d, kind: "namespace" },
      { re: /^\s*enum\s+class\s+(?<name>\w+)/d, kind: "enum" },
      { re: /^\s*(?:using|typedef)\s+(?<name>\w+)\s*=/d, kind: "type" },
      ...C_FAMILY,
    ],
  },

  "objective-c": {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^@interface\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^@implementation\s+(?<name>\w+)/d, kind: "class" },
      { re: /^@protocol\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^@property[^;]*?\b(?<name>\w+)\s*;/d, kind: "property" },
      { re: /^[-+]\s*\([^)]*\)\s*(?<name>\w+)/d, kind: "method" },
      { re: /^\s*#\s*define\s+(?<name>\w+)/d, kind: "macro" },
    ],
  },

  csharp: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^[\w\s@.]*?\binterface\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^[\w\s@.]*?\brecord\s+(?<name>\w+)/d, kind: "class" },
      {
        re: /^[\w\s@.]*?\b(?:class|struct)\s+(?<name>\w+)/d,
        kind: "class",
        kindOf: (m) => (/\bstruct\b/.test(m[0]) ? "struct" : "class"),
      },
      { re: /^[\w\s@.]*?\benum\s+(?<name>\w+)/d, kind: "enum" },
      { re: /^[\w\s@.]*?\bnamespace\s+(?<name>[\w.]+)/d, kind: "namespace" },
      {
        re: /^(?!\s*(?:if|for|foreach|while|switch|catch|return|using|lock|fixed)\b)\s*(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|partial|new|\s)*[\w,.<>?\[\]]+\s+(?<name>[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|=>|$)/d,
        kind: "method",
      },
      { re: /^\s*(?:public|private|protected|internal|static|virtual|override|\s)+[\w,.<>?\[\]]+\s+(?<name>[A-Za-z_]\w*)\s*\{\s*(?:get|set)/d, kind: "property" },
      { re: /^\s*(?:public|private|protected|internal|static|readonly|const|volatile|\s)+[\w,.<>?\[\]]+\s+(?<name>[A-Za-z_]\w*)\s*(?:=[^;]*)?;/d, kind: "field" },
    ],
  },

  php: {
    scope: "brace",
    line: ["//", "#"],
    block: ["/*", "*/"],
    rules: [
      { re: /^[\w\s$,]*?\bnamespace\s+(?<name>[\w\\]+)/d, kind: "namespace" },
      {
        re: /^[\w\s$,]*?\b(?:abstract\s+|final\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(?<name>\w+)/d,
        kind: "class",
        kindOf: (m) => (/\binterface\b/.test(m[0]) ? "interface" : /\btrait\b/.test(m[0]) ? "trait" : /\benum\b/.test(m[0]) ? "enum" : "class"),
      },
      { re: /^[\w\s$,]*?\bfunction\s+(?<name>\w+)\s*\(/d, kind: "function" },
      { re: /^\s*(?:(?:public|private|protected)\s+)?const\s+(?<name>\w+)/d, kind: "constant" },
      { re: /^\s*(?:public|private|protected|static|readonly|var|\s)+(?:\??[\w\\\[\]]+)\s+\$(?<name>\w+)/d, kind: "property" },
    ],
  },

  ruby: {
    scope: "indent",
    line: ["#"],
    block: ["=begin", "=end"],
    regexLiterals: true,
    rules: [
      { re: /^[\w\s:]*?\bdef\s+(?:self\.)?(?<name>[A-Za-z_]\w*[?!]?)/d, kind: "function" },
      { re: /^[\w\s:]*?\bclass\s+(?<name>[\w:]+)/d, kind: "class" },
      // Ruby 的 module 与 class 同为方法容器（module 不能实例化但能定义方法），按类呈现以让内部 def 改判为方法
      { re: /^[\w\s:]*?\bmodule\s+(?<name>[\w:]+)/d, kind: "class" },
      { re: /^\s*(?:attr_accessor|attr_reader|attr_writer)\s+:(?<name>\w+)/d, kind: "property" },
      { re: /^(?<name>[A-Z][A-Z0-9_]+)\s*=/d, kind: "constant", topOnly: true },
    ],
  },

  swift: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^[\w\s@.]*?\bclass\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\bstruct\s+(?<name>\w+)/d, kind: "struct" },
      { re: /^[\w\s@.]*?\benum\s+(?<name>\w+)/d, kind: "enum" },
      { re: /^[\w\s@.]*?\bprotocol\s+(?<name>\w+)/d, kind: "interface" },
      { re: /^[\w\s@.]*?\b(?:extension|actor)\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\bfunc\s+(?<name>[A-Za-z_]\w*)/d, kind: "function" },
      { re: /^[\w\s@.]*?\binit\s*[(!?]/d, kind: "constructor", name: () => "init" },
      { re: /^[\w\s@.]*?\btypealias\s+(?<name>\w+)/d, kind: "type" },
      { re: /^\s*case\s+(?<name>\w+)/d, kind: "enumMember", innerOnly: true },
      { re: /^[\w\s@.]*?\b(?:let|var)\s+(?<name>[A-Za-z_]\w*)/d, kind: "variable" },
    ],
  },

  dart: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^[\w\s@.]*?\bclass\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\b(?:mixin|extension)\s+(?<name>\w+)/d, kind: "class" },
      { re: /^[\w\s@.]*?\benum\s+(?<name>\w+)/d, kind: "enum" },
      { re: /^\s*(?<name>[A-Z]\w*)\s*\([^;{}]*\)\s*(?::[^;{}]*)?\{/d, kind: "constructor" },
      { re: /^[\w\s@.]*?(?:[\w<>,.?\[\]]+\s+)+(?<name>[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:async\s*)?\{/d, kind: "function" },
      { re: /^[\w\s@.]*?\b(?:final|const|var|late)\s+(?<name>[A-Za-z_]\w*)/d, kind: "variable" },
    ],
  },

  lua: {
    scope: "indent",
    line: ["--"],
    rules: [
      { re: /^\s*(?:local\s+)?function\s+(?<name>[\w.:]+)/d, kind: "function" },
      { re: /^\s*(?:local\s+)?(?<name>[\w.:]+)\s*=\s*function/d, kind: "function" },
      { re: /^\s*(?:local\s+)?(?<name>[A-Za-z_]\w*)\s*=\s*(?!function)/d, kind: "variable", topOnly: true },
    ],
  },

  perl: {
    scope: "indent",
    line: ["#"],
    rules: [
      { re: /^\s*sub\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s*package\s+(?<name>[\w:]+)/d, kind: "package" },
      { re: /^\s*use\s+constant\s+(?<name>\w+)/d, kind: "constant" },
    ],
  },

  r: {
    scope: "brace",
    line: ["#"],
    rules: [
      { re: /^\s*(?<name>[A-Za-z._][\w.]*)\s*(?:<-|=)\s*function/d, kind: "function" },
      { re: /^\s*(?<name>[A-Za-z._][\w.]*)\s*<-\s*(?!function)/d, kind: "variable", topOnly: true },
    ],
  },

  shell: {
    scope: "indent",
    line: ["#"],
    rules: [
      { re: /^\s*(?:function\s+)?(?<name>[A-Za-z_][\w.-]*)\s*\(\s*\)\s*\{?/d, kind: "function" },
      { re: /^\s*function\s+(?<name>[A-Za-z_][\w.-]*)/d, kind: "function" },
    ],
  },

  powershell: {
    scope: "indent",
    line: ["#"],
    block: ["<#", "#>"],
    rules: [
      { re: /^\s*(?:function|filter)\s+(?<name>[\w-]+)/di, kind: "function" },
      { re: /^\s*class\s+(?<name>\w+)/di, kind: "class" },
      { re: /^\s*enum\s+(?<name>\w+)/di, kind: "enum" },
      { re: /^\s*(?:(?:public|private|protected|static|hidden)\s+)*(?<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*\{/d, kind: "method" },
    ],
  },

  bat: {
    scope: "indent",
    line: ["::", "rem ", "REM "],
    rules: [
      { re: /^:(?<name>[\w-]+)/d, kind: "label" },
      { re: /^\s*set\s+(?<name>\w+)=/di, kind: "variable" },
    ],
  },

  vb: {
    scope: "indent",
    line: ["'"],
    rules: [
      { re: /^\s*(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overloads|Async|Static|MustOverride)\s+)*(?:Sub|Function)\s+(?<name>\w+)/di, kind: "function" },
      { re: /^\s*(?:(?:Public|Private|Protected|Friend|NotInheritable|Partial|MustInherit)\s+)*(?:Class|Module|Structure)\s+(?<name>\w+)/di, kind: "class" },
      { re: /^\s*(?:(?:Public|Private|Protected|Friend)\s+)*Enum\s+(?<name>\w+)/di, kind: "enum" },
      { re: /^\s*(?:(?:Public|Private|Protected|Friend|Shared|ReadOnly|WriteOnly|Overrides)\s+)*Property\s+(?<name>\w+)/di, kind: "property" },
    ],
  },

  pascal: {
    scope: "indent",
    line: ["//"],
    block: ["{", "}"],
    rules: [
      { re: /^\s*(?:procedure|function)\s+(?<name>\w+)/di, kind: "function" },
      {
        re: /^\s*(?<name>\w+)\s*=\s*(?<kw>class|record|packed\s+record|interface|enum)\b/di,
        kind: "class",
        kindOf: (m) => (/interface/.test(m.groups?.kw ?? "") ? "interface" : /enum/.test(m.groups?.kw ?? "") ? "enum" : "class"),
      },
      { re: /^\s*unit\s+(?<name>\w+)/di, kind: "module" },
    ],
  },

  haskell: {
    scope: "indent",
    line: ["--"],
    block: ["{-", "-}"],
    rules: [
      { re: /^(?<name>[a-z_][\w']*)\s*::/d, kind: "function" },
      {
        re: /^(?:data|newtype|type|class)\s+(?<name>[A-Z][\w']*)/d,
        kind: "type",
        kindOf: (m) => (/\bclass\b/.test(m[0]) ? "class" : "type"),
      },
      { re: /^(?<name>[a-z_][\w']*)\s+\S.*=/d, kind: "function" },
    ],
  },

  fsharp: {
    scope: "indent",
    line: ["//"],
    block: ["(*", "*)"],
    rules: [
      {
        re: /^\s*(?<kw>let|member|type|module|namespace|exception)\s+(?:rec\s+|mutable\s+|private\s+|internal\s+|inline\s+|public\s+)*(?<name>[\w'.]+)/d,
        kind: "function",
        kindOf: (m) => {
          const kw = m.groups?.kw ?? ""
          return kw === "module" || kw === "namespace" ? "module" : kw === "type" || kw === "exception" ? "type" : "function"
        },
      },
    ],
  },

  clojure: {
    scope: "indent",
    line: [";"],
    rules: [
      { re: /^\s*\((?:defn|defn-|defmacro|defmulti|defmethod|defonce|defprotocol|defrecord|deftype|defstruct)\s+(?<name>[\w\-*<>=!?+/'.]+)/d, kind: "function" },
      { re: /^\s*\(def\s+(?<name>[\w\-*<>=!?+/.]+)/d, kind: "variable" },
      { re: /^\s*\(ns\s+(?<name>[\w.\-]+)/d, kind: "namespace" },
    ],
  },

  elixir: {
    scope: "indent",
    line: ["#"],
    rules: [
      { re: /^\s*defmodule\s+(?<name>[\w.]+)/d, kind: "module" },
      { re: /^\s*def(?:p|macro|macrop|guard|guardp|struct|protocol|impl|exception|delegate)\s+(?<name>[\w?!]+)/d, kind: "function" },
      { re: /^\s*@(?:type|typep|callback|spec|opaque)\s+(?<name>[\w?!]+)/d, kind: "type" },
    ],
  },

  erlang: {
    scope: "indent",
    line: ["%"],
    rules: [
      { re: /^(?<name>[a-z][\w@]*)\s*\([^)]*\)\s*->/d, kind: "function" },
      { re: /^-(?:module|record|type|spec|callback|behaviour)\s*\(\s*(?<name>[\w.]+)/d, kind: "type" },
    ],
  },

  sol: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^\s*(?:abstract\s+)?contract\s+(?<name>\w+)/d, kind: "class" },
      {
        re: /^\s*(?:library|interface)\s+(?<name>\w+)/d,
        kind: "interface",
        kindOf: (m) => (/library/.test(m[0]) ? "class" : "interface"),
      },
      { re: /^\s*function\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s*constructor\s*\(/d, kind: "constructor", name: () => "constructor" },
      { re: /^\s*modifier\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s*(?:event|error)\s+(?<name>\w+)/d, kind: "event" },
      { re: /^\s*struct\s+(?<name>\w+)/d, kind: "struct" },
      { re: /^\s*(?:mapping\s*\([^)]*\)|[\w\[\]]+)\s+(?:public\s+|private\s+|internal\s+|constant\s+|immutable\s+)*(?<name>\w+)\s*(?:=|;)/d, kind: "field", topOnly: true },
    ],
  },

  wgsl: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      { re: /^\s*fn\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s*struct\s+(?<name>\w+)/d, kind: "struct" },
      { re: /^\s*(?:var|let|const)(?:<[^>]*>)?\s+(?<name>\w+)/d, kind: "constant", topOnly: true },
    ],
  },

  asm: {
    scope: "indent",
    line: [";", "#", "//"],
    rules: [
      { re: /^(?<name>[\w.$@?]+)\s*:/d, kind: "label" },
      { re: /^\s*(?<name>[\w.$@?]+)\s+(?:PROC|proc)\b/d, kind: "function" },
      { re: /^\s*(?<name>[\w.$@?]+)\s+(?:MACRO|macro)\b/d, kind: "macro" },
    ],
  },

  // SQL / INI / Makefile 这类没有嵌套结构的语言用 `level` 口径（全部平级或按节归属）
  sql: {
    scope: "level",
    line: ["--"],
    block: ["/*", "*/"],
    rules: [
      {
        re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+|GLOBAL\s+|LOCAL\s+)?(?<kw>TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|SCHEMA|DATABASE|TYPE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<name>[\w."\[\]]+)/di,
        kind: "table",
        kindOf: (m) => (/VIEW/.test(m.groups?.kw ?? "") ? "view" : /TYPE/.test(m.groups?.kw ?? "") ? "type" : "table"),
      },
      {
        re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?<kw>FUNCTION|PROCEDURE|TRIGGER)\s+(?<name>[\w."\[\]]*)/di,
        kind: "function",
        kindOf: (m) => (/PROCEDURE/.test(m.groups?.kw ?? "") ? "procedure" : "function"),
      },
      { re: /^\s*(?:WITH\s+(?:RECURSIVE\s+)?)?(?<name>\w+)\s+AS\s*\(/di, kind: "table" },
    ],
  },

  yaml: {
    scope: "indent",
    line: ["#"],
    maxDepth: 2,
    rules: [
      { re: /^\s*-\s+(?<name>[\w.$"@'*-][\w.$"@'*\- ]*?)\s*:/d, kind: "key" },
      { re: /^\s*(?<name>[\w.$"@'*-][\w.$"@'*\- ]*?)\s*:(?:\s|$)/d, kind: "key" },
    ],
  },

  ini: {
    scope: "level",
    line: ["#", ";"],
    keepStrings: true,
    rules: [
      { re: /^\[\[?\s*(?<name>[^\]]+?)\s*\]?\]/d, kind: "section", level: () => 0 },
      { re: /^(?<name>[\w.$"',\-]+)\s*[:=]/d, kind: "key", level: () => 1 },
    ],
  },

  markdown: {
    scope: "level",
    rules: [
      { re: /^\s{0,3}(?<hashes>#{1,6})\s+(?<name>.+?)\s*#*\s*$/d, kind: "heading", level: (m) => (m.groups?.hashes?.length ?? 1) - 1 },
    ],
  },

  latex: {
    scope: "level",
    line: ["%"],
    rules: [
      {
        re: /^\s*\\(?<kw>part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{(?<name>[^}]*)\}/d,
        kind: "section",
        level: (m) => Math.max(0, ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"].indexOf(m.groups?.kw ?? "section")),
      },
      { re: /^\s*\\label\{(?<name>[^}]*)\}/d, kind: "label" },
      { re: /^\s*\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\*?\{?\\(?<name>\w+)/d, kind: "macro" },
    ],
  },

  graphql: {
    scope: "brace",
    line: ["#"],
    rules: [
      {
        re: /^(?:extend\s+)?(?<kw>type|input|interface|union|enum|scalar|schema|directive)\s+(?<name>\w+)/d,
        kind: "type",
        kindOf: (m) => (/enum/.test(m.groups?.kw ?? "") ? "enum" : /interface|union/.test(m.groups?.kw ?? "") ? "interface" : "type"),
      },
      { re: /^(?:extend\s+)?(?:query|mutation|subscription|fragment)\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s+(?<name>\w+)\s*(?:\([^)]*\))?\s*:/d, kind: "field", innerOnly: true },
    ],
  },

  protobuf: {
    scope: "brace",
    line: ["//"],
    block: ["/*", "*/"],
    rules: [
      {
        re: /^\s*(?<kw>message|enum|service|oneof|extend|group)\s+(?<name>\w+)/d,
        kind: "class",
        kindOf: (m) => (/enum/.test(m.groups?.kw ?? "") ? "enum" : /service/.test(m.groups?.kw ?? "") ? "interface" : "class"),
      },
      { re: /^\s*rpc\s+(?<name>\w+)/d, kind: "function" },
      { re: /^\s*(?:optional\s+|required\s+|repeated\s+)?[\w.<>]+\s+(?<name>\w+)\s*=\s*\d+/d, kind: "field", innerOnly: true },
    ],
  },

  hcl: {
    scope: "brace",
    line: ["#", "//"],
    block: ["/*", "*/"],
    keepStrings: true,
    rules: [
      {
        re: /^\s*(?:resource|data)\s+"(?<type>[^"]+)"\s+"(?<name>[^"]+)"/d,
        kind: "resource",
        name: (m) => (m.groups?.type && m.groups?.name ? `${m.groups.type}.${m.groups.name}` : undefined),
      },
      {
        re: /^\s*(?<kw>variable|output|module|provider|terraform|backend|moved|import|locals)\b\s*"?(?<name>[\w.-]*)"?/d,
        kind: "variable",
        kindOf: (m) => (/locals|terraform/.test(m.groups?.kw ?? "") ? "key" : "variable"),
      },
      { re: /^\s*(?<name>[\w-]+)\s*=\s*\{/d, kind: "key", innerOnly: true },
    ],
  },

  dockerfile: {
    scope: "level",
    line: ["#"],
    rules: [
      { re: /^FROM\s+\S+\s+AS\s+(?<name>\w+)/di, kind: "module" },
      { re: /^ARG\s+(?<name>\w+)/di, kind: "variable" },
      { re: /^ENV\s+(?<name>\w+)/di, kind: "variable" },
    ],
  },

  makefile: {
    scope: "level",
    line: ["#"],
    rules: [
      { re: /^(?<name>[A-Za-z0-9_.%$()\[\]/+-]+)\s*:(?!=)/d, kind: "function" },
      { re: /^(?<name>[\w.]+)\s*[:+?]?=/d, kind: "variable" },
    ],
  },

  cmake: {
    scope: "level",
    line: ["#"],
    rules: [
      { re: /^\s*(?:function|macro)\s*\(\s*(?<name>[\w-]+)/di, kind: "function" },
      { re: /^\s*(?:add_executable|add_library|add_custom_target|add_subdirectory|add_test|project)\s*\(\s*(?<name>[\w./-]+)/di, kind: "function" },
      { re: /^\s*option\s*\(\s*(?<name>[\w-]+)/di, kind: "variable" },
    ],
  },
}

/* --------------------------- 提取与分层 --------------------------- */

/** 支持的 Monaco 语言 id（`symbols.ts` 据此注册语言选择器）。 */
export const SYMBOL_LANGUAGES: string[] = Object.keys(LANG_RULES)

/** 该语言是否支持符号提取（不支持的语言不注册 provider，交由编辑器内置语言服务）。 */
export function symbolsSupported(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANG_RULES, language)
}

/** 类性质容器：其内部成员按类成员语义改判（函数 → 方法、变量 → 字段）。
 *  命名空间/模块/包**不在此列**——C++ `namespace`、Go 包、Python 模块里的是自由函数，不是方法。 */
const CLASS_LIKE = new Set<SymKind>(["class", "interface", "struct", "trait", "enum", "object"])

/** 一行命中的原始定义（尚未建树）。 */
interface RawDef {
  name: string
  kind: SymKind
  line: number
  column: number
  /** 分层键：brace 口径为行首花括号深度、indent 为缩进宽度、level 为自带层级 */
  key: number
  /** 规则自带层级外的额外信息（level 口径用于 Markdown 标题） */
  level: number
}

/** 行内花括号净增量（字符串与注释已被掩码掉）。 */
function braceDelta(line: string): number {
  let d = 0
  for (const c of line) {
    if (c === "{") d++
    else if (c === "}") d--
  }
  return d
}

/** 名字所在列（优先用 `d` 标志给出的精确下标，环境不支持时按行内查找回退）。 */
function columnOf(m: RegExpExecArray, name: string): number {
  const g = (m as RegExpExecArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }).indices?.groups
  const idx = g?.name ?? g?.type ?? g?.kw
  if (idx) return idx[0]
  const at = m[0].indexOf(name)
  return at < 0 ? m.index : m.index + at
}

/** 逐行跑规则：命中即停（一行只提取一个符号，压缩写法下的多个定义不追）。 */
function matchLine(maskedLine: string, spec: LangSpec, line: number, indent: number, depth: number): RawDef | null {
  const isTop = spec.scope === "brace" ? depth === 0 : indent === 0
  for (const rule of spec.rules) {
    if (rule.topOnly && !isTop) continue
    if (rule.innerOnly && isTop) continue
    rule.re.lastIndex = 0
    const m = rule.re.exec(maskedLine)
    if (!m?.groups) continue
    const name = (rule.name ? rule.name(m) : m.groups.name)?.trim()
    if (!name) continue
    return {
      name,
      kind: rule.kindOf ? rule.kindOf(m) : rule.kind,
      line,
      column: columnOf(m, name),
      key: spec.scope === "brace" ? depth : spec.scope === "indent" ? indent : (rule.level ? rule.level(m) : 0),
      level: rule.level ? rule.level(m) : 0,
    }
  }
  return null
}

/** 扫描整份文本，得到按出现顺序的定义列表。 */
function scanDefs(masked: readonly string[], spec: LangSpec): RawDef[] {
  const tabWidth = spec.tabWidth ?? 4
  const defs: RawDef[] = []
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    const line = masked[i]!
    const lineDepth = depth
    depth += braceDelta(line)
    const def = matchLine(line, spec, i, indentWidth(line, tabWidth), lineDepth)
    if (def) defs.push(def)
  }
  return defs
}

/** 各语言里表示「构造器」的函数名（Java 另有「与类同名」的形态，见下）。 */
const CTOR_NAMES = new Set(["__init__", "__construct", "initialize", "constructor", "init"])

/** 容器内成员改判（规则表因此不必为「类方法」单写一套）。 */
function refineKind(kind: SymKind, name: string, parent: Sym | undefined): SymKind {
  if (!parent || !CLASS_LIKE.has(parent.kind)) return kind
  if (kind === "function" || kind === "method") {
    if (CTOR_NAMES.has(name.toLowerCase()) || parent.name === name) return "constructor"
    return "method"
  }
  if (kind === "variable") return "field"
  return kind
}

/**
 * 建树：分层键**严格递增**才算子级，相等或更浅则弹栈（同级与退层走同一条路径）。
 * 三种口径（花括号深度 / 缩进 / 自带层级）共用这一条规则，因此新增语言不需要新的分层逻辑。
 */
function buildTree(defs: readonly RawDef[]): Sym[] {
  const roots: Sym[] = []
  const stack: { sym: Sym; key: number }[] = []
  for (const d of defs) {
    while (stack.length && d.key <= stack[stack.length - 1]!.key) stack.pop()
    const parent = stack.length ? stack[stack.length - 1]!.sym : undefined
    const sym: Sym = {
      name: d.name,
      kind: refineKind(d.kind, d.name, parent),
      line: d.line,
      column: d.column,
      endLine: d.line,
      children: [],
    }
    if (parent) parent.children.push(sym)
    else roots.push(sym)
    stack.push({ sym, key: d.key })
  }
  return roots
}

/**
 * 计算结束行：符号范围延续到**下一个非后代定义**之前（IDE 大纲的通常口径），
 * 最后一个符号延续到文件末尾最后一个非空行；子级再按父范围收窄（不越过父的结尾）。
 */
function setRanges(syms: Sym[], lastLine: number, hasContent: (line: number) => boolean): void {
  const order: Sym[] = []
  const endIdx: number[] = []
  const walk = (list: Sym[]): void => {
    for (const s of list) {
      const at = order.length
      order.push(s)
      endIdx.push(at)
      walk(s.children)
      endIdx[at] = order.length - 1
    }
  }
  walk(syms)
  for (let i = 0; i < order.length; i++) {
    const s = order[i]!
    const next = endIdx[i]! + 1
    let limit = next < order.length ? order[next]!.line - 1 : lastLine
    // 尾随空行不算符号范围：回退到区间内最后一个有内容的行（至少到符号自身所在行）
    while (limit > s.line && !hasContent(limit)) limit--
    let end = s.line
    for (const c of s.children) end = Math.max(end, c.endLine)
    s.endLine = Math.max(end, limit)
  }
  const clamp = (list: Sym[], maxLine: number): void => {
    for (const s of list) {
      s.endLine = Math.min(s.endLine, maxLine)
      clamp(s.children, s.endLine)
    }
  }
  for (const s of syms) clamp(s.children, s.endLine)
}

/** 按层级裁剪（YAML 这类层级很深的配置只留前几层）。 */
function pruneDepth(syms: Sym[], maxDepth: number, depth = 0): Sym[] {
  if (depth >= maxDepth) return []
  return syms.map((s) => ({ ...s, children: pruneDepth(s.children, maxDepth, depth + 1) }))
}

/** 文本最后一个非空行号（0 基；全空返回 0）。 */
function lastContentLine(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) return i
  }
  return 0
}

/**
 * 提取文件内符号（层级树，按出现顺序）。语言不支持（或无非空内容）时返回空数组。
 */
export function extractSymbols(text: string, language: string): Sym[] {
  const spec = LANG_RULES[language]
  if (!spec || !text) return []
  const lines = text.split(/\r?\n/)
  const masked = maskLines(lines, spec)
  const defs = scanDefs(masked, spec)
  if (!defs.length) return []
  let tree = buildTree(defs)
  setRanges(tree, lastContentLine(masked), (line) => !!lines[line]?.trim())
  if (spec.maxDepth) tree = pruneDepth(tree, spec.maxDepth)
  return tree
}

/** 展平为列表（面板渲染与模糊筛选用），`qualified` 为 `Class.method` 形态。 */
export function flattenSymbols(symbols: readonly Sym[], parent = "", depth = 0): FlatSym[] {
  const out: FlatSym[] = []
  for (const s of symbols) {
    const qualified = parent ? `${parent}.${s.name}` : s.name
    out.push({ name: s.name, qualified, kind: s.kind, line: s.line, column: s.column, depth })
    out.push(...flattenSymbols(s.children, qualified, depth + 1))
  }
  return out
}

/** 收集所有同名定义（文件内跳转的候选；按出现顺序）。 */
export function findDefinitions(symbols: readonly Sym[], name: string): Sym[] {
  const out: Sym[] = []
  const walk = (list: readonly Sym[]): void => {
    for (const s of list) {
      if (s.name === name) out.push(s)
      walk(s.children)
    }
  }
  walk(symbols)
  return out
}

/**
 * 面板搜索：空查询按出现顺序全列；有查询走与「快速打开」同一套模糊匹配（复用 `fuzzyMatch`，
 * 保证两个面板的手感一致），名字前缀命中额外加权——找符号时「我要的就是这个名字」比对齐好看更重要。
 */
export function searchSymbols(symbols: readonly FlatSym[], query: string, limit = 200): FlatSym[] {
  const q = query.trim()
  if (!q) return symbols.slice(0, limit)
  const lower = q.toLowerCase()
  const scored: { sym: FlatSym; score: number }[] = []
  for (const s of symbols) {
    const m = fuzzyMatch(q, s.qualified)
    if (!m) continue
    const bonus = s.name.toLowerCase().startsWith(lower) ? 40 : 0
    scored.push({ sym: s, score: m.score + bonus })
  }
  scored.sort((a, b) => b.score - a.score || a.sym.line - b.sym.line)
  return scored.slice(0, limit).map((h) => h.sym)
}
