/**
 * `GET /api/v1/git/status` 的**响应契约**：两个「根」各自叫什么、分别是哪个值。
 *
 * 为什么值得单独钉一条：这个端点的响应里同时存在两个「根」，早前写成 `{ root: rootId, ...status }`，
 * 而 `status` 自己也带 `root`（服务里是**仓库根绝对路径**）——展开顺序把它覆盖了，于是客户端
 * 拿到的 `root` 实际是仓库路径，而类型注释写的是「请求时给的根 id」。两边说的不是一回事且不报错：
 * 子目录根（`abs:/repo/sub`）算不出「仓库内前缀」就是从这来的——变更面板于是按「整仓库」展示，
 * 行的仓库相对路径也没人补前缀，点开就是「文件不存在」。
 *
 * 现在的契约：`root` = 请求给的根 id（回显），`repoRoot` = 仓库根绝对路径（可能不出现：非仓库时）。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, SERVICE_USER, type AppDeps } from "../app"
import type { ServerConfig } from "../core/base/config"
import { GitService } from "../core/git/service"

const dirs: string[] = []
function tmpRepo(prefix = "git-status-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

function makeDeps(home: string): AppDeps {
  const config = {
    auth: "local",
    basePath: "/",
    gebaiHome: home,
    fsEnabled: true,
    fsWrite: true,
    gitWrite: true,
    gitRemote: false,
  } as unknown as ServerConfig
  return {
    config,
    auth: { defaultUser: () => SERVICE_USER },
    sandbox: { enforcedFor: () => false, isExempt: () => true },
    engine: { workbenchProjects: () => ({ projects: [], binds: [] }) },
    store: { getEnv: async () => ({}) },
    git: new GitService({ writeEnabled: true, remoteEnabled: false }),
  } as unknown as AppDeps
}

describe("/api/v1/git/status 契约", () => {
  test("root = 请求的根 id，repoRoot = 仓库根绝对路径（子目录根也能往上定位）", async () => {
    const repo = tmpRepo()
    git(repo, "init")
    git(repo, "config", "user.email", "t@t")
    git(repo, "config", "user.name", "t")
    const sub = join(repo, "sub")
    execFileSync("mkdir", ["-p", sub])
    execFileSync("sh", ["-c", `printf 'x\\n' > ${join(sub, "a.txt")}`])
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "init")

    const app = createApp(makeDeps(tmpRepo("home-")))
    const rootId = `abs:${sub}`
    const res = await app.request(`/api/v1/git/status?root=${encodeURIComponent(rootId)}`, { method: "GET" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { root: string; repoRoot?: string; isRepo: boolean; changes: unknown[] }
    expect(body.isRepo).toBe(true)
    expect(body.root).toBe(rootId) // 回显根 id（不是仓库路径）
    expect(body.repoRoot).toBe(repo) // 仓库根绝对路径（上层据此算前缀、给根之外的改动换根）
  })

  test("非仓库根：isRepo=false 且不带 repoRoot", async () => {
    const plain = tmpRepo("plain-")
    const app = createApp(makeDeps(tmpRepo("home-")))
    const res = await app.request(`/api/v1/git/status?root=${encodeURIComponent(`abs:${plain}`)}`, { method: "GET" })
    const body = (await res.json()) as { root: string; repoRoot?: string; isRepo: boolean }
    expect(body.isRepo).toBe(false)
    expect(body.root).toBe(`abs:${plain}`)
    expect(body.repoRoot).toBeUndefined()
  })
})

process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
