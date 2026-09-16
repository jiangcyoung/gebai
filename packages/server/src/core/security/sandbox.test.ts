import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _resetWinShellCache, decodeOutput, resolveWinShell, Sandbox, winShellPlan, wrapPowerShellCommand } from "./sandbox"
import { sessionPath } from "../base/paths"
import { which } from "../exec/which"

describe("decodeOutput", () => {
  test("utf-8 bytes decode as-is", () => {
    expect(decodeOutput(Buffer.from("hello 世界", "utf8"))).toBe("hello 世界")
  })

  test("gbk bytes fall back to gbk decoding when utf-8 yields replacement chars", () => {
    // GBK 编码的「中文输出」
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xe4, 0xb3, 0xf6])
    expect(decodeOutput(gbk)).toBe("中文输出")
  })

  test("empty buffer yields empty string", () => {
    expect(decodeOutput(Buffer.alloc(0))).toBe("")
  })

  test("ansi control sequences are stripped (color/cursor codes are noise)", () => {
    expect(decodeOutput(Buffer.from("\u001b[31;1mGet-Content: \u001b[0m找不到路径", "utf8"))).toBe("Get-Content: 找不到路径")
  })
})

describe("Sandbox 豁免用户（auth=none 默认用户不受用户沙箱控制）", () => {
  test("enforcedFor: 豁免用户不受约束，其余用户受约束；全局关闭时均不受约束", () => {
    const on = new Sandbox({ home: "/tmp/h", enabled: true, isExempt: (u) => u === "default" })
    expect(on.isExempt("default")).toBe(true)
    expect(on.isExempt("alice")).toBe(false)
    expect(on.enforcedFor("default")).toBe(false)
    expect(on.enforcedFor("alice")).toBe(true)
    const off = new Sandbox({ home: "/tmp/h", enabled: false, isExempt: (u) => u === "default" })
    expect(off.enforcedFor("default")).toBe(false)
    expect(off.enforcedFor("alice")).toBe(false)
  })

  test("resolvePath: 豁免用户绝对路径/../ 放行（本地模式语义），其余用户仍被沙箱拒绝", () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-exempt-"))
    const sid = "0123456789abcdef0123456789abcdef"
    const sb = new Sandbox({ home, enabled: true, isExempt: (u) => u === "default" })
    try {
      // 豁免用户（默认用户）：绝对路径直接使用、../ 可越界（相对路径基准 = 会话 tmp/，../ 越界到会话根）
      // （Windows 下 resolve("/etc/passwd") 为盘符根路径，断言与解析器同口径）
      expect(sb.resolvePath("default", sid, "/etc/passwd")).toBe(resolve("/etc/passwd"))
      expect(sb.resolvePath("default", sid, "../secret")).toBe(resolve(join(sessionPath(home, "default", sid), "tmp"), "../secret"))
      // 其余用户（含多用户模式同名 default 之外的用户）：沙箱拒绝
      expect(() => sb.resolvePath("alice", sid, "/etc/passwd")).toThrow()
      expect(() => sb.resolvePath("alice", sid, "../secret")).toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("exec: 豁免用户脚本子进程不剔除敏感变量（操作者本人环境），其余用户仍脱敏", async () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-exempt-exec-"))
    const sb = new Sandbox({ home, enabled: true, isExempt: (u) => u === "default" })
    try {
      const cmd = 'node -e "console.log(process.env.SECRET_KEY || \'EMPTY\')"'
      // 豁免用户（默认用户）：SECRET_KEY 可见
      const exempt = await sb.exec(cmd, { env: { SECRET_KEY: "s3cret" }, user: "default" })
      expect(exempt.stdout.trim()).toBe("s3cret")
      // 非豁免用户：敏感变量被剔除（防任意用户经 sh/py 外泄服务端密钥）
      const restricted = await sb.exec(cmd, { env: { SECRET_KEY: "s3cret" }, user: "alice" })
      expect(restricted.stdout.trim()).toBe("EMPTY")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("Sandbox.exec (Windows 编码)", () => {
  test("cmd output with chinese decodes correctly", async () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-"))
    const sb = new Sandbox({ home, enabled: false })
    try {
      const r = await sb.exec('echo 中文输出测试')
      expect(r.code).toBe(0)
      // chcp 65001 后 cmd 输出 UTF-8：解码后包含原文本（可能有换行/回车差异）
      expect(r.stdout.replace(/\r?\n/g, "")).toContain("中文输出测试")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("exec: cwd 不存在时自动创建（会话 tmp/ 缺失不再全体 ENOENT）；spawnBackground 同语义", async () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-cwd-"))
    const sb = new Sandbox({ home, enabled: false })
    const sid = "0123456789abcdef0123456789abcdef"
    const cwd = sb.workdir("default", sid) // 从未创建的会话 tmp 目录
    try {
      const r = await sb.exec("echo ok", { cwd })
      expect(r.code).toBe(0)
      expect(r.stdout.trim()).toBe("ok")
      // 后台任务：cwd 与 logPath 父目录缺失同样自动创建
      const { existsSync } = await import("node:fs")
      const logPath = join(cwd, "sh-tasks", "t1.log")
      const h = sb.spawnBackground("echo bg", { cwd, logPath })
      await h.exited
      expect(existsSync(logPath)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("node --version output is captured (not swallowed)", async () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-"))
    const sb = new Sandbox({ home, enabled: false })
    try {
      const r = await sb.exec("node --version")
      expect(r.code).toBe(0)
      expect(r.stdout.trim()).toMatch(/^v\d+\./)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("abort signal kills the running command and returns interrupted result", async () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-"))
    const sb = new Sandbox({ home, enabled: false })
    try {
      const controller = new AbortController()
      const started = Date.now()
      const p = sb.exec('node -e "setTimeout(()=>{}, 30000)"', { signal: controller.signal })
      // 等子进程真正启动后再中断（立即 abort 会在 spawn 完成前杀掉，仍可接受但时序不确定）
      await new Promise((r) => setTimeout(r, 300))
      controller.abort()
      const r = await p
      // 中断立即返回（远早于 30 秒），code 124 + [interrupted by user] 标记，与超时区分
      expect(Date.now() - started).toBeLessThan(10000)
      expect(r.code).toBe(124)
      expect(r.stderr).toContain("[interrupted by user]")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("timeout kills the running command with timed-out marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "gebai-sandbox-"))
    const sb = new Sandbox({ home, enabled: false })
    try {
      const started = Date.now()
      const r = await sb.exec('node -e "setTimeout(()=>{}, 30000)"', { timeoutMs: 400 })
      expect(Date.now() - started).toBeLessThan(10000)
      expect(r.code).toBe(124)
      expect(r.stderr).toContain("[timed out after 400ms]")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("Windows 命令解释器（PowerShell）", () => {
  const prevShell = process.env.GEBAI_SH_SHELL
  const prevPath = process.env.PATH
  /** 还原环境并清缓存：缓存会记住本组用例造的临时解释器路径。 */
  const restore = () => {
    if (prevShell === undefined) delete process.env.GEBAI_SH_SHELL
    else process.env.GEBAI_SH_SHELL = prevShell
    process.env.PATH = prevPath
    _resetWinShellCache()
  }

  test("wrapPowerShellCommand：引导段 + 用户命令 + 收尾段逐行拼接", () => {
    const wrapped = wrapPowerShellCommand("echo hi")
    const lines = wrapped.split("\n")
    expect(lines).toContain("echo hi")
    // 引导段：输出编码切 UTF-8（解释器自身输出与原生命令输出同一解码入口）+ 关进度输出
    expect(wrapped).toContain("[Console]::OutputEncoding = [Text.Encoding]::UTF8")
    expect(wrapped).toContain("$ProgressPreference = 'SilentlyContinue'")
    // 收尾段：原生命令退出码带出（-Command 默认把退出码归一成 0/1）+ 失败兜底 1
    expect(wrapped).toContain("if ($LASTEXITCODE) { exit $LASTEXITCODE }")
    expect(lines[lines.length - 1]).toBe("exit 1")
    // 用户命令自占一行：以 # 注释结尾时不吞收尾段
    expect(lines[lines.indexOf("echo hi") + 1]).toBe("if ($?) { exit 0 }")
  })

  test("winShellPlan：PowerShell 形态以 -Command 承载包装后的完整命令；cmd 回落返回 null", () => {
    try {
      // 不存在的解释器名：which 探测不命中即原样使用（形态判定不依赖 PATH 内容）
      process.env.GEBAI_SH_SHELL = "gebai-test-shell"
      _resetWinShellCache()
      const plan = winShellPlan("bun test")
      expect(plan?.file).toBe("gebai-test-shell")
      expect(plan?.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"])
      expect(plan?.args[5]).toBe(wrapPowerShellCommand("bun test"))
      // GEBAI_SH_SHELL=cmd：回落 cmd.exe 形态（winShellPlan 返回 null，调用方沿用 chcp 65001 + shell:true）
      process.env.GEBAI_SH_SHELL = "cmd"
      _resetWinShellCache()
      expect(resolveWinShell()).toEqual({ file: "cmd.exe", powershell: false })
      expect(winShellPlan("echo hi")).toBeNull()
    } finally {
      restore()
    }
  })

  test("resolveWinShell：PATH 中的 pwsh 优先，缺失回落 powershell.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "gebai-winshell-"))
    try {
      writeFileSync(join(dir, "pwsh.exe"), "")
      writeFileSync(join(dir, "powershell.exe"), "")
      delete process.env.GEBAI_SH_SHELL
      process.env.PATH = dir
      _resetWinShellCache()
      expect(resolveWinShell()).toEqual({ file: join(dir, "pwsh.exe"), powershell: true })
      rmSync(join(dir, "pwsh.exe"))
      _resetWinShellCache()
      expect(resolveWinShell()).toEqual({ file: join(dir, "powershell.exe"), powershell: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
      restore()
    }
  })

  // 本机有真实 PowerShell（Windows 开发机 / 装了 pwsh 的环境）时执行包装后的命令：验证收尾段的退出码带出与中文输出解码
  const shellAvailable = which(resolveWinShell().file) != null
  test.if(shellAvailable)("PowerShell 形态真实执行：exitCode 带出原生命令退出码、中文输出按 UTF-8 解码", async () => {
    const run = async (cmd: string) => {
      const plan = winShellPlan(cmd)
      if (!plan) throw new Error("期望 PowerShell 形态")
      const child = spawn(plan.file, plan.args, { stdio: ["pipe", "pipe", "pipe"] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", (d) => stdout.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
      child.stderr.on("data", (d) => stderr.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
      const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)))
      return { stdout: decodeOutput(Buffer.concat(stdout)), stderr: decodeOutput(Buffer.concat(stderr)), code }
    }
    // PowerShell 单引号字面量（内含单引号翻倍转义）：`& <路径>` 调用运算符启动宿主机运行时
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`
    const bad = await run(`& ${quote(process.execPath)} -e ${quote("process.exit(7)")}`)
    expect(bad.code).toBe(7)
    const ok = await run(`& ${quote(process.execPath)} -e ${quote("console.log('中文 ok')")}`)
    expect(ok.code).toBe(0)
    expect(ok.stdout).toContain("中文 ok")
  })
})
