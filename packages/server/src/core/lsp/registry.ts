/**
 * LSP · 语言服务器注册表与可用性探测。
 *
 * 「本机有什么用什么」的落点：内置表给出各语言的主流服务器（可执行名 + 启动参数），
 * 用 `core/exec/which.ts` 在 PATH 上探测——探不到即该语言没有 LSP 能力，工作台照旧
 * （Monaco 内置语言服务与符号提取链路均不受影响，分工见 `packages/web/src/files/symbols.ts`）。
 *
 * `GEBAI_LSP_SERVERS` 覆盖格式（JSON 对象，键 = Monaco 语言 id，与 `core/fs/mime.ts:languageForPath` 同口径）：
 *
 * ```json
 * {
 *   "go": "/usr/local/bin/gopls",
 *   "rust": { "command": "rust-analyzer", "args": ["--log-file", "ra.log"] },
 *   "python": [ { "command": "pyright-langserver", "args": ["--stdio"] }, "pylsp" ],
 *   "json": null
 * }
 * ```
 *
 * 值语义：字符串 = 命令（无参）；对象 = `{ command, args?, id? }`；数组 = 多候选按序探测（取首个命中）；
 * `null` / `false` = 关闭该语言。**显式列出的语言一律启用**——含默认 opt-in 的语言
 * （TS/JS/JSON/CSS/HTML 已由 Monaco 内置语言服务覆盖，不配就不起外部服务器，免与内置服务重复出候选）。
 */

import { basename } from "node:path"
import { which as whichOnPath } from "../exec/which"

/** 一个候选服务器定义（可执行名/路径 + 启动参数）。 */
export interface LspServerDef {
  id: string
  languages: string[]
  command: string
  args: string[]
  /** 默认不启用：该语言已有内置语言服务覆盖，需显式配置才起外部服务器。 */
  optIn?: boolean
}

/** 探测命中：某语言实际可用的服务器。 */
export interface LspServerPick {
  language: string
  id: string
  /** 探测到的可执行文件（绝对路径）。 */
  command: string
  args: string[]
}

/** 已配置但本机未探测到（前端展示「未安装 xxx」用；不影响使用）。 */
export interface LspMissing {
  language: string
  id: string
  command: string
}

export interface LspRegistry {
  byLanguage: Map<string, LspServerPick>
  picks: LspServerPick[]
  missing: LspMissing[]
  /** 覆盖配置里的问题（非法 JSON / 非法项），只作诊断，不阻断。 */
  errors: string[]
}

/**
 * 内置服务器表（按候选优先级排列：同语言先列的被优先采用）。
 * 只列「主流且有稳定无参/标准参数启动方式」的实现。
 */
export const DEFAULT_SERVER_DEFS: LspServerDef[] = [
  { id: "gopls", languages: ["go"], command: "gopls", args: [] },
  { id: "rust-analyzer", languages: ["rust"], command: "rust-analyzer", args: [] },
  { id: "clangd", languages: ["c", "cpp", "objective-c"], command: "clangd", args: [] },
  { id: "pyright", languages: ["python"], command: "pyright-langserver", args: ["--stdio"] },
  { id: "pylsp", languages: ["python"], command: "pylsp", args: [] },
  { id: "lua-language-server", languages: ["lua"], command: "lua-language-server", args: [] },
  { id: "yaml-language-server", languages: ["yaml"], command: "yaml-language-server", args: ["--stdio"] },
  { id: "bash-language-server", languages: ["shell"], command: "bash-language-server", args: ["start"] },
  { id: "kotlin-language-server", languages: ["kotlin"], command: "kotlin-language-server", args: [] },
  { id: "solargraph", languages: ["ruby"], command: "solargraph", args: ["stdio"] },
  { id: "intelephense", languages: ["php"], command: "intelephense", args: ["--stdio"] },
  { id: "csharp-ls", languages: ["csharp"], command: "csharp-ls", args: [] },
  { id: "dart", languages: ["dart"], command: "dart", args: ["language-server"] },
  // opt-in：Monaco 内置语言服务（本地 worker）已覆盖这些语言，配了才起外部服务器
  { id: "typescript-language-server", languages: ["typescript", "javascript"], command: "typescript-language-server", args: ["--stdio"], optIn: true },
  { id: "vscode-json-language-server", languages: ["json"], command: "vscode-json-language-server", args: ["--stdio"], optIn: true },
  { id: "vscode-css-language-server", languages: ["css", "scss", "less"], command: "vscode-css-language-server", args: ["--stdio"], optIn: true },
  { id: "vscode-html-language-server", languages: ["html"], command: "vscode-html-language-server", args: ["--stdio"], optIn: true },
]

