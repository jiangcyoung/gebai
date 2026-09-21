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
 * 都没有则回退工作台根。向上探测**会越过工作台根**（仓库在上级、工程根在会话工作区之外是常见情形），
 * 但只做「文件是否存在」的探测，不读内容、不列举目录，路径边界仍由 Root 抽象把守。
 *
 * 两级缓存：命中（有工程根）永久、未命中短 TTL——工程根不会平白消失，而「刚加的 go.mod」应很快被认到。
 */

import { dirname, join, sep } from "node:path"
import { existsSync } from "node:fs"

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

/** 通用标记（语言无专属标记时的兜底：仓库根通常就是合理的工程根）。 */
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
        if (exists(join(dir, marker))) return { abs: dir, marker, detected: true, levels: level }
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
        if (exists(join(dir, marker))) return { abs: dir, marker, detected: true, levels: level }
      }
      const parent = parentOf(dir)
      if (!parent || parent === dir || dir === sep) break
      dir = parent
    }
    return { abs: opts.rootAbs, marker: "", detected: false, levels: 0 }
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
