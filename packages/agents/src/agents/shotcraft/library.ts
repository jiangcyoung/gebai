/**
 * 技能库载荷与运行时准备（shotcraft 的"把库备齐"环节）：
 * - 载荷：上游 video-shotcraft zip（GitHub 主源 → AtomGit 镜像备源；SHOTCRAFT_SOURCE 可指定本地目录/本地 zip/自定义 URL）
 *   解包到 `<库根>/skill`（纯 TS 解包，复用已有 fflate；校验结构后写 skill.lock.json；幂等复用）。
 *   本地目录来源以指针登记（不复制 54MB），故一律经 resolveSkillDir 取实际目录。
 * - 运行时：把载荷里的模板工程复制成 `<库根>/runtime` 并安装依赖（npm ci → npm install → bun install 依次回退），
 *   各视频项目以目录联接复用同一 node_modules——依赖整机只装一次；安装耗时较长，状态写 runtime.lock.json 供 status 查询。
 */
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { unzipSync } from "fflate"
import type { ToolContext } from "@gebai/sdk"
import { DEFAULT_SOURCES, REQUIRED_ENTRIES, envGet, libraryRoot, lockPath, runtimeDir, skillDir } from "./paths"

/** 载荷来源形态：本地目录（指针）/ 本地 zip 文件 / 远程 URL。 */
export type SourceSpec = { kind: "local-dir"; path: string } | { kind: "local-zip"; path: string } | { kind: "url"; url: string; label: string }

export interface SkillLock {
  sourceKind: SourceSpec["kind"]
  /** 来源描述（URL 或本地路径）。 */
  source: string
  installedAt: string
  archiveBytes?: number
  archiveSha256?: string
  fileCount?: number
  /** 上游内容 revision（载荷内 gallery/api/library.json 的 revision 字段，用于追溯内容版本）。 */
  upstreamRevision?: string
  cards?: number
  styles?: number
}

export interface RuntimeLock {
  status: "installing" | "ready" | "failed"
  packageManager?: string
  remotionVersion?: string
  installedAt: string
  templateSignature: string
  error?: string
}

/** 可注入依赖（测试用假实现：不联网、不执行包管理器）。 */
export interface LibraryDeps {
  download?: (url: string) => Promise<Uint8Array>
  run?: (cmd: string[], opts: { cwd: string; onData?: (chunk: string) => void; timeoutMs?: number }) => Promise<{ code: number; output: string }>
  which?: (cmd: string) => string | null
  now?: () => Date
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function defaultDownload(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function defaultRun(cmd: string[], opts: { cwd: string; onData?: (chunk: string) => void; timeoutMs?: number }): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } })
  let output = ""
  const pump = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      output += text
      opts.onData?.(text)
      if (output.length > 200_000) output = output.slice(-100_000)
    }
  }
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)])
  const code = await proc.exited
  return { code, output }
}

function defaultWhich(cmd: string): string | null {
  const found = Bun.which(cmd)
  return found || null
}

