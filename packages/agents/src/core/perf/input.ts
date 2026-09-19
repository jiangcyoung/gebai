/**
 * 输入文件引用（性能分析类子Agent 共用基建）：路径解析与文件指纹。
 *
 * 两个分析面的报告/报告类输入都需要同样的三件事：相对路径按工具上下文基准解析、
 * 存在性与类型校验、拿到「路径 + 大小 + mtime」指纹（事实缓存的寻址依据）。
 * 放在共用基建里，两个面各自独立引用（互不依赖）。
 */
import { existsSync, statSync } from "node:fs"
import { basename, extname, isAbsolute, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"

export interface FileRef {
  /** 绝对路径。 */
  path: string
  /** 文件名（含扩展名）。 */
  name: string
  /** 去尾部扩展的展示名（`.gz` 变体额外去掉 `.gz`，使同名文件的两份形态共享 stem）。 */
  stem: string
  size: number
  mtimeMs: number
}

/** 相对路径以工具上下文基准解析（project 包装后即项目根）。 */
export function resolveInputPath(ctx: ToolContext, input: string): string {
  return isAbsolute(input) ? input : resolve(ctx.resolvePath("."), input)
}

/**
 * 解析并校验输入文件，返回其引用（含指纹）。
 * @param label 错误信息里的称呼（如「报告」「trace」）
 */
export function statFileRef(ctx: ToolContext, input: string, label = "文件"): FileRef {
  const path = resolveInputPath(ctx, input)
  if (!existsSync(path)) {
    throw new Error(`${label}不存在：${path}（相对路径以当前工作目录为基准；也可传绝对路径）`)
  }
  const st = statSync(path)
  if (st.isDirectory()) throw new Error(`这是目录而非${label}：${path}`)
  const name = basename(path)
  const withoutGz = name.replace(/\.gz$/i, "")
  const stem = withoutGz.slice(0, withoutGz.length - extname(withoutGz).length)
  return { path, name, stem, size: st.size, mtimeMs: st.mtimeMs }
}

/** 内容指纹（同尺寸同 mtime 视为同一份输入）——事实缓存的寻址键。 */
export function fingerprintOf(ref: FileRef): string {
  return `${ref.path}|${ref.size}|${ref.mtimeMs}`
}
