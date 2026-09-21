/** 文件工作台：扩展名 → MIME / 预览类别 / 编辑器语言 的单一映射表（服务端与前端共用同一套分类语义）。
 *  - kind 决定前端用哪个 Viewer（text 走 Monaco、image 走图片查看器、office 走后端阅读视图…）；
 *  - mime 决定 `fs/raw` 的 Content-Type（浏览器原生解码：视频/音频/PDF/图片）；
 *  - language 为 Monaco 语言 id——**映射表已收敛到 `@gebai/sdk` 的 `file-language.ts`**（服务端与前端
 *    的差异/比较/合并视图共用一份真相，避免同一条路径在两处得出不同语言），这里只做转发。
 *  仅按扩展名判定（不做内容嗅探）；魔数识别由上层 file 工具的探测逻辑承担（本模块保持零依赖纯函数）。 */

import { extOfPath, languageOfPath } from "@gebai/sdk"

/** 预览类别：前端 Viewer 分派依据。 */
export type FileKind = "text" | "image" | "video" | "audio" | "pdf" | "office" | "archive" | "font" | "diagram" | "binary"

const MIME: Record<string, string> = {
  // 文本/代码
  txt: "text/plain", log: "text/plain", text: "text/plain", ini: "text/plain", conf: "text/plain", cfg: "text/plain",
  env: "text/plain", properties: "text/plain", gitignore: "text/plain", gitattributes: "text/plain", editorconfig: "text/plain",
  md: "text/markdown", markdown: "text/markdown", mdx: "text/markdown",
  html: "text/html", htm: "text/html", xhtml: "application/xhtml+xml",
  css: "text/css", scss: "text/x-scss", sass: "text/x-sass", less: "text/x-less",
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", jsx: "text/javascript",
  ts: "text/typescript", tsx: "text/typescript", mts: "text/typescript", cts: "text/typescript",
  json: "application/json", jsonc: "application/json", json5: "application/json", jsonl: "application/x-ndjson", ndjson: "application/x-ndjson",
  webmanifest: "application/manifest+json",
  xml: "application/xml", svg: "image/svg+xml", xsl: "application/xml", xsd: "application/xml", plist: "application/xml",
  yaml: "text/yaml", yml: "text/yaml", toml: "text/toml",
  csv: "text/csv", tsv: "text/tab-separated-values",
  sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript", fish: "text/x-shellscript",
  ps1: "text/x-powershell", psm1: "text/x-powershell", bat: "text/x-bat", cmd: "text/x-bat",
  py: "text/x-python", rb: "text/x-ruby", php: "text/x-php", pl: "text/x-perl", lua: "text/x-lua", r: "text/x-r",
  go: "text/x-go", rs: "text/x-rust", java: "text/x-java", kt: "text/x-kotlin", kts: "text/x-kotlin",
  c: "text/x-c", h: "text/x-c", cc: "text/x-c++", cpp: "text/x-c++", cxx: "text/x-c++", hpp: "text/x-c++", hh: "text/x-c++",
  cs: "text/x-csharp", swift: "text/x-swift", m: "text/x-objectivec", mm: "text/x-objectivec",
  scala: "text/x-scala", groovy: "text/x-groovy", dart: "text/x-dart", vue: "text/x-vue", svelte: "text/x-svelte",
  sql: "text/x-sql", graphql: "text/x-graphql", gql: "text/x-graphql", proto: "text/x-proto",
  puml: "text/x-plantuml", plantuml: "text/x-plantuml", pu: "text/x-plantuml", iuml: "text/x-plantuml",
  mmd: "text/x-mermaid", mermaid: "text/x-mermaid", d2: "text/x-d2", echarts: "application/json",
  dockerfile: "text/x-dockerfile", makefile: "text/x-makefile", mk: "text/x-makefile", cmake: "text/x-cmake",
  gradle: "text/x-gradle", tf: "text/x-terraform", hcl: "text/x-hcl", nix: "text/x-nix",
  diff: "text/x-diff", patch: "text/x-diff", lock: "text/plain", sum: "text/plain", mod: "text/plain",
  wgsl: "text/x-wgsl", glsl: "text/x-glsl", hlsl: "text/x-hlsl", sol: "text/x-solidity", tex: "text/x-tex",
  // 图片
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic",
  // 音视频
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
  aac: "audio/aac", opus: "audio/opus", weba: "audio/webm", mid: "audio/midi",
  // 文档
  pdf: "application/pdf",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf", epub: "application/epub+zip",
  // 归档
  zip: "application/zip", jar: "application/java-archive", war: "application/java-archive",
  gz: "application/gzip", tgz: "application/gzip", bz2: "application/x-bzip2", xz: "application/x-xz",
  "7z": "application/x-7z-compressed", tar: "application/x-tar", rar: "application/vnd.rar",
  // 字体
  ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", eot: "application/vnd.ms-fontobject",
  // 二进制/其他
  wasm: "application/wasm", exe: "application/vnd.microsoft.portable-executable", dll: "application/vnd.microsoft.portable-executable",
  so: "application/x-sharedlib", dylib: "application/x-sharedlib", bin: "application/octet-stream",
  db: "application/vnd.sqlite3", sqlite: "application/vnd.sqlite3", sqlite3: "application/vnd.sqlite3",
  ipynb: "application/x-ipynb+json",
}