/** 覆盖项解析结果：语言 → 候选定义（null = 显式关闭该语言）。 */
interface Override {
  langs: Map<string, LspServerDef[] | null>
  errors: string[]
}

function defFromValue(language: string, raw: unknown, errors: string[]): LspServerDef | null {
  if (typeof raw === "string") {
    const command = raw.trim()
    if (!command) {
      errors.push(`${language}: 命令为空`)
      return null
    }
    return { id: basename(command.replace(/\\/g, "/")), languages: [language], command, args: [] }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { command?: unknown; args?: unknown; id?: unknown }
    const command = typeof o.command === "string" ? o.command.trim() : ""
    if (!command) {
      errors.push(`${language}: 缺少 command`)
      return null
    }
    const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : []
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : basename(command.replace(/\\/g, "/"))
    return { id, languages: [language], command, args }
  }
  errors.push(`${language}: 值须为字符串 / 对象 / 数组 / null`)
  return null
}

function parseOverrides(raw: unknown): Override {
  const out: Override = { langs: new Map(), errors: [] }
  if (raw === undefined || raw === null || raw === "") return out
  let obj: unknown = raw
  if (typeof raw === "string") {
    const s = raw.trim()
    if (!s) return out
    try {
      obj = JSON.parse(s)
    } catch (err) {
      out.errors.push(`GEBAI_LSP_SERVERS 不是合法 JSON：${(err as Error).message}`)
      return out
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    out.errors.push("GEBAI_LSP_SERVERS 须为 JSON 对象（键 = 语言 id）")
    return out
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const language = key.trim().toLowerCase()
    if (!language) continue
    if (value === null || value === false) {
      out.langs.set(language, null)
      continue
    }
    const list = Array.isArray(value) ? value : [value]
    const defs: LspServerDef[] = []
    for (const item of list) {
      const def = defFromValue(language, item, out.errors)
      if (def) defs.push(def)
    }
    out.langs.set(language, defs.length ? defs : null)
  }
  return out
}

/** 合并内置表与覆盖项：覆盖项**替换**该语言的默认候选（顺序即探测优先级）。 */
export function serverDefs(overrides?: unknown): { defs: LspServerDef[]; errors: string[] } {
  const parsed = parseOverrides(overrides)
  const defs: LspServerDef[] = []
  const overridden = new Set(parsed.langs.keys())
  for (const def of DEFAULT_SERVER_DEFS) {
    // opt-in 语言默认不启用（已有内置语言服务覆盖）：仅当被 GEBAI_LSP_SERVERS 显式列出才加入
    if (def.optIn) continue
    if (def.languages.some((l) => overridden.has(l))) continue
    defs.push(def)
  }
  for (const list of parsed.langs.values()) {
    if (!list) continue
    for (const def of list) defs.push(def)
  }
  return { defs, errors: parsed.errors }
}

/**
 * 探测可用服务器：按语言取首个 `which` 命中的候选。
 * `which` 可注入（测试用假探测表，不依赖本机 PATH）。
 */
export function resolveRegistry(opts: { overrides?: unknown; which?: (cmd: string) => string | null } = {}): LspRegistry {
  const probe = opts.which ?? whichOnPath
  const { defs, errors } = serverDefs(opts.overrides)
  const picks: LspServerPick[] = []
  const missing: LspMissing[] = []
  const byLanguage = new Map<string, LspServerPick>()
  for (const def of defs) {
    for (const language of def.languages) {
      if (byLanguage.has(language)) continue
      const found = probe(def.command)
      if (found) {
        const pick: LspServerPick = { language, id: def.id, command: found, args: def.args }
        byLanguage.set(language, pick)
        picks.push(pick)
      } else if (!missing.some((m) => m.language === language)) {
        missing.push({ language, id: def.id, command: def.command })
      }
    }
  }
  return { byLanguage, picks, missing, errors }
}

/** 语言 → 可用服务器（无则 undefined，调用方据此静默降级）。 */
export function serverForLanguage(reg: LspRegistry, language: string): LspServerPick | undefined {
  return reg.byLanguage.get(String(language ?? "").trim().toLowerCase())
}
