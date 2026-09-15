/**
 * 把内置视频模板（`packages/agents/assets/reel-template/`）内联成 TypeScript 模块。
 *
 * 为什么需要：模板是**真实工程文件**（package.json / tsconfig / src/**.tsx…），落位时要写出真实文件；
 * 但歌白服务在 bundle 形态下只带打包后的代码，磁盘上没有 `assets/` 目录。把文件内容内联进
 * `src/agents/reel/template.generated.ts` 后，dev 与 bundle 两种形态都能展开模板。
 *
 * 用法：改了 `assets/reel-template/` 下任何文件后必须重跑本脚本——
 *   cd packages/agents && bun run scripts/embed-reel-template.ts
 * 未重跑会被 `src/agents/reel/template.test.ts` 的签名校验测出来（测试失败并提示）。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { readTemplateDir, signTemplateFiles } from "../src/agents/reel/template-signature"

const PKG_ROOT = dirname(import.meta.dirname)
const TEMPLATE_SRC = join(PKG_ROOT, "assets", "reel-template")
const OUT_FILE = join(PKG_ROOT, "src", "agents", "reel", "template.generated.ts")

const files = readTemplateDir(TEMPLATE_SRC)
const keys = Object.keys(files).sort()
if (!keys.length) throw new Error(`模板目录为空或不存在：${TEMPLATE_SRC}`)
const signature = signTemplateFiles(files)

const lines: string[] = []
lines.push("/**")
lines.push(" * 内置视频模板的内联副本 —— **自动生成，请勿手改**。")
lines.push(" *")
lines.push(" * 维护源：`packages/agents/assets/reel-template/`（真实工程文件，人类可读）。")
lines.push(" * 重新生成：`cd packages/agents && bun run scripts/embed-reel-template.ts`（改模板后必须重跑）。")
lines.push(" * 校验：`src/agents/reel/template.test.ts` 比对磁盘维护源与这里的签名，不一致即失败。")
lines.push(" */")
lines.push("")
lines.push("/** 模板内容签名（各文件按路径排序后取 sha256 前 16 位）：判定运行时依赖是否匹配当前模板。 */")
lines.push(`export const TEMPLATE_SIGNATURE = ${JSON.stringify(signature)}`)
lines.push("")
lines.push("/** 模板文件表：key = 相对路径，value = 文件内容（落位时按此展开成真实文件）。 */")
lines.push("export const TEMPLATE_FILES: Record<string, string> = {")
for (const key of keys) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(files[key])},`)
lines.push("}")
lines.push("")
lines.push("/** 模板声明的 Remotion 版本（供运行时与档位决策使用）。 */")
const pkg = JSON.parse(files["package.json"] ?? "{}") as { dependencies?: Record<string, string> }
lines.push(`export const TEMPLATE_REMOTION_VERSION = ${JSON.stringify(pkg.dependencies?.remotion ?? null)}`)
lines.push("")

mkdirSync(dirname(OUT_FILE), { recursive: true })
writeFileSync(OUT_FILE, lines.join("\n"))
const totalBytes = keys.reduce((sum, k) => sum + Buffer.byteLength(files[k], "utf8"), 0)
console.log(`[embed-reel-template] ${keys.length} 个文件 / ${(totalBytes / 1024).toFixed(1)}KB → ${relative(PKG_ROOT, OUT_FILE)} · 签名 ${signature}`)
