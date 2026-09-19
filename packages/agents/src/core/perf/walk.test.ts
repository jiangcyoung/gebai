/**
 * 目录遍历的 mtime 回归测试。
 *
 * 背景（真实缺陷）：`walkDirFiles` 曾把 `modifiedAt` 恒置为 0——并发的 stat 只取了 size。
 * 后果是所有走 `project` 参数列文件的工具（torch_reports 的 trace 索引、基于 listFiles 的扫描类工具）
 * 拿到「1970 年」的时间，且「按修改时间倒序」静默退化为遍历顺序。工具层无从区分
 * 「宿主未提供」与「文件真的很旧」，所以这必须在遍历层修好并锁住。
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { walkDirFiles } from "@gebai/sdk/node"

/** 造文件并显式设置 mtime（秒）；返回期望的 mtimeMs（供断言比对，容忍文件系统精度损失）。 */
function makeFile(dir: string, rel: string, content: string, mtimeSec: number): { abs: string; expectMs: number } {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, "utf8")
  utimesSync(abs, mtimeSec, mtimeSec)
  return { abs, expectMs: mtimeSec * 1000 }
}

/** mtimeMs 是否落在期望值附近（某些文件系统有秒级精度损失，留 2s 容差；0 与错值都不通过）。 */
function nearMtime(actual: number, expectedMs: number): boolean {
  return actual >= expectedMs - 1000 && actual <= expectedMs + 2000
}

describe("walkDirFiles：size 与 mtime 必须一并取出", () => {
  test("每个条目的 modifiedAt 反映真实 mtime（不得恒为 0）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-walk-mtime-"))
    try {
      const old = makeFile(dir, "old.txt", "a", 1_000_000)
      const fresh = makeFile(dir, "new.txt", "bb", 1_600_000_000)
      const deep = makeFile(dir, "sub/deep.txt", "ccc", 1_700_000_000)
      const files = await walkDirFiles(dir)
      const byName = new Map(files.map((f) => [f.path, f]))
      expect(byName.size).toBe(3)
      // mtime 必须接近真实取值（恒 0 或错值都会失败）
      expect(nearMtime(byName.get("old.txt")!.modifiedAt, old.expectMs)).toBe(true)
      expect(nearMtime(byName.get("new.txt")!.modifiedAt, fresh.expectMs)).toBe(true)
      expect(nearMtime(byName.get("sub/deep.txt")!.modifiedAt, deep.expectMs)).toBe(true)
      // size 与 mtime 同源（一并取出的回归防护）
      expect(byName.get("old.txt")!.size).toBe(1)
      expect(byName.get("new.txt")!.size).toBe(2)
      expect(byName.get("sub/deep.txt")!.size).toBe(3)
      // 时间先后可用于排序（改前全为 0，排序退化为遍历顺序）
      const sorted = [...files].sort((a, b) => b.modifiedAt - a.modifiedAt).map((f) => f.path)
      expect(sorted).toEqual(["sub/deep.txt", "new.txt", "old.txt"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("pathBase 前缀与遍历顺序不受并发 stat 影响", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-walk-order-"))
    try {
      makeFile(dir, "a.txt", "1", 1_600_000_000)
      makeFile(dir, "b.txt", "2", 1_600_000_000)
      makeFile(dir, "d/c.txt", "3", 1_600_000_000)
      const files = await walkDirFiles(dir, "tmp")
      // 顺序与递归 readdir 一致（a、b、d 目录及其子项），且路径带前缀
      expect(files.map((f) => f.path)).toEqual(["tmp/a.txt", "tmp/b.txt", "tmp/d/c.txt"])
      expect(files.every((f) => f.modifiedAt > 0)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skip 目录仍被跳过；单文件 root 直接返回单条且带真实 mtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-walk-skip-"))
    try {
      makeFile(dir, "keep.txt", "1", 1_600_000_000)
      makeFile(dir, "node_modules/pkg/index.js", "x", 1_600_000_000)
      makeFile(dir, ".git/config", "x", 1_600_000_000)
      const files = await walkDirFiles(dir)
      expect(files.map((f) => f.path)).toEqual(["keep.txt"])
      const single = await walkDirFiles(join(dir, "keep.txt"), "tmp")
      expect(single).toHaveLength(1)
      expect(single[0]!.path).toBe("tmp")
      expect(single[0]!.modifiedAt).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
