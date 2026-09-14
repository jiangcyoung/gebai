/**
 * 样式契约：`.active` 这类「点亮」类必须有对应样式规则。
 *
 * 存在的理由（不是假想的）：`classList.toggle("active", …)` 在 JS 侧永远「成功」——
 * 类名加上了、断言也能过，但 CSS 里没有对应规则时**用户什么也看不见**：
 * 开关看不出开没开、选中行看不出选没选中，比没有这个控件更糟（用户会当成坏了）。
 * 这类问题光测 DOM 也抓不全（要读 computed style、还得先有真实布局）。
 *
 * 这里守两道，各自都不依赖人工维护：
 * ① **模板条件追加**（`` class: `fw-x${cond ? " active" : ""}` ``）——前缀即宿主类，
 *    静态可判定且无误报，新增这种写法会被自动覆盖；
 * ② **已知开关清单**——防「误删样式」（有人在清理 CSS 时删掉 .fw-chip.active，这里会红）。
 * 变量宿主（`setToggle(btn, …)` 之类）静态判定不了，不在这里硬扫：那种写法靠浏览器实测覆盖，
 * 与其写一条只会空转的检查（测试全绿但什么也没守着），不如明确不写。
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..")
const CSS_DIR = join(SRC, "css")

/** 全部样式表里出现过 `.X.active` 的类名集合（跨文件：终端页签的样式在 terminal.css）。 */
function activeClassSet(css: string): Set<string> {
  const set = new Set<string>()
  for (const m of css.matchAll(/\.([a-z][a-z0-9-]*)\.active(?![\w-])/g)) set.add(m[1]!)
  return set
}

/** 递归列出源码文件（跳过测试与外部产物）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "vendor" || e.name === "node_modules") continue
      out.push(...sourceFiles(p))
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

/** 全部样式表的合并文本（**剥掉注释**：注释里提到 `.fw-x.active` 不算规则，否则断言永远为真）。 */
function allCss(): string {
  return readdirSync(CSS_DIR)
    .filter((f) => f.endsWith(".css"))
    .map((f) => readFileSync(join(CSS_DIR, f), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

describe("样式契约：点亮的 active 类必须有样式规则", () => {
  const known = activeClassSet(allCss())

  test("模板里条件追加的 active（前缀即宿主类）都有样式", () => {
    const violations: string[] = []
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        // `` class: `fw-chip${… ? " active" : ""}` `` → 捕获组 1 = 前缀（可含前导类名）
        for (const m of line.matchAll(/class:\s*`([^`]*)\$\{[^}]*\?\s*" active"\s*:\s*""/g)) {
          const host = m[1]!.trim().split(/\s+/).pop() ?? ""
          if (!host || host.includes("${")) continue
          if (!known.has(host)) violations.push(`${file.replace(SRC, "src")}:${i + 1}  ${host}`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  test("已知开关类的样式不能被删掉", () => {
    // 文件工作台里会用 `.active` 表达「按下 / 选中」的控件（新增控件时把类名加进来）
    const switches = ["fw-chip", "fw-btn", "fw-log-row", "fw-ref-row", "fw-tab-view", "fw-term-tab", "fw-rail-btn", "fw-tree-row"]
    const missing = switches.filter((c) => !known.has(c))
    expect(missing).toEqual([])
  })

  test("sticky 元素必须有垫实的背景（否则滚动内容会透出来）", () => {
    /* 为什么单列一条：半透明主题（acrylic 下 --bg-elev 约 0.82 不透明）里，
     * sticky 元素只用单层背景时，滚过去的行会**从它底下透出来**，看着像画错了。
     * 约定是叠两层（“双背景垫实”，与 wheel.css 的扇形按钮同一手法）。
     * 若某元素确实是不透明背景（写死的实色），把它加进 allowlist —— 不猜主题令牌的透明度。 */
    const allowlist: string[] = []
    const css = readFileSync(join(CSS_DIR, "files.css"), "utf8")
    const violations: string[] = []
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/position:\s*sticky/.test(body!)) continue
      const selector = sel!.trim().split("\n").pop()!.trim()
      if (allowlist.includes(selector)) continue
      const layers = (body!.match(/linear-gradient\(/g) ?? []).length
      if (layers < 2) violations.push(`${selector}（背景层数 ${layers}，需叠两层或用不透明实色并加 allowlist）`)
    }
    expect(violations).toEqual([])
  })
})
