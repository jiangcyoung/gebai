/**
 * 变更监听的纯逻辑（`files/watch-core.ts`）：目录归一、指纹、退避、变更路径 → 目录。
 *
 * 为什么值得单测：这里的错都不报错——目录没归一就多挂一个用不上的 watch（浪费 fd，用户看不见）；
 * 退避写错就是断线后疯狂重连（服务端被自己人打）；`dirsToRefresh` 漏了父目录就表现为
 * 「新建的文件要手动 F5 才冒出来」。都能被这几条钉住。
 */
import { describe, expect, test } from "bun:test"
import { backoffMs, dirsToRefresh, normalizeWatchDirs, watchKey, watchKeyChanged, WATCH_DIR_CAP } from "./watch-core"

describe("normalizeWatchDirs", () => {
  test("去斜杠、去重复、保留代表根的空串", () => {
    expect(normalizeWatchDirs(["", "/src", "src", "src/", "/", "a/b/"])).toEqual(["", "src", "a/b"])
  })

  test("丢掉逃逸与绝对路径项（服务端还要校验一次，前端先不送无效路径）", () => {
    expect(normalizeWatchDirs(["../x", "a/../b", "C:/win", "file://x", "ok/"])).toEqual(["ok"])
  })

  test("反斜杠归一（Windows 系路径写法）", () => {
    expect(normalizeWatchDirs(["a\\b"])).toEqual(["a/b"])
  })

  test("夹到上限，且顺序即优先级（浅层在前由调用方给）", () => {
    const many = Array.from({ length: WATCH_DIR_CAP + 10 }, (_, i) => `d${i}`)
    const out = normalizeWatchDirs(many)
    expect(out.length).toBe(WATCH_DIR_CAP)
    expect(out[0]).toBe("d0")
    expect(out[WATCH_DIR_CAP - 1]).toBe(`d${WATCH_DIR_CAP - 1}`)
  })
})

describe("watchKey / watchKeyChanged", () => {
  test("指纹按顺序整体比较：顺序变了同样是一次重连", () => {
    const a = watchKey(["", "src", "src/lib"])
    expect(watchKeyChanged(a, watchKey(["", "src", "src/lib"]))).toBe(false)
    expect(watchKeyChanged(a, watchKey(["", "src/lib", "src"]))).toBe(true)
    expect(watchKeyChanged(a, watchKey(["", "src"]))).toBe(true)
  })
})

describe("backoffMs", () => {
  test("无失败不退避；2s 起步翻倍，封顶 30s", () => {
    expect(backoffMs(0)).toBe(0)
    expect(backoffMs(1)).toBe(2_000)
    expect(backoffMs(2)).toBe(4_000)
    expect(backoffMs(3)).toBe(8_000)
    expect(backoffMs(5)).toBe(30_000)
    expect(backoffMs(50)).toBe(30_000)
  })

  test("上限可调（自定义参数不得越界）", () => {
    expect(backoffMs(9, { base: 500, max: 1_500 })).toBe(1_500)
  })
})

describe("dirsToRefresh", () => {
  test("每个变化路径贡献「父目录 + 自己」（祖父目录的列举不会因孙子的变化而变）", () => {
    expect(dirsToRefresh(["src/lib/a.ts"]).sort()).toEqual(["src/lib", "src/lib/a.ts"].sort())
  })

  test("根下的一级条目：父目录即根（空串）", () => {
    expect(dirsToRefresh(["README.md"]).sort()).toEqual(["", "README.md"].sort())
  })

  test("重复与空项不产生重复目录", () => {
    expect(dirsToRefresh(["a/b.txt", "a/c.txt", ""]).sort()).toEqual(["a", "a/b.txt", "a/c.txt"].sort())
  })
})
