/** PTY 驱动层单测：POSIX C 源关键原生点、协议契约、双平台编译分支与哈希缓存；另含一段真机行为回归（编译驱动跑真实会话）。 */
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { PTY_DRIVER_C, PTY_DRIVER_CS, preparePtyDriver } from "./pty-driver"

describe("PTY_DRIVER_C · 原生层关键点", () => {
  test("openpty/setsid/termios/TIOCSWINSZ 等必需原生调用齐备", () => {
    for (const sym of ["openpty(", "setsid()", "TIOCSWINSZ", "OPOST", "ONLCR", "ICRNL", "ISIG", "ICANON", "ECHO", "IEXTEN", "WNOHANG", "SIGHUP", "SIGWINCH"]) {
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

  test("termios 语义齐备：输出侧 OPOST|ONLCR（换行翻译）、输入侧 ICRNL|IXON 与行规程 ISIG|ICANON|ECHO|IEXTEN", () => {
    const seg = /if \(tcgetattr\(slave, &tio\) == 0\) \{[^}]*\}/.exec(PTY_DRIVER_C)?.[0] ?? ""
    for (const flag of ["OPOST", "ONLCR", "ICRNL", "IXON", "ISIG", "ICANON", "ECHO", "IEXTEN"]) {
      expect(seg).toContain(flag)
    }
    // 不再用 cfmakeraw 先清后补：它会把输出后处理与回车翻译一并清掉，多行输出随即阶梯式右移
    expect(seg).not.toContain("cfmakeraw")
    expect(PTY_DRIVER_C).not.toContain("cfmakeraw")
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

/* --------------------------- 真机行为回归 --------------------------- */

const ptyLaunch = process.platform === "win32" ? { ok: false, reason: "POSIX 驱动" } : preparePtyDriver()

/** 起一次真实会话：下发 open → 定时喂输入 → 等目标文本出现（或到期）后收尾，返回解码后的输出。 */
function runPtySession(input: string, waitFor: string, deadlineMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ptyLaunch.cmd![0]!, [], { stdio: ["pipe", "pipe", "ignore"] })
    let out = ""
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      resolve(out)
    }
    const poll = setInterval(() => out.includes(waitFor) && finish(), 50)
    const deadline = setTimeout(finish, deadlineMs)
    const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + "\n")
    child.stdout!.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) {
        if (!line.trim()) continue
        let evt: { t?: string; d?: string }
        try {
          evt = JSON.parse(line) as { t?: string; d?: string }
        } catch {
          continue
        }
        if (evt.t === "out") out += Buffer.from(evt.d ?? "", "base64").toString("utf8")
      }
    })
    child.on("error", reject)
    send({ t: "open", shell: "/bin/sh", cwd: tmpdir(), cols: 80, rows: 24 })
    setTimeout(() => send({ t: "in", d: Buffer.from(input).toString("base64") }), 400)
  })
}

describe("PTY_DRIVER_C · 真实会话行为（无编译器/非 POSIX 自动跳过）", () => {
  test.if(ptyLaunch.ok)(
    "输出行尾经 OPOST|ONLCR 翻成回车+换行：多行输出不逐行右移、列不错位",
    async () => {
      const out = await runPtySession("printf 'a\\nb\\n'\n", "a\r\nb\r\n")
      expect(out).toContain("a\r\nb\r\n")
      // 终端输出里不该残留孤立 LF（缺 ONLCR 时它正是每行右移一格的原因）
      expect(out.replace(/\r\n/g, "")).not.toContain("\n")
    },
    20_000,
  )
})
