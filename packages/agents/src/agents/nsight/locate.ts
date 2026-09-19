/**
 * 代码定位层（nsight 专用）：把报告中的符号落到工程源码位置——「定位到代码问题」的最后一环。
 *
 * 报告里的证据形如内核符号（含模板与参数签名的 demangled 名）、NVTX 区间名、CUDA API 名、
 * 以及（ncu 携带源码关联时的）源文件名。开发者需要的是**文件:行**与上下文，故本层：
 *
 * - **符号归一**：demangled 名去模板参数/参数列表，得到可搜索的基名（`integrateBodies<float>(...)` → `integrateBodies`）；
 * - **多形态匹配**：内核定义（`__global__`/`__device__`）、启动点（`name<<<`）、NVTX 名称字面量、任意名称引用；
 * - **有界扫描**：文件数、单文件大小、命中数均设上限（大仓库不会被一次定位拖垮），超限如实告知；
 * - **权威通道**：目录遍历与文件读取走宿主注入的 ctx.listFiles/readFile（沙箱与范围约束由引擎统一执行）。
 */
import type { ToolContext } from "@gebai/sdk"
import type { SymbolHint } from "./findings"

/** 源码扩展名白名单（CUDA/C++/Python/常见绑定层）。 */
export const SOURCE_EXTS = [".cu", ".cuh", ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hxx", ".py", ".pyx", ".rs", ".ts", ".js", ".m", ".mm"]

export const LOCATE_LIMITS = {
  maxFiles: 4_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 80 * 1024 * 1024,
  maxMatchesPerSymbol: 25,
  contextLines: 1,
} as const

/** 通用/无区分度的标识符（库命名空间与模板参数名）：作为搜索词只产生噪声，直接排除。 */
const GENERIC_TERMS = new Set([
  "Kernel",
  "kernel",
  "at",
  "c10",
  "cutlass",
  "cuda",
  "native",
  "detail",
  "impl",
  "void",
  "const",
  "bool",
  "char",
  "main",
  "test",
  "std",
  "torch",
])

/** 内核 demangled 名 → 候选函数基名（去模板、去参数、去返回类型与命名空间限定的首个可用名）。 */
export function symbolBaseNames(name: string): string[] {
  const out = new Set<string>()
  const trimmed = name.trim()
  if (!trimmed) return []
  // mangled 名（Itanium ABI）无法直接作为源码搜索词：整串只是经过名字修饰的单一标识符
  if (/^_Z/.test(trimmed)) return []
  // 形如 "void integrateBodies<float>(vec4<T1>*, ...)" / "addConstDouble(int, double*, ...)"
  const beforeParams = trimmed.split("(")[0] ?? trimmed
  const noTemplate = beforeParams.split("<")[0] ?? beforeParams
  const lastToken = noTemplate.trim().split(/[\s*&:]+/).filter(Boolean).pop() ?? ""
  if (lastToken) out.add(lastToken)
  // 形如 "cudaMalloc_v3020"：取去掉版本后缀的名字
  const noVersion = lastToken.replace(/_v\d+$/, "")
  if (noVersion) out.add(noVersion)
  // 形如 "at::native::vectorized_elementwise_kernel<4, ...>"：取首个非通用标识符
  const firstIdent = (trimmed.match(/[A-Za-z_]\w*/g) ?? []).find((t) => !GENERIC_TERMS.has(t))
  if (firstIdent) out.add(firstIdent)
  return [...out].filter((t) => t.length >= 4 && /^[A-Za-z_]\w*$/.test(t) && !GENERIC_TERMS.has(t))
}

export interface SourceMatch {
  /** 相对项目根的路径（便于直接用于 read 工具）。 */
  path: string
  line: number
  /** 命中类别：内核定义 / 启动点 / 名称引用 / 源文件。 */
  kind: "kernel-def" | "kernel-launch" | "nvtx" | "reference" | "source-file"
  /** 命中行内容（截断）。 */
  text: string
  /** 命中行前后上下文（最多 contextLines 行）。 */
  context?: string[]
}

export interface SymbolLocateResult {
  symbol: string
  kind: SymbolHint["kind"]
  /** 归一后的搜索词。 */
  terms: string[]
  matches: SourceMatch[]
  /** 是否因上限截断。 */
  truncated: boolean
  note?: string
}

export interface LocateSummary {
  results: SymbolLocateResult[]
  scannedFiles: number
  scannedBytes: number
  /** 扫描是否因上限提前结束（结果可能不完整）。 */
  scanTruncated: boolean
  /** 工程根（相对路径基准）。 */
  root: string
}

interface Candidate {
  path: string
  size: number
}

/**
 * 在工程内定位符号。
 * @param root 项目根（绝对路径）——相对路径基准与遍历起点
 */
export async function locateSymbols(
  ctx: ToolContext,
  symbols: SymbolHint[],
  opts: { root?: string; extraTerms?: string[] } = {},
): Promise<LocateSummary> {
  const root = opts.root ?? ctx.workdir
  const files = await ctx.listFiles().catch(() => [])
  const candidates: Candidate[] = []
  let totalBytes = 0
  let scanTruncated = false
  for (const f of files) {
    if (f.isDir) continue
    const lower = f.path.toLowerCase()
    if (!SOURCE_EXTS.some((ext) => lower.endsWith(ext))) continue
    // 超大源文件跳过：扫描覆盖不完整，如实标记（结果可能漏）
    if (f.size > LOCATE_LIMITS.maxFileBytes) {
      scanTruncated = true
      continue
    }
    if (candidates.length >= LOCATE_LIMITS.maxFiles || totalBytes + f.size > LOCATE_LIMITS.maxTotalBytes) {
      scanTruncated = true
      break
    }
    candidates.push({ path: f.path, size: f.size })
    totalBytes += f.size
  }

  // 每个候选文件只读一次，供全部符号复用
  const contents = new Map<string, string[]>()
  for (const c of candidates) {
    const abs = ctx.resolvePath(c.path)
    const text = await ctx.readFile(abs).catch(() => null)
    if (text) contents.set(c.path, text.split(/\r?\n/))
  }

  const results: SymbolLocateResult[] = []
  for (const sym of symbols) {
    const terms = [
      ...new Set(
        [...symbolBaseNames(sym.value), ...(opts.extraTerms ?? []), ...(sym.value.includes(" ") || sym.value.includes("(") ? [] : [sym.value])].filter(
          (t) => t.length >= 2,
        ),
      ),
    ]
    // 词边界匹配：子串匹配会把 "at" 命中 "path"、"range" 命中 "arrange" 之类的噪声
    const termRes = terms.map((t) => ({ term: t, re: new RegExp(`\\b${escapeRe(t)}\\b`) }))
    const matches: SourceMatch[] = []
    let truncated = false
    if (sym.kind === "file") {
      // 源文件提示：直接按文件名匹配工程内同名文件
      const wanted = sym.value.replace(/\\/g, "/").split("/").pop()!.toLowerCase()
      for (const c of candidates) {
        const base = c.path.replace(/\\/g, "/").split("/").pop()!.toLowerCase()
        if (base === wanted) {
          matches.push({ path: c.path, line: 1, kind: "source-file", text: `报告携带源文件：${sym.value}` })
          if (matches.length >= LOCATE_LIMITS.maxMatchesPerSymbol) break
        }
      }
      results.push({ symbol: sym.value, kind: sym.kind, terms: [wanted], matches, truncated })
      continue
    }
    outer: for (const [path, lines] of contents) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const { term, re } of termRes) {
          if (!re.test(line)) continue
          // 命中分类：定义 / 启动点 / NVTX 字面量 / 一般引用
          const isKernelDef = /__global__|__device__|__host__\s+__device__/.test(line) && new RegExp(`\\b${escapeRe(term)}\\s*[(<]`).test(line)
          const isLaunch = new RegExp(`\\b${escapeRe(term)}\\s*<<<`).test(line)
          const isNvtx = /nvtx|record_function|RangePush|profiler/.test(line)
          const kind: SourceMatch["kind"] = isKernelDef ? "kernel-def" : isLaunch ? "kernel-launch" : isNvtx ? "nvtx" : "reference"
          if (matches.length >= LOCATE_LIMITS.maxMatchesPerSymbol) {
            truncated = true
            break outer
          }
          matches.push({
            path,
            line: i + 1,
            kind,
            text: line.trim().slice(0, 200),
            context: LOCATE_LIMITS.contextLines > 0 ? lines.slice(Math.max(0, i - LOCATE_LIMITS.contextLines), i + LOCATE_LIMITS.contextLines + 1).map((l) => l.trim().slice(0, 160)) : undefined,
          })
          break
        }
      }
    }
    // 优先展示定义与启动点
    const order: Record<SourceMatch["kind"], number> = { "kernel-def": 0, "kernel-launch": 1, nvtx: 2, reference: 3, "source-file": 4 }
    matches.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path) || a.line - b.line)
    results.push({
      symbol: sym.value,
      kind: sym.kind,
      terms,
      matches,
      truncated,
      note: matches.length ? undefined : noteForMissing(sym),
    })
  }

  return { results, scannedFiles: contents.size, scannedBytes: totalBytes, scanTruncated, root }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 未命中时给出下一步建议（区分内核与 NVTX/框架场景，避免模型盲目重复搜索）。 */
