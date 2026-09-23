/**
 * LSP · 工程根探测（从文件所在目录向上找语言对应的工程标记文件）。
 *
 * 为什么单拉一层：工作台根（会话工作区 / 项目根 / 任意目录）与语言服务器眼中的「工程」常常不是同一个
 * 目录。Go 工程要 `go.mod`、Rust 要 `Cargo.toml`、C/C++ 要 `compile_commands.json`——服务器以 **cwd /
 * rootUri** 为基准解析模块与编译参数，把工作台根当工程根直接用，会出现「子目录里打开 .go 文件、gopls
 * 找不到 module」「clangd 拿不到 compile_commands」这类静默降级（补全变空、跳转失灵），且不报错。
 *
 * 规则：**从文件所在目录向上找第一个该语言的标记文件**（最近者胜，与 VSCode 的
 * 「按标记找 workspace root」同口径）；语言没有专属标记（YAML / shell 这类）时退到通用标记（`.git`）；
 * 都没有则回退工作台根。向上探测**会越过工作台根**（仓库在上级、工程根在会话工作区之外是常见情形）。
 *
 * 找到最近标记后还做一步「**工作区根细化**」：Cargo workspace 的成员 crate 各有 `Cargo.toml`，
 * 取最近的那个会给每个 crate 起一份 rust-analyzer（索引重复、并发上限被白白吃掉——实测歌白自己的
 * `keqing/rust` 就是这个形态：framework/torch/nsight 三个成员）。因此再向上找一层**声明了工作区的**
 * 标记（`Cargo.toml` 含 `[workspace]`、`go.work`、`package.json` 含 `workspaces`），命中就用它当工程根。
 * 这一步需要**读小的标记文件**（仅此三类、且命中后永久缓存，代价可忽略）。
 *
 * 两级缓存：命中（有工程根）永久、未命中短 TTL——工程根不会平白消失，而「刚加的 go.mod」应很快被认到。
 */

import { dirname, join, sep } from "node:path"
import { existsSync, readFileSync, statSync } from "node:fs"

/** 语言 → 工程标记文件（按优先级；取向上探测时遇到的第一个语言标记）。 */
export const PROJECT_MARKERS: Record<string, string[]> = {
  go: ["go.mod", "go.work"],
  rust: ["Cargo.toml"],
  c: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt"],
  cpp: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt"],
  "objective-c": ["compile_commands.json", "compile_flags.txt", ".clangd"],
  python: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg"],
  typescript: ["tsconfig.json", "jsconfig.json", "package.json"],
  javascript: ["package.json", "tsconfig.json", "jsconfig.json"],
  json: ["package.json", "tsconfig.json"],
  css: ["package.json"],
  scss: ["package.json"],
  less: ["package.json"],
  html: ["package.json"],
  lua: [".luarc.json", ".luarc.jsonc"],
  shell: [".shellcheckrc"],
  kotlin: ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle", "pom.xml"],
  java: ["pom.xml", "settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"],
  ruby: ["Gemfile", ".solargraph.yml"],
  php: ["composer.json"],
  dart: ["pubspec.yaml"],
  elixir: ["mix.exs"],
  swift: ["Package.swift"],
  scala: ["build.sbt"],
  yaml: [],
  csharp: ["omnisharp.json"],
}

/** 多大以内的标记文件才值得读（package.json 偶尔很大，读它是为了找 workspaces）。 */
export const MARKER_READ_MAX = 256 * 1024

/**
 * 「工作区标记」判定：该文件是否声明了一个工作区（即它的目录是工作区根）。
 *
 * - `Cargo.toml`：含 `[workspace]` 段（Cargo workspace 根）；
 * - `go.work`：存在即工作区根；
 * - `package.json`：含非空 `workspaces` 字段（npm/yarn/pnpm monorepo）。
 * 不做完整 JSON/TOML 解析——只要把声明性标记认准，读到畸形内容就当不匹配。
 */
export function isWorkspaceMarker(file: string, text: string): boolean {
  const name = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? ""
  if (name === "go.work") return true
  if (name === "cargo.toml") return /^\s*\[workspace[.\]]/m.test(text)
  if (name === "package.json") {
    try {
      const pkg = JSON.parse(text) as { workspaces?: unknown }
      const w = pkg.workspaces
      if (Array.isArray(w)) return w.length > 0
      return !!w && typeof w === "object"
    } catch {
      return false
    }
  }
  return false
}

/** 语言 → 该语言的「工作区标记」候选（细化工程根时按这些名字找）。 */
export const WORKSPACE_MARKERS: Record<string, string[]> = {
  rust: ["Cargo.toml"],
  go: ["go.work"],
  typescript: ["package.json"],
  javascript: ["package.json"],
  json: ["package.json"],
  css: ["package.json"],
  scss: ["package.json"],
  less: ["package.json"],
  html: ["package.json"],
}

/** 通用标记（语言无专属标记时退到它：仓库根通常就是合理的工程根）。 */
export const GENERIC_MARKERS = [".git", ".hg"]

/** 向上探测的层数上限（防病态深目录把探测拖成 IO 风暴）。 */
export const MAX_LEVELS = 24

/** 未命中结果的缓存时长（毫秒）：工程刚建立时能很快被认到。 */
export const NEGATIVE_TTL_MS = 10_000

export interface ProjectRootInfo {
  /** 语言服务器实际使用的工程根（未探测到 = 回退值）。 */
  abs: string
  /** 命中的标记文件名（语言标记或通用标记）；未命中为空串。 */
  marker: string
  /** 是否真探测到（false = 回退）。 */
  detected: boolean
  /** 探测起点（文件所在目录）到工程根的层数（0 = 文件目录自身命中）。 */
  levels: number
}

