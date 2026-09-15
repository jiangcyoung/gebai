/**
 * 共享运行时：内置模板落位 + Remotion 依赖安装/复用 + 锁文件记账（整机只保留一份依赖）。
 *
 * 判定顺序：① 本库根运行时已就绪且模板签名匹配 → 直接复用；② 模板签名变化但本机依赖版本仍匹配 →
 * 重落位模板、沿用本机依赖（依赖未变不必重装）；③ 复用同实例内其他库根已装好的**同版本**运行时
 * （落位模板 + 其 node_modules 目录联接接入，省一次全量安装）；④ 自主安装：npm ci / npm install →
 * bun install 回退，无包管理器则明确报错。安装失败登记 status="failed" 与错误尾部，且**不清理**已落位
 * 文件（便于排查）。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { RUNTIME_READY_MARKER, TEMPLATE_REMOTION_VERSION, envGet, isRuntimeReady, libraryRoot, runtimeDir } from "./paths"
import { TEMPLATE_FILES, TEMPLATE_SIGNATURE } from "./template.generated"

export interface RuntimeLock {
  status: "ready" | "failed"
  packageManager: "npm" | "bun" | null
  remotionVersion: string | null
  installedAt: string
  templateSignature: string
  /** builtin=本包内置模板自主安装；shared=复用既有运行时的依赖（目录联接）。 */
  source: "builtin" | "shared"
  /** source=shared 时指向的运行时目录。 */
  linkedFrom?: string
  error?: string
}

/** 可注入依赖（测试用假实现：不联网、不执行包管理器）。 */
export interface RuntimeDeps {
  which?: (cmd: string) => string | null
  run?: (cmd: string[], opts: { cwd: string }) => Promise<{ code: number; stdout: string; stderr: string }>
  now?: () => Date
  /** 候选"既有可复用运行时"目录（默认由同实例库根扫描与 REEL_SHARED_RUNTIME 给出）。 */
  sharedCandidates?: string[]
}

export interface EnsureRuntimeResult {
  ok: boolean
  runtimeDir: string
  actions: string[]
  lock: RuntimeLock | null
  error?: string
}

/** 运行时锁文件落在库根（`{库根}/runtime.lock.json`）。 */
function runtimeLockPath(ctx: ToolContext): string {
  return join(libraryRoot(ctx), "runtime.lock.json")
}