/** 来源解析：SHOTCRAFT_SOURCE 未设置时用内置来源链（GitHub → AtomGit）。 */
export function parseSources(ctx: ToolContext): SourceSpec[] {
  const custom = envGet(ctx, "SHOTCRAFT_SOURCE")?.trim()
  if (!custom) return DEFAULT_SOURCES.map((s) => ({ kind: "url" as const, url: s.url, label: s.kind }))
  if (/^https?:\/\//i.test(custom)) return [{ kind: "url", url: custom, label: "custom" }]
  return /\.zip$/i.test(custom) ? [{ kind: "local-zip", path: custom }] : [{ kind: "local-dir", path: custom }]
}

export function readLock<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

export function readSkillLock(ctx: ToolContext): SkillLock | null {
  return readLock<SkillLock>(lockPath(ctx))
}

export function readRuntimeLock(ctx: ToolContext): RuntimeLock | null {
  return readLock<RuntimeLock>(join(libraryRoot(ctx), "runtime.lock.json"))
}

/** 技能库实际目录：本地目录来源直接指向该目录（指针登记，不复制）；其余来源为 `<库根>/skill`。 */
export function resolveSkillDir(ctx: ToolContext): string | null {
  const lock = readSkillLock(ctx)
  if (lock?.sourceKind === "local-dir") {
    const dir = lock.source
    return existsSync(join(dir, "SKILL.md")) ? dir : null
  }
  const dir = skillDir(ctx)
  return existsSync(join(dir, "SKILL.md")) ? dir : null
}

/** 结构校验：返回问题清单（空数组 = 就绪）。 */
export function validateSkillDir(dir: string): string[] {
  const problems: string[] = []
  for (const rel of REQUIRED_ENTRIES) if (!existsSync(join(dir, rel))) problems.push(`缺少 ${rel}`)
  const libPath = join(dir, "gallery/api/library.json")
  if (existsSync(libPath)) {
    try {
      const lib = JSON.parse(readFileSync(libPath, "utf8")) as { stats?: { cardCount?: number } }
      if (!lib.stats?.cardCount) problems.push("gallery/api/library.json 缺少卡片统计（stats.cardCount）")
    } catch {
      problems.push("gallery/api/library.json 不是合法 JSON")
    }
  }
  return problems
}

/** 载荷索引统计（卡片数/样式数/上游 revision），供工具输出与锁文件登记。 */
export function readLibraryStats(dir: string): { cards: number; styles: number; revision?: string } {
  try {
    const lib = JSON.parse(readFileSync(join(dir, "gallery/api/library.json"), "utf8")) as {
      stats?: { cardCount?: number; styleCount?: number }
      revision?: string
    }
    return { cards: lib.stats?.cardCount ?? 0, styles: lib.stats?.styleCount ?? 0, revision: lib.revision }
  } catch {
    return { cards: 0, styles: 0 }
  }
}

/** zip 条目 → 相对路径映射：剥掉归档顶层目录（GitHub/AtomGit 均为 `<repo>-<ref>/…`），拒绝越界路径。 */
export function normalizeZipEntries(files: Record<string, Uint8Array>): { entries: Map<string, Uint8Array>; skipped: number } {
  const paths = Object.keys(files)
  const roots = new Set(paths.map((p) => p.split("/")[0]))
  const strip = roots.size === 1 && paths.every((p) => p.includes("/")) ? `${[...roots][0]}/` : ""
  const entries = new Map<string, Uint8Array>()
  let skipped = 0
  for (const [raw, bytes] of Object.entries(files)) {
    const rel = strip && raw.startsWith(strip) ? raw.slice(strip.length) : raw
    if (!rel || rel.endsWith("/")) continue
    const segments = rel.split("/")
    if (segments.some((s) => s === ".." || s === "" || s === ".")) {
      skipped++
      continue
    }
    entries.set(rel, bytes)
  }
  return { entries, skipped }
}

/**
 * 还原 zip 快照降级的符号链接条目。
 *
 * 上游仓库用符号链接组织载荷（如 `workbench/demosrc → ../demos`），zip 快照会把它写成
 * **内容为目标路径的普通小文件**；下游按目录读它就会 ENOTDIR（工作台的 gen-index 即如此）。
 * 判据：普通文件 + 极小体积 + 内容为单行相对路径 + 目标在同包内确实是目录。命中则替换为
 * 真实符号链接；链接不可用（如 Windows 无权限）时退化为复制目标目录，仍保证下游可读。
 */
export function restoreLinkEntries(root: string): string[] {
  const repaired: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      let raw: string
      try {
        if (statSync(abs).size > 512) continue
        raw = readFileSync(abs, "utf8").trim()
      } catch {
        continue
      }
      // 候选：单行、无空白、形如相对路径（如 ../demos 或 ./assets/lib）
      if (!raw || /\s/.test(raw) || raw.length > 256) continue
      if (!/^\.{1,2}\/[\w./-]+$/.test(raw) && !/^[\w./-]+\/$/.test(raw)) continue
      const target = resolve(dirname(abs), raw)
      if (!target.startsWith(root)) continue
      let isDir = false
      try {
        isDir = statSync(target).isDirectory()
      } catch {
        isDir = false
      }
      if (!isDir) continue
      const rel = abs.slice(root.length + 1)
      rmSync(abs, { force: true })
      try {
        symlinkSync(raw, abs, "junction")
        repaired.push(`${rel} → ${raw}（符号链接）`)
      } catch {
        cpSync(target, abs, { recursive: true })
        repaired.push(`${rel} → ${raw}（复制目录，当前环境不支持符号链接）`)
      }
    }
  }
  walk(root)
  return repaired
}