export interface DetectOptions {
  /** 文件绝对路径。 */
  fileAbs: string
  /** 工作台根绝对路径（探测不到时的回退值）。 */
  rootAbs: string
  /** Monaco 语言 id。 */
  language: string
  /** 标记文件存在性探测（测试注入）。 */
  exists?: (absFile: string) => boolean
  /** 标记文件读取（工作区根细化用；测试注入。缺省读磁盘，过大/不可读返回 null）。 */
  read?: (absFile: string) => string | null
  /** 目录 + 文件名拼接（测试注入；缺省 `node:path` 的 join——Windows 下产出反斜杠路径）。
   *  与 `parentOf` 配对注入才能完整模拟一套路径语义（只用 POSIX 假路径时缺了它会让标记探测查不中）。 */
  join?: (dir: string, name: string) => string
  /** 向上取父目录（测试注入；缺省 `node:path` 的 dirname）。 */
  parentOf?: (absDir: string) => string
  now?: () => number
  maxLevels?: number
  negativeTtlMs?: number
}

interface CacheEntry {
  info: ProjectRootInfo
  at: number
  /** 命中（detected）的条目永不过期；未命中的按 TTL 失效。 */
  detected: boolean
}

const cache = new Map<string, CacheEntry>()
/** 缓存条目上限（FIFO 淘汰）：工作台长开着浏览大量目录时不无界增长。 */
const CACHE_MAX = 400

/** 探测工程根（带缓存）。 */
export function detectProjectRoot(opts: DetectOptions): ProjectRootInfo {
  const exists = opts.exists ?? defaultExists
  const read = opts.read ?? defaultRead
  const joinPath = opts.join ?? join
  const parentOf = opts.parentOf ?? dirname
  const now = opts.now ?? Date.now
  const maxLevels = opts.maxLevels ?? MAX_LEVELS
  const negativeTtl = opts.negativeTtlMs ?? NEGATIVE_TTL_MS
  const language = String(opts.language ?? "").trim().toLowerCase()
  const startDir = dirname(opts.fileAbs)
  const key = `${language}|${startDir}`

  const hit = cache.get(key)
  if (hit && (hit.detected || now() - hit.at < negativeTtl)) {
    // 命中的工程根可能正是工作台根（回退值）：用当前 rootAbs 覆盖，避免根解析变化后拿到旧值
    return hit.info.detected ? hit.info : { ...hit.info, abs: opts.rootAbs }
  }

  const languageMarkers = PROJECT_MARKERS[language] ?? []
  const info = walk()
  remember(key, info, now())
  return info

  function walk(): ProjectRootInfo {
    let dir = startDir
    for (let level = 0; level <= maxLevels; level++) {
      // 语言标记优先：`package.json` 之于 Rust 文件毫无意义，不该成为它的工程根
      for (const marker of languageMarkers) {
        if (exists(joinPath(dir, marker))) {
          // 最近的标记未必是最优根：Cargo workspace 的成员 crate 要让位给工作区根（见文件头说明）
          const refined = refineToWorkspace(dir, level)
          return refined ?? { abs: dir, marker, detected: true, levels: level }
        }
      }
      const parent = parentOf(dir)
      // 到文件系统根（`parent === dir`）就停：再往上没有意义
      if (!parent || parent === dir || dir === sep) break
      dir = parent
    }
    // 语言标记一路没找到：退到通用标记（.git）
    dir = startDir
    for (let level = 0; level <= maxLevels; level++) {
      for (const marker of GENERIC_MARKERS) {
        if (exists(joinPath(dir, marker))) return { abs: dir, marker, detected: true, levels: level }
      }
      const parent = parentOf(dir)
      if (!parent || parent === dir || dir === sep) break
      dir = parent
    }
    return { abs: opts.rootAbs, marker: "", detected: false, levels: 0 }
  }

  /**
   * 工作区根细化：从 `fromDir` **继续向上**找第一个「声明了工作区」的标记；找到就用它当工程根。
   * 找不到（或语言没有工作区概念）返回 null，调用方用最近标记。
   */
  function refineToWorkspace(fromDir: string, fromLevel: number): ProjectRootInfo | null {
    const workspaceMarkers = WORKSPACE_MARKERS[language]
    if (!workspaceMarkers?.length) return null
    let dir = fromDir
    // 从**上一层**开始：当前目录自己就是最近标记，若它声明了工作区，那它本来就是工作区根
    for (let level = fromLevel + 1; level <= maxLevels; level++) {
      const parent = parentOf(dir)
      if (!parent || parent === dir || dir === sep) return null
      dir = parent
      for (const marker of workspaceMarkers) {
        const file = joinPath(dir, marker)
        if (!exists(file)) continue
        const text = read(file)
        if (text !== null && isWorkspaceMarker(file, text)) return { abs: dir, marker, detected: true, levels: level }
      }
    }
    return null
  }
}

function remember(key: string, info: ProjectRootInfo, at: number): void {
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, { info, at, detected: info.detected })
}

/** 清空探测缓存（测试与「重新探测」用）。 */
export function clearProjectRootCache(): void {
  cache.clear()
}

function defaultExists(absFile: string): boolean {
  try {
    return existsSync(absFile)
  } catch {
    return false
  }
}

/** 默认读取：只读小文件（超过 `MARKER_READ_MAX` 视为不可读，避免为一个 workspaces 字段拖进大文件）。 */
function defaultRead(absFile: string): string | null {
  try {
    if (statSync(absFile).size > MARKER_READ_MAX) return null
    return readFileSync(absFile, "utf8")
  } catch {
    return null
  }
}