export function readRuntimeLock(ctx: ToolContext): RuntimeLock | null {
  try {
    const parsed = JSON.parse(readFileSync(runtimeLockPath(ctx), "utf8")) as RuntimeLock
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function writeRuntimeLock(ctx: ToolContext, lock: RuntimeLock): void {
  const path = runtimeLockPath(ctx)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`)
}

/** 内置模板内容签名（== TEMPLATE_SIGNATURE，由生成脚本按模板各文件内容 + Remotion 版本合成）。 */
export function templateSignature(): string {
  return TEMPLATE_SIGNATURE
}

/** 模板 key 必须是包内相对路径（防越界写入）。 */
function isSafeRelPath(rel: string): boolean {
  if (!rel || rel.startsWith("/") || rel.startsWith("\\") || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false
  return !rel.split(/[/\\]/).some((seg) => seg === "" || seg === "." || seg === "..")
}

/** 把内置模板展开成真实文件到目标目录（覆盖写，不清理目标目录内的其他文件），返回写入的相对路径清单。 */
export function materializeTemplate(target: string): string[] {
  const written: string[] = []
  for (const rel of Object.keys(TEMPLATE_FILES).sort()) {
    if (!isSafeRelPath(rel)) throw new Error(`内置模板含非法相对路径（拒绝写入）：${rel}`)
    const abs = join(target, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, TEMPLATE_FILES[rel])
    written.push(rel)
  }
  return written
}

/** 目录内已安装的 Remotion 版本（读 node_modules/remotion/package.json；未安装返回 null）。 */
function remotionVersionIn(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, RUNTIME_READY_MARKER), "utf8")) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

/**
 * 候选「可复用的运行时」目录（其内含 `node_modules`）：
 * ① `REEL_SHARED_RUNTIME` 显式指定；② 同实例 `{GEBAI_HOME}/vendor/<其他库根>/runtime` ——
 * 本机若已有别的库根装好了**同版本** Remotion，直接联接复用可省数百 MB 重复安装。
 * 这里是按目录扫描的通用机制，不依赖任何具体库根的名字（本库根自身除外）。
 */
function defaultSharedCandidates(ctx: ToolContext): string[] {
  const out: string[] = []
  const explicit = envGet(ctx, "REEL_SHARED_RUNTIME")
  if (explicit) out.push(isAbsolute(explicit) ? explicit : resolve(ctx.workdir, explicit))
  const vendor = join(ctx.home ?? homedir(), "vendor")
  let entries: import("node:fs").Dirent[] = []
  try {
    entries = readdirSync(vendor, { withFileTypes: true })
  } catch {
    return out /* vendor 目录不存在：没有可复用项，走自主安装 */
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "reel") continue
    out.push(join(vendor, entry.name, "runtime"))
  }
  return out
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * 目录联接：POSIX 用目录符号链接、Windows 用 junction（两者均免管理员）。
 * 目标已存在（残留安装/旧联接）先移除，避免 EEXIST。
 */
function linkNodeModules(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  try {
    symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir")
  } catch (err) {
    throw new Error(
      `目录联接失败（${to} → ${from}）：${(err as Error).message}。可设置 REEL_LIBRARY_DIR 换一个可写位置，或改用独立安装（ensureRuntime force=true）`,
    )
  }
}

async function defaultRun(cmd: string[], opts: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } })
  const readAll = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return ""
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return new TextDecoder().decode(Buffer.concat(chunks))
  }
  const [stdout, stderr] = await Promise.all([
    readAll(proc.stdout as ReadableStream<Uint8Array> | null),
    readAll(proc.stderr as ReadableStream<Uint8Array> | null),
  ])
  const code = await proc.exited
  return { code, stdout, stderr }
}

function defaultWhich(cmd: string): string | null {
  try {
    return Bun.which(cmd) ?? null
  } catch {
    return null
  }
}

/**
 * 确保共享运行时（内置模板 + Remotion 依赖）就绪：见文件头判定顺序。
 * 安装/联接均写锁文件记账，失败以 status="failed" + error（错误尾部）落盘供 status 查询与排查。
 */
export async function ensureRuntime(ctx: ToolContext, opts: { force?: boolean; deps?: RuntimeDeps } = {}): Promise<EnsureRuntimeResult> {
  const deps = opts.deps ?? {}
  const now = deps.now ?? (() => new Date())
  const which = deps.which ?? defaultWhich
  const run = deps.run ?? defaultRun
  const dir = runtimeDir(ctx)
  const signature = templateSignature()
  const actions: string[] = []
  const existing = readRuntimeLock(ctx)

  // ① 已就绪：锁 ready + 签名匹配 + 依赖在位
  if (!opts.force && existing?.status === "ready" && existing.templateSignature === signature && isRuntimeReady(ctx)) {
    const origin = existing.source === "shared" ? `复用 ${existing.linkedFrom ?? "既有运行时"}` : (existing.packageManager ?? "内置安装")
    actions.push(`共享运行时已就绪（Remotion ${existing.remotionVersion ?? "?"}，${origin}）`)
    return { ok: true, runtimeDir: dir, actions, lock: existing }
  }

  mkdirSync(dir, { recursive: true })

  // ② 依赖已装但模板签名过期（模板改版未动依赖）→ 重落位模板即可，不必重装
  if (!opts.force && existsSync(join(dir, RUNTIME_READY_MARKER))) {
    const localVersion = remotionVersionIn(dir)
    if (localVersion === TEMPLATE_REMOTION_VERSION) {
      const written = materializeTemplate(dir)
      const linked = isSymlink(join(dir, "node_modules"))
      const lock: RuntimeLock = {
        status: "ready",
        packageManager: existing?.packageManager ?? null,
        remotionVersion: localVersion,
        installedAt: now().toISOString(),
        templateSignature: signature,
        source: linked ? "shared" : "builtin",
        linkedFrom: linked ? existing?.linkedFrom : undefined,
      }
      writeRuntimeLock(ctx, lock)
      actions.push(`模板已更新：重落位 ${written.length} 个文件，沿用本机依赖（Remotion ${localVersion}）`)
      return { ok: true, runtimeDir: dir, actions, lock }
    }
  }

  // ③ 复用既有运行时（同 Remotion 版本）：落位模板源码 + 依赖目录联接
  for (const candidate of deps.sharedCandidates ?? defaultSharedCandidates(ctx)) {
    if (resolve(candidate) === resolve(dir)) continue
    if (!existsSync(join(candidate, RUNTIME_READY_MARKER))) continue
    const version = remotionVersionIn(candidate)
    if (version !== TEMPLATE_REMOTION_VERSION) {
      actions.push(`跳过既有运行时 ${candidate}：Remotion 版本 ${version ?? "未知"} ≠ 内置模板要求 ${TEMPLATE_REMOTION_VERSION}`)
      continue
    }
    const written = materializeTemplate(dir)
    actions.push(`内置模板落位：${written.length} 个文件 → ${dir}`)
    try {
      linkNodeModules(join(candidate, "node_modules"), join(dir, "node_modules"))
    } catch (err) {
      actions.push(`复用失败：${(err as Error).message}`)
      break
    }
    actions.push(`复用既有运行时依赖（目录联接）：${join(candidate, "node_modules")} → ${join(dir, "node_modules")}`)
    const lock: RuntimeLock = {
      status: "ready",
      packageManager: null,
      remotionVersion: version,
      installedAt: now().toISOString(),
      templateSignature: signature,
      source: "shared",
      linkedFrom: candidate,
    }
    writeRuntimeLock(ctx, lock)
    return { ok: true, runtimeDir: dir, actions, lock }
  }

  // ④ 自主安装
  const written = materializeTemplate(dir)
  actions.push(`内置模板落位：${written.length} 个文件 → ${dir}`)
  // 旧联接会让包管理器装到别处，安装前先摘除（真实目录保留，由包管理器增量补齐）
  if (isSymlink(join(dir, "node_modules"))) rmSync(join(dir, "node_modules"), { recursive: true, force: true })

  const npm = which("npm")
  const bun = which("bun")
  let cmd: string[] | null = null
  let pm: "npm" | "bun" | null = null
  if (npm) {
    cmd = [npm, existsSync(join(dir, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"]
    pm = "npm"
  } else if (bun) {
    cmd = [bun, "install", "--no-summary"]
    pm = "bun"
  }
  if (!cmd) {
    const error = `宿主机既无 npm 也无 bun，无法安装视频运行时依赖：请安装 Node.js（含 npm）或 Bun 后重试，或用 REEL_LIBRARY_DIR 指向已有运行时目录`
    const failed: RuntimeLock = {
      status: "failed",
      packageManager: null,
      remotionVersion: null,
      installedAt: now().toISOString(),
      templateSignature: signature,
      source: "builtin",
      error,
    }
    writeRuntimeLock(ctx, failed)
    return { ok: false, runtimeDir: dir, actions, lock: failed, error }
  }

  actions.push(`安装依赖：${cmd.join(" ")}（cwd=${dir}）`)
  const res = await run(cmd, { cwd: dir })
  if (res.code !== 0) {
    const tail = `${res.stdout}\n${res.stderr}`.trim().slice(-400) || `退出码 ${res.code}`
    const failed: RuntimeLock = {
      status: "failed",
      packageManager: pm,
      remotionVersion: null,
      installedAt: now().toISOString(),
      templateSignature: signature,
      source: "builtin",
      error: tail,
    }
    writeRuntimeLock(ctx, failed)
    return { ok: false, runtimeDir: dir, actions, lock: failed, error: `依赖安装失败（${pm} 退出码 ${res.code}，已落位文件保留在 ${dir} 便于排查）：${tail}` }
  }

  const remotionVersion = remotionVersionIn(dir)
  const lock: RuntimeLock = {
    status: "ready",
    packageManager: pm,
    remotionVersion,
    installedAt: now().toISOString(),
    templateSignature: signature,
    source: "builtin",
  }
  writeRuntimeLock(ctx, lock)
  actions.push(`依赖安装完成：Remotion ${remotionVersion ?? "?"}（${pm}）`)
  return { ok: true, runtimeDir: dir, actions, lock }
}