function noteForMissing(sym: SymbolHint): string {
  if (/^_Z/.test(sym.value)) {
    return "该符号是 mangled 名（Itanium ABI 名字修饰），无法作为源码搜索词——请改用 demangled 名或显式传函数名/文件名（extra_terms）。"
  }
  if (sym.kind === "nvtx") {
    return "工程内未找到该 NVTX 名称字面量——可能由框架/库内部打点（如 torch.profiler 的算子名），或名称在运行时拼接。可改为在代码中搜索该阶段对应的函数名。"
  }
  if (sym.kind === "api") {
    return "未在源码中找到该 API 调用点——可能经宏/封装层调用，或该调用来自第三方库。"
  }
  return "工程内未找到该符号——可能源码不在当前项目根内（用 project 参数指定正确根），或该内核来自预编译库（如 cuBLAS/cuDNN/PyTorch 内置算子），此时优化点在上层调用方式而非内核源码。"
}

/** 渲染定位结果为紧凑文本（模型可直接引用 文件:行）。 */
export function renderLocate(summary: LocateSummary): string[] {
  const lines: string[] = []
  const kindLabel: Record<SourceMatch["kind"], string> = {
    "kernel-def": "内核定义",
    "kernel-launch": "启动点",
    nvtx: "NVTX/打点",
    reference: "名称引用",
    "source-file": "报告源文件",
  }
  for (const r of summary.results) {
    lines.push(`【${r.symbol}】（${r.kind}${r.terms.length ? `，搜索词：${r.terms.join(" / ")}` : ""}）`)
    if (!r.matches.length) {
      lines.push(`  （无命中）${r.note ?? ""}`)
      continue
    }
    for (const m of r.matches.slice(0, 8)) {
      lines.push(`  ${kindLabel[m.kind]}  ${m.path}:${m.line}`)
      lines.push(`      ${m.text}`)
    }
    if (r.matches.length > 8) lines.push(`  …共 ${r.matches.length} 处命中（已按定义/启动点优先排序）`)
    if (r.truncated) lines.push("  （命中数达上限，已截断）")
  }
  return lines
}
