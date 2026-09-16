/**
 * paths.ts 测试：渲染输出路径解析——绝对路径直通、相对路径以**工程目录**为基准（不是服务进程 cwd），
 * 未指定时落到 `<工程>/out/` 下。这条规则决定"产物到底在哪"，由用例钉住。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { resolveOutputPath, uniqueOutputPath } from "./paths"

describe("渲染输出路径解析", () => {
  // 工程目录在真实场景中总是**绝对路径**。此前用 join("/tmp","proj")，在 Windows 上得到 `\tmp\proj`
  // （无盘符的根相对路径），而实现走 resolve() 会补上当前盘符（→ `C:\tmp\proj`），
  // 期望值与实际值必然不等——是**用例的平台假设错了**，不是实现错了。
  const projectDir = resolve(join(tmpdir(), "reel-proj-under-test"))

  test("未指定 out → 落到 <工程>/out/ 的默认名", () => {
    expect(resolveOutputPath(projectDir, undefined, join("out", "Reel-frame90.png"))).toBe(join(projectDir, "out", "Reel-frame90.png"))
    expect(resolveOutputPath(projectDir, "", join("out", "Reel-reel.mp4"))).toBe(join(projectDir, "out", "Reel-reel.mp4"))
    expect(resolveOutputPath(projectDir, "   ", join("out", "Reel-reel.mp4"))).toBe(join(projectDir, "out", "Reel-reel.mp4"))
  })

  test("相对路径以工程目录为基准（与默认落点同一坐标系）", () => {
    expect(resolveOutputPath(projectDir, "out/qa/open-130.png", "x")).toBe(join(projectDir, "out", "qa", "open-130.png"))
    expect(resolveOutputPath(projectDir, "./stills/a.png", "x")).toBe(join(projectDir, "stills", "a.png"))
  })

  test("绝对路径直通（不改写）", () => {
    const abs = join("/var", "tmp", "deliver", "final.mp4")
    expect(resolveOutputPath(projectDir, abs, "x")).toBe(abs)
    expect(isAbsolute(resolveOutputPath(projectDir, abs, "x"))).toBe(true)
  })
})

describe("产物唯一化（不覆盖历史产物）", () => {
  test("目标不存在 → 原样返回", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-unique-"))
    try {
      const p = join(dir, "final.mp4")
      expect(uniqueOutputPath(p)).toEqual({ path: p })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("目标已存在 → 追加 -v2 / -v3（历史版本全部保留）", () => {
    // 回归背景：产物在对话里按路径引用，同名覆盖会让历史消息里的产物变成新内容。
    const dir = mkdtempSync(join(tmpdir(), "reel-unique-"))
    try {
      const first = join(dir, "final.mp4")
      writeFileSync(first, "v1")
      const second = uniqueOutputPath(first)
      expect(second.path).toBe(join(dir, "final-v2.mp4"))
      expect(second.renamedFrom).toBe(first)
      writeFileSync(second.path, "v2")
      const third = uniqueOutputPath(first)
      expect(third.path).toBe(join(dir, "final-v3.mp4"))
      // 旧版本仍在（可回看）
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second.path)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("无扩展名 / 多点文件名均处理正确", () => {
    const dir = mkdtempSync(join(tmpdir(), "reel-unique-"))
    try {
      const noExt = join(dir, "stills-01")
      writeFileSync(noExt, "x")
      expect(uniqueOutputPath(noExt).path).toBe(join(dir, "stills-01-v2"))
      const multiDot = join(dir, "promo.v2.final.png")
      writeFileSync(multiDot, "x")
      expect(uniqueOutputPath(multiDot).path).toBe(join(dir, "promo.v2.final-v2.png"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