/** 无扩展名的特殊文件名 → MIME / 类型（Dockerfile、Makefile、.gitignore 等）。语言 id 见 SDK 的 `file-language.ts`。 */
const SPECIAL: Record<string, { mime: string; kind?: FileKind }> = {
  dockerfile: { mime: "text/x-dockerfile" },
  makefile: { mime: "text/x-makefile" },
  "cmakelists.txt": { mime: "text/x-cmake" },
  ".gitignore": { mime: "text/plain" },
  ".gitattributes": { mime: "text/plain" },
  ".editorconfig": { mime: "text/plain" },
  ".env": { mime: "text/plain" },
  ".npmrc": { mime: "text/plain" },
  "license": { mime: "text/plain" },
  ".bashrc": { mime: "text/x-shellscript" },
  ".zshrc": { mime: "text/x-shellscript" },
  ".gitconfig": { mime: "text/plain" },
}

/** office 阅读视图支持的扩展名（与 wps 子Agent 的读取模型一致）。 */
const OFFICE_EXT = new Set(["docx", "xlsx", "xlsm", "pptx"])
/** 图表源文件（前端 diagram.ts 渲染管线支持）。 */
export const DIAGRAM_EXT = new Set(["puml", "plantuml", "pu", "iuml", "mmd", "mermaid", "d2", "echarts"])
/** 可编辑（文本）扩展名之外的二进制归档/文档：仅查看。 */
export const ARCHIVE_EXT = new Set(["zip", "jar", "war", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"])

/** 路径扩展名（小写，不含点；无扩展名返回 ""）。实现收敛到 SDK（服务端与前端同一套容错）。 */
export function extOf(p: string): string {
  return extOfPath(p)
}

/** 文件名（basename）。 */
export function baseOf(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? ""
}

export function mimeForPath(p: string): string {
  const base = baseOf(p).toLowerCase()
  const special = SPECIAL[base]
  if (special) return special.mime
  const ext = extOf(p)
  return MIME[ext] ?? "application/octet-stream"
}

/** 预览类别：前端 Viewer 分派（与 DESIGN「文件工作台·预览矩阵」一一对应）。 */
export function kindForPath(p: string): FileKind {
  const base = baseOf(p).toLowerCase()
  if (SPECIAL[base]) return "text"
  const ext = extOf(p)
  if (!ext) return "text" // 无扩展名按文本尝试（读失败前端回退 hex）
  if (OFFICE_EXT.has(ext)) return "office"
  if (DIAGRAM_EXT.has(ext)) return "diagram"
  if (ARCHIVE_EXT.has(ext)) return "archive"
  const mime = MIME[ext]
  if (!mime) return "text" // 未知扩展名：按文本尝试（编码探测失败则前端回退 hex 视图）
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("font/")) return "font"
  if (mime === "application/pdf") return "pdf"
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/x-ndjson" || mime === "application/x-ipynb+json") return "text"
  if (mime === "application/vnd.sqlite3") return "binary"
  if (mime.startsWith("application/zip") || mime.startsWith("application/gzip") || mime.startsWith("application/x-tar") || mime.startsWith("application/x-7z") || mime.startsWith("application/x-bzip2") || mime.startsWith("application/x-xz") || mime.startsWith("application/vnd.rar") || mime.startsWith("application/java-archive")) return "archive"
  if (mime.startsWith("application/vnd.openxmlformats") || mime.startsWith("application/vnd.ms-") || mime.startsWith("application/vnd.oasis")) return "office"
  return "binary"
}

/** Monaco 语言 id（未知返回 plaintext）。映射表在 SDK（见文件头说明）。 */
export function languageForPath(p: string): string {
  return languageOfPath(p)
}

/** kind 是否属于「可编辑文本」（只有文本/代码类开放编辑，媒体/文档/归档类无编辑入口）。 */
export function isEditableKind(kind: FileKind): boolean {
  return kind === "text" || kind === "diagram"
}

/** kind 是否适合走 `fs/raw` 二进制流（浏览器原生解码）。 */
export function isRawKind(kind: FileKind): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "font" || kind === "binary" || kind === "archive" || kind === "office"
}
