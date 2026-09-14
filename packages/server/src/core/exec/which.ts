/**
 * PATH 查找（从 term-session 抽出的纯函数，终端域双模块共用：shell 探测与 PTY 编译器探测）。
 * Windows 按 PATHEXT 补扩展名探测；POSIX 直接查 PATH。
 */
import { existsSync, statSync } from "node:fs"
import { delimiter as pathDelimiter, join } from "node:path"

export function which(cmd: string): string | null {
  const isWin = process.platform === "win32"
  if (cmd.includes("/") || cmd.includes("\\")) {
    if (!existsSync(cmd)) return null
    try {
      return statSync(cmd).isFile() ? cmd : null
    } catch {
      return null
    }
  }
  const exts = isWin ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  const dirs = (process.env.PATH ?? "").split(isWin ? ";" : ":")
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      const name = ext && !cmd.toLowerCase().endsWith(ext.toLowerCase()) ? `${cmd}${ext}` : cmd
      const p = join(dir, name)
      try {
        if (statSync(p).isFile()) return p
      } catch {
        /* 不在该目录：继续 */
      }
    }
  }
  return null
}

export { pathDelimiter as _pathDelimiterForTest }
