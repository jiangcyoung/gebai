/**
 * 内置模板的读取与签名 —— 生成脚本（`packages/agents/scripts/embed-reel-template.ts`）与
 * 校验测试（`template.test.ts`）共用同一份实现，避免"两边各写一遍算法"导致的漂移。
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

/** 不参与内联/签名的路径（构建产物与依赖）。 */
const SKIP = /(^|[/\\])(node_modules|out|\.git|\.remotion|\.cache)([/\\]|$)/

/** 递归读取模板目录为「相对路径 → 内容」表（路径统一用 `/` 分隔，跨平台一致）。 */
export function readTemplateDir(root: string): Record<string, string> {
  const acc: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = relative(root, abs).split(/[/\\]/).join("/")
      if (SKIP.test(rel)) continue
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      acc[rel] = readFileSync(abs, "utf8")
    }
  }
  walk(root)
  return acc
}

/**
 * 模板内容签名：按路径排序后逐个喂入 sha256（路径与内容都以 `\0` 结尾做边界），取前 16 位十六进制。
 * 用途：判定"共享运行时依赖是否与当前模板匹配"（不匹配需重装/重建联接）。
 */
export function signTemplateFiles(files: Record<string, string>): string {
  const hash = createHash("sha256")
  for (const key of Object.keys(files).sort()) {
    hash.update(`${key}\u0000${files[key]}\u0000`)
  }
  return hash.digest("hex").slice(0, 16)
}
