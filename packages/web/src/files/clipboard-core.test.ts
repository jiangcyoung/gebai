/**
 * 剪贴板纯逻辑（复制 / 粘贴的落点与命名）。
 *
 * 为什么值得测：这段逻辑决定「贴到哪儿、叫什么名字」，算错就是覆盖别人的文件；
 * 而且粘贴走的是服务端的非覆盖复制——只有这里算得准，同名冲突才不需要弹窗。
 */
import { describe, expect, test } from "bun:test"
import { baseName, canPasteInto, copyName, isSelfOrInside, joinPath, parentDir, pickTargetPath, splitName, type ClipEntry } from "./clipboard-core"

describe("路径小工具", () => {
  test("basename / 父目录 / 拼接：根目录与深层路径都不出错", () => {
    expect(baseName("a.txt")).toBe("a.txt")
    expect(baseName("src/app/a.txt")).toBe("a.txt")
    expect(parentDir("src/app/a.txt")).toBe("src/app")
    expect(parentDir("a.txt")).toBe("")
    expect(joinPath("", "a.txt")).toBe("a.txt")
    expect(joinPath("src/app", "a.txt")).toBe("src/app/a.txt")
    // 首尾斜杠由调用方（输入框）带来：拼接前去掉，避免出现 `//` 与以 `/` 开头的路径
    expect(joinPath("/src/app/", "a.txt")).toBe("src/app/a.txt")
  })

  test("自身或子树判定：目录粘进自己的子目录要拦住", () => {
    expect(isSelfOrInside("src", "src")).toBe(true)
    expect(isSelfOrInside("src", "src/app")).toBe(true)
    // 前缀相同的兄弟目录不是子树（`src-old` 不在 `src` 里）
    expect(isSelfOrInside("src", "src-old")).toBe(false)
    expect(isSelfOrInside("src/app", "src/app2")).toBe(false)
  })
})

describe("能否粘贴", () => {
  const clip: ClipEntry = { root: "proj:demo", path: "a.txt", isDir: false }

  test("同根 + 可写才允许", () => {
    expect(canPasteInto(clip, "proj:demo", true)).toBe(true)
    expect(canPasteInto(clip, "sess:s1", true)).toBe(false)
    expect(canPasteInto(clip, "proj:demo", false)).toBe(false)
    expect(canPasteInto(null, "proj:demo", true)).toBe(false)
  })
})

describe("副本命名", () => {
  test("扩展名保留在最后一段（含多段扩展名与隐藏文件）", () => {
    expect(splitName("a.txt", false)).toEqual({ stem: "a", ext: ".txt" })
    expect(splitName("a.tar.gz", false)).toEqual({ stem: "a.tar", ext: ".gz" })
    expect(splitName("README", false)).toEqual({ stem: "README", ext: "" })
    expect(splitName(".env", false)).toEqual({ stem: ".env", ext: "" })
    expect(splitName("src", true)).toEqual({ stem: "src", ext: "" })
    // 目录即便名字里带点也不当扩展名
    expect(copyName("v1.2", true, 1)).toBe("v1.2 - 副本")
  })

  test("第一份副本无编号，之后带编号", () => {
    expect(copyName("a.txt", false, 1)).toBe("a - 副本.txt")
    expect(copyName("a.txt", false, 2)).toBe("a - 副本 (2).txt")
    expect(copyName("a.txt", false, 3)).toBe("a - 副本 (3).txt")
  })
})

describe("挑落点", () => {
  test("原名空着就用原名（不算改名）", () => {
    expect(pickTargetPath("dst", "a.txt", false, ["b.txt"])).toEqual({ path: "dst/a.txt", renamed: false })
  })

  test("撞名时顺延到第一个空位，并标记已改名", () => {
    expect(pickTargetPath("", "a.txt", false, ["a.txt"])).toEqual({ path: "a - 副本.txt", renamed: true })
    expect(pickTargetPath("dst", "a.txt", false, ["a.txt", "a - 副本.txt"])).toEqual({ path: "dst/a - 副本 (2).txt", renamed: true })
  })

  test("粘回原目录 = 造一份副本（源目录里必然有同名）", () => {
    expect(pickTargetPath("src", "a.txt", false, ["a.txt", "b.txt"])).toEqual({ path: "src/a - 副本.txt", renamed: true })
  })

  test("目录名不拆扩展名", () => {
    expect(pickTargetPath("dst", "v1.2", true, ["v1.2"])).toEqual({ path: "dst/v1.2 - 副本", renamed: true })
  })

  test("仍在顺延，直到到达尝试上限才返回 null（调用方报错，不自作主张）", () => {
    const taken = ["a.txt", "a - 副本.txt", "a - 副本 (2).txt"]
    expect(pickTargetPath("", "a.txt", false, taken, 3)).toEqual({ path: "a - 副本 (3).txt", renamed: true })
    expect(pickTargetPath("", "a.txt", false, taken, 2)).toBeNull()
  })

  test("落点始终在目标目录内", () => {
    const r = pickTargetPath("deep/nested", "a.txt", false, [])
    expect(r?.path).toBe("deep/nested/a.txt")
  })
})