/** 解包并落盘到目标目录（先写临时目录再改名，避免半包；落盘后还原符号链接条目）。 */
export function extractEntries(entries: Map<string, Uint8Array>, target: string): { fileCount: number; bytes: number; repaired: string[] } {
  const tmp = `${target}.tmp-${Date.now()}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  let bytes = 0
  for (const [rel, content] of entries) {
    const abs = join(tmp, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    bytes += content.byteLength
  }
  const repaired = restoreLinkEntries(tmp)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  renameSync(tmp, target)
  return { fileCount: entries.size, bytes, repaired }
}

export interface EnsureSkillResult {
  ok: boolean
  skillDir: string | null
  lock: SkillLock | null
  actions: string[]
  error?: string
}

/**
 * 确保技能库载荷就绪：已就绪且未要求 update → 复用；否则按来源链获取 → 解包 → 校验 → 登记锁文件。
 * 来源链逐个尝试（远程源失败换下一源），全部失败给出本地供给指引。
 */
export async function ensureSkill(
  ctx: ToolContext,
  opts: { update?: boolean; deps?: LibraryDeps } = {},
): Promise<EnsureSkillResult> {
  const deps = opts.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const actions: string[] = []
  const current = resolveSkillDir(ctx)
  if (current && !opts.update) {
    const problems = validateSkillDir(current)
    if (problems.length === 0) {
      actions.push(`技能库已就绪：${current}`)
      return { ok: true, skillDir: current, lock: readSkillLock(ctx), actions }
    }
    actions.push(`技能库校验异常（${problems.join("；")}），重新获取`)
  }

  const sources = parseSources(ctx)
  let lastError = ""
  for (const source of sources) {
    try {
      if (source.kind === "local-dir") {
        const problems = validateSkillDir(source.path)
        if (problems.length) throw new Error(`本地目录结构不符：${problems.join("；")}`)
        const stats = readLibraryStats(source.path)
        const lock: SkillLock = {
          sourceKind: "local-dir",
          source: source.path,
          installedAt: now().toISOString(),
          upstreamRevision: stats.revision,
          cards: stats.cards,
          styles: stats.styles,
        }
        mkdirSync(libraryRoot(ctx), { recursive: true })
        writeFileSync(lockPath(ctx), JSON.stringify(lock, null, 2))
        actions.push(`使用本地技能库目录（指针登记，不复制）：${source.path}`)
        return { ok: true, skillDir: source.path, lock, actions }
      }

      let bytes: Uint8Array
      let label: string
      if (source.kind === "local-zip") {
        bytes = new Uint8Array(readFileSync(source.path))
        label = source.path
        actions.push(`读取本地载荷包：${source.path}（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB）`)
      } else {
        const download = deps.download ?? defaultDownload
        actions.push(`下载技能库载荷：${source.url}`)
        bytes = await download(source.url)
        label = source.url
        actions.push(`下载完成：${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB`)
      }

      const files = unzipSync(bytes)
      const { entries, skipped } = normalizeZipEntries(files)
      if (entries.size === 0) throw new Error("归档为空")
      const target = skillDir(ctx)
      const { fileCount, repaired } = extractEntries(entries, target)
      const problems = validateSkillDir(target)
      if (problems.length) throw new Error(`载荷结构校验失败：${problems.join("；")}`)
      if (repaired.length) actions.push(`还原 zip 快照降级的符号链接：${repaired.join("、")}`)
      const stats = readLibraryStats(target)
      const lock: SkillLock = {
        sourceKind: source.kind,
        source: label,
        installedAt: now().toISOString(),
        archiveBytes: bytes.byteLength,
        archiveSha256: sha256Hex(bytes),
        fileCount,
        upstreamRevision: stats.revision,
        cards: stats.cards,
        styles: stats.styles,
      }
      writeFileSync(lockPath(ctx), JSON.stringify(lock, null, 2))
      actions.push(`解包落盘：${fileCount} 个文件${skipped ? `（跳过 ${skipped} 个越界条目）` : ""} → ${target}`)
      actions.push(`校验通过：${stats.cards} 张配方卡 / ${stats.styles} 条样式`)
      return { ok: true, skillDir: target, lock, actions }
    } catch (err) {
      lastError = (err as Error).message
      actions.push(`来源失败（${source.kind === "url" ? source.url : source.path}）：${lastError}`)
    }
  }
  return {
    ok: false,
    skillDir: resolveSkillDir(ctx),
    lock: readSkillLock(ctx),
    actions,
    error: `技能库获取失败（全部来源均不可用）：${lastError}。可改用离线供给——SHOTCRAFT_SOURCE 指向本地克隆目录或已下载的 zip，例如 SHOTCRAFT_SOURCE=/path/to/video-shotcraft`,
  }
}

/** 模板签名：模板 package.json 内容哈希（模板升级即触发运行时重装）。 */
export function templateSignature(skill: string): string {
  try {
    const pkg = readFileSync(join(skill, "template/package.json"), "utf8")
    return sha256Hex(new TextEncoder().encode(pkg)).slice(0, 16)
  } catch {
    return "missing"
  }
}

/** 项目需要复制的模板内容（排除依赖与产物）。 */
const TEMPLATE_COPY = ["package.json", "package-lock.json", "tsconfig.json", "remotion.config.ts", "src", "public"]
const TEMPLATE_IGNORE = /(^|[/\\])(node_modules|out|\.cache|\.remotion)([/\\]|$)/

export function copyTemplate(skill: string, target: string): string[] {
  mkdirSync(target, { recursive: true })
  const copied: string[] = []
  for (const entry of TEMPLATE_COPY) {
    const from = join(skill, "template", entry)
    if (!existsSync(from)) continue
    cpSync(from, join(target, entry), { recursive: true, filter: (src) => !TEMPLATE_IGNORE.test(src) })
    copied.push(entry)
  }
  return copied
}

export interface EnsureRuntimeResult {
  ok: boolean
  runtimeDir: string
  actions: string[]
  lock: RuntimeLock | null
  error?: string
}

/**
 * 确保共享运行时（预装模板工程）就绪：模板签名变化或 force/未安装时（重）装依赖。
 * 安装命令按项目内 package-lock.json 选 npm ci，缺锁文件用 npm install，npm 不可用回退 bun install；
 * 状态先落 "installing"，成功改 "ready"——长安装被工具超时打断时后续 status 仍能看到进行中/已完成。
 */
export async function ensureRuntime(
  ctx: ToolContext,
  opts: { force?: boolean; skill: string; deps?: LibraryDeps; onData?: (chunk: string) => void },
): Promise<EnsureRuntimeResult> {
  const deps = opts.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const which = deps.which ?? defaultWhich
  const run = deps.run ?? defaultRun
  const dir = runtimeDir(ctx)
  const actions: string[] = []
  const signature = templateSignature(opts.skill)
  const lock = readRuntimeLock(ctx)
  const hasNodeModules = existsSync(join(dir, "node_modules", "remotion"))
  if (!opts.force && lock?.status === "ready" && lock.templateSignature === signature && hasNodeModules) {
    actions.push(`共享运行时已就绪（Remotion ${lock.remotionVersion ?? "?"}，包管理器 ${lock.packageManager ?? "?"}）`)
    return { ok: true, runtimeDir: dir, actions, lock }
  }

  const copied = copyTemplate(opts.skill, dir)
  actions.push(`模板工程落位：${copied.join(", ")} → ${dir}`)

  const npm = which("npm")
  const bun = which("bun")
  const hasLockFile = existsSync(join(dir, "package-lock.json"))
  let cmd: string[] | null = null
  let pm = ""
  if (npm) {
    cmd = [npm, hasLockFile ? "ci" : "install", "--no-audit", "--no-fund"]
    pm = "npm"
  } else if (bun) {
    cmd = [bun, "install", "--no-summary"]
    pm = "bun"
  }
  if (!cmd) {
    const failed: RuntimeLock = { status: "failed", installedAt: now().toISOString(), templateSignature: signature, error: "未找到 npm 或 bun" }
    writeFileSync(join(libraryRoot(ctx), "runtime.lock.json"), JSON.stringify(failed, null, 2))
    return { ok: false, runtimeDir: dir, actions, lock: failed, error: "宿主机既无 npm 也无 bun，无法安装视频项目依赖" }
  }

  writeFileSync(
    join(libraryRoot(ctx), "runtime.lock.json"),
    JSON.stringify({ status: "installing", packageManager: pm, installedAt: now().toISOString(), templateSignature: signature } satisfies RuntimeLock, null, 2),
  )
  actions.push(`安装依赖：${cmd.join(" ")}（cwd=${dir}）`)
  const res = await run(cmd, { cwd: dir, onData: opts.onData, timeoutMs: 420_000 })
  if (res.code !== 0) {
    const tail = res.output.slice(-2000)
    const failed: RuntimeLock = { status: "failed", packageManager: pm, installedAt: now().toISOString(), templateSignature: signature, error: tail }
    writeFileSync(join(libraryRoot(ctx), "runtime.lock.json"), JSON.stringify(failed, null, 2))
    return { ok: false, runtimeDir: dir, actions, lock: failed, error: `依赖安装失败（${pm} 退出码 ${res.code}）：${tail.slice(-600)}` }
  }
  const remotionVersion = readInstalledRemotionVersion(dir)
  const ready: RuntimeLock = { status: "ready", packageManager: pm, remotionVersion: remotionVersion ?? undefined, installedAt: now().toISOString(), templateSignature: signature }
  writeFileSync(join(libraryRoot(ctx), "runtime.lock.json"), JSON.stringify(ready, null, 2))
  actions.push(`依赖安装完成：Remotion ${remotionVersion ?? "?"}`)
  return { ok: true, runtimeDir: dir, actions, lock: ready }
}

/** 读取工程内已安装的 Remotion 版本（remotion 包 package.json；未安装返回 null）。 */
export function readInstalledRemotionVersion(projectDir: string): string | null {
  for (const rel of ["node_modules/remotion/package.json", "node_modules/@remotion/renderer/package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectDir, rel), "utf8")) as { version?: string }
      if (pkg.version) return pkg.version
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null
}

/** 目录统计（大小/文件数，用于状态汇报）。 */
export function dirStats(dir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const walk = (p: string) => {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name))
      return
    }
    bytes += st.size
    files++
  }
  walk(dir)
  return { bytes, files }
}
