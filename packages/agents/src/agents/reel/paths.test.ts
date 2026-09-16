/**
 * paths.ts 测试：渲染输出路径解析——绝对路径直通、相对路径以**工程目录**为基准（不是服务进程 cwd），
 * 未指定时落到 `<工程>/out/` 下。这条规则决定"产物到底在哪"，由用例钉住。
 */
import { describe, expect, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { resolveOutputPath } from "./paths"

describe("渲染输出路径解析", () => {
  const projectDir = join("/tmp", "proj")

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
