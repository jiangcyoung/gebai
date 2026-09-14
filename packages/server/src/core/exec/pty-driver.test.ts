/** PTY 驱动层单测：POSIX C 源关键原生点、协议契约、双平台编译分支与哈希缓存。 */
import { describe, expect, test } from "bun:test"
import { PTY_DRIVER_C, PTY_DRIVER_CS } from "./pty-driver"

describe("PTY_DRIVER_C · 原生层关键点", () => {
  test("openpty/setsid/termios/TIOCSWINSZ 等必需原生调用齐备", () => {
    for (const sym of ["openpty(", "setsid()", "cfmakeraw(", "TIOCSWINSZ", "ISIG", "ICANON", "ECHO", "WNOHANG", "SIGHUP", "SIGWINCH"]) {
      expect(PTY_DRIVER_C.includes(sym)).toBe(true)
    }
    // 控制终端不靠 TIOCSCTTY：setsid 后重开 slave 即自动获得（Linux/BSD/macOS 通用，见源内注释）
    expect(PTY_DRIVER_C.includes("TIOCSCTTY")).toBe(false)
  })

  test("协议四指令与四事件逐字节对齐 C# 驱动", () => {
    // C 源内是 snprintf 格式串：源文本里每个引号是 反斜杠+引号 两个字符（String.raw 下原样保留）
    const q = String.raw`\"` // 反斜杠 + 引号
    for (const evt of ["ready", "out", "exit", "error"]) {
      expect(PTY_DRIVER_C.includes(`${q}t${q}:${q}${evt}${q}`)).toBe(true)
    }
    // 入向指令解析
    for (const key of ['"shell"', '"cwd"', '"cols"', '"rows"', '"t"', '"d"']) {
      expect(PTY_DRIVER_C.includes(key)).toBe(true)
    }
  })

  test("行规程语义保留：cfmakeraw 后回补 ISIG/ICANON/ECHO（Ctrl+C 可用、行编辑与回显交回 termios）", () => {
    const seg = /cfmakeraw[^}]+/.exec(PTY_DRIVER_C)?.[0] ?? ""
    expect(seg).toContain("ISIG")
    expect(seg).toContain("ICANON")
    expect(seg).toContain("ECHO")
  })

  test("C 源不含反引号（String.raw 模板内出现会提前终止模板字面量）", () => {
    expect(PTY_DRIVER_C.includes("`")).toBe(false)
  })

  test("aslave 传真实指针（glibc 无条件写入，NULL 会段错误）；父进程不在 openpty 后立即 close slave（启动期竞态）", () => {
    expect(/openpty\(&master,\s*&slave_fd,/.test(PTY_DRIVER_C)).toBe(true)
    expect(/openpty[^;]+;\s*\n\s*close\(slave_fd\)/.test(PTY_DRIVER_C)).toBe(false)
  })

  test("窗口尺寸随 open/resize 下发（TIOCSWINSZ + SIGWINCH 通知前台进程组）", () => {
    expect(PTY_DRIVER_C.includes("kill(-g_child, SIGWINCH)")).toBe(true)
  })
})

describe("PTY_DRIVER_CS · Windows 侧不受影响", () => {
  test("ConPTY 关键 API 与协议保持原样", () => {
    for (const sym of ["CreatePseudoConsole", "ResizePseudoConsole", "PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE"]) {
      expect(PTY_DRIVER_CS.includes(sym)).toBe(true)
    }
  })
})
