/**
 * 变更监听中枢（`core/fs/watch.ts`）：订阅/共享 watcher、事件合并、长轮询唤醒、宽限回收。
 *
 * 为什么值得单测：它是「页面自己会变」的底层，坏了不报错——watcher 泄漏只是进程里 fd 越来越多、
 * 唤醒丢了只是界面慢半拍。真假文件系统事件在测试里可控（临时目录 + 真实写入），故直接测真行为。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FsWatchHub, gitWatchDirs } from "./watch"

const dirs: string[] = []
function tmp(prefix = "watch-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe("FsWatchHub", () => {
  test("订阅目录后写入文件会唤醒 wait（并带上变更路径）", async () => {
    const root = tmp()
    const hub = new FsWatchHub({ debounceMs: 20 })
    const release = hub.subscribe([{ path: root }])
    const base = hub.revision
    const waiting = hub.wait(base, 5_000)
    await tick(60)
    writeFileSync(join(root, "a.txt"), "hi")
    const snap = await waiting
    expect(snap.rev).toBeGreaterThan(base)
    expect(snap.paths?.some((p) => p.endsWith("a.txt"))).toBe(true)
    release()
    hub.dispose()
  })

  test("没有变化时 wait 按时超时返回（心跳），修订号不变", async () => {
    const root = tmp()
    const hub = new FsWatchHub({ debounceMs: 20 })
    const release = hub.subscribe([{ path: root }])
    const base = hub.revision
    const started = Date.now()
    const snap = await hub.wait(base, 150)
    expect(snap.rev).toBe(base)
    expect(Date.now() - started).toBeGreaterThanOrEqual(120)
    release()
    hub.dispose()
  })

  test("已经变过（rev 领先）时立即返回，不进入等待", async () => {
    const root = tmp()
    const hub = new FsWatchHub({ debounceMs: 20 })
    const release = hub.subscribe([{ path: root }])
    const base = hub.revision
    writeFileSync(join(root, "b.txt"), "x")
    await tick(80)
    const started = Date.now()
    const snap = await hub.wait(base, 5_000)
    expect(snap.rev).toBeGreaterThan(base)
    expect(Date.now() - started).toBeLessThan(100)
    release()
    hub.dispose()
  })

  test("同一目录多订阅者共享一个 watcher；全部释放后按宽限期回收", async () => {
    const root = tmp()
    const hub = new FsWatchHub({ debounceMs: 20, graceMs: 60 })
    const r1 = hub.subscribe([{ path: root }])
    const r2 = hub.subscribe([{ path: root }])
    expect(hub.watching).toBe(1)
    r1()
    expect(hub.watching).toBe(1) // 还有一个订阅者在用
    r2()
    expect(hub.watching).toBe(1) // 宽限期内不拆（下一轮长轮询会立刻再来）
    await tick(90)
    // 惰性回收：下一次订阅时顺手扫掉过期项
    const r3 = hub.subscribe([{ path: root }])
    // 旧项已回收 → 新订阅重建一个（仍是 1 个目录，但不是同一个孤儿）
    expect(hub.watching).toBe(1)
    r3()
    hub.dispose()
  })

  test("最后一个订阅者释放后，宽限期一到就自行回收（不必等下一次订阅）", async () => {
    const root = tmp()
    const hub = new FsWatchHub({ debounceMs: 20, graceMs: 50 })
    const release = hub.subscribe([{ path: root }])
    expect(hub.watching).toBe(1)
    release()
    expect(hub.watching).toBe(1) // 宽限期内不拆（长轮询循环之间不留缝）
    await tick(120)
    expect(hub.watching).toBe(0)
    hub.dispose()
  })

  test("不存在的目录挂不上也不影响其它目录（失败静默 + 退避）", async () => {
    const root = tmp()
    const hub = new FsWatchHub({ debounceMs: 20 })
    const release = hub.subscribe([{ path: join(root, "nope", "deep") }, { path: root }])
    const base = hub.revision
    const waiting = hub.wait(base, 5_000)
    await tick(60)
    writeFileSync(join(root, "c.txt"), "x")
    const snap = await waiting
    expect(snap.rev).toBeGreaterThan(base)
    release()
    hub.dispose()
  })

  test("git 元数据目录的变化带 git 标记；普通目录不带", async () => {
    const root = tmp()
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true })
    const hub = new FsWatchHub({ debounceMs: 20 })
    const targets = [{ path: root }, ...gitWatchDirs(root)]
    const release = hub.subscribe(targets)
    let base = hub.revision
    writeFileSync(join(root, "plain.txt"), "x")
    const first = await hub.wait(base, 5_000)
    expect(first.git).toBe(false)
    base = first.rev
    writeFileSync(join(root, ".git", "refs", "heads", "main"), "0".repeat(40))
    const second = await hub.wait(base, 5_000)
    expect(second.git).toBe(true)
    release()
    hub.dispose()
  })

  test("订阅项超过 maxDirs 时截断", () => {
    const a = tmp()
    const b = tmp()
    const hub = new FsWatchHub({ maxDirs: 1 })
    const release = hub.subscribe([{ path: a }, { path: b }])
    expect(hub.watching).toBe(1)
    release()
    hub.dispose()
  })

  test("dispose 后等待中的 wait 会立刻返回（不挂住进程/请求）", async () => {
    const root = tmp()
    const hub = new FsWatchHub()
    hub.subscribe([{ path: root }])
    const waiting = hub.wait(hub.revision, 10_000)
    await tick(30)
    hub.dispose()
    const started = Date.now()
    await waiting
    expect(Date.now() - started).toBeLessThan(100)
  })
})

describe("gitWatchDirs", () => {
  test(".git 是目录时挂 .git 与 refs（refs 递归）", () => {
    const root = tmp()
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true })
    const out = gitWatchDirs(root)
    expect(out.map((t) => t.path).sort()).toEqual([join(root, ".git"), join(root, ".git", "refs")].sort())
    expect(out.every((t) => t.git)).toBe(true)
    expect(out.find((t) => t.path.endsWith("refs"))?.recursive).toBe(true)
  })

  test("worktree / 子模块的 .git 文件（gitdir: 指向真目录）", () => {
    const root = tmp()
    const real = tmp("real-git-")
    mkdirSync(join(real, "refs"), { recursive: true })
    writeFileSync(join(root, ".git"), `gitdir: ${real}\n`)
    const out = gitWatchDirs(root)
    expect(out[0]?.path).toBe(real)
    expect(out.some((t) => t.path === join(real, "refs"))).toBe(true)
  })

  test("没有 .git 时返回空（非仓库目录不发无谓的 watch）", () => {
    expect(gitWatchDirs(tmp())).toEqual([])
  })
})
