/**
 * 路径 → 编辑器语言 id 的**唯一真相**（服务端 `core/fs/mime.ts` 与前端文件工作台共用）。
 *
 * 为什么放 SDK：这条映射有两个消费方，且必须一致——
 * - 服务端：`GET /api/v1/fs/read` 回给编辑器的 `language`、只读判定与预览类别都按它；
 * - 前端：差异/比较/合并视图（内容来自 git，没有 `fs/read` 的应答可依）自己算语言 id。
 *
 * 早先前端另有一份手写映射（`main.ts:languageOf`），于是同一条路径在两处得出不同语言：
 * `x.mts`/`x.cts`（→ typescript）、`Cargo.toml`（→ ini）、`Dockerfile`/`Makefile`（无扩展名特殊名）在
 * 差异视图里一律是 `plaintext`（丢了高亮与符号），而编辑器里是正常的。收敛到这里后只有一份表。
 *
 * 纯数据 + 纯函数，**零依赖**（可安全进浏览器主入口——SDK 主入口不允许 node 内建）。
 */

/** 扩展名（小写、不含点）→ Monaco 语言 id。 */
export const FILE_LANGUAGE: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json", ipynb: "json", echarts: "json",
  webmanifest: "json",
  html: "html", htm: "html", xhtml: "html", vue: "html", svelte: "html",
  css: "css", scss: "scss", sass: "scss", less: "less",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", rb: "ruby", php: "php", pl: "perl", lua: "lua", r: "r",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", groovy: "groovy", gradle: "groovy",
  cs: "csharp", swift: "swift", dart: "dart",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  m: "objective-c", mm: "objective-c",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ksh: "shell",
  ps1: "powershell", psm1: "powershell", ps: "powershell",
  bat: "bat", cmd: "bat",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini", cfg: "ini", properties: "ini", env: "ini", editorconfig: "ini",
  xml: "xml", xsl: "xml", xsd: "xml", plist: "xml", svg: "xml",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", makefile: "makefile", mk: "makefile", cmake: "cmake",
  tf: "hcl", hcl: "hcl",
  diff: "diff", patch: "diff",
  tex: "latex", sol: "sol", wgsl: "wgsl", glsl: "cpp", hlsl: "cpp",
  rst: "restructuredtext", clj: "clojure", ex: "elixir", exs: "elixir", erl: "erlang",
  hs: "haskell", ml: "fsharp", fs: "fsharp", vb: "vb", pas: "pascal", asm: "asm", s: "asm",
  puml: "plaintext", plantuml: "plaintext", pu: "plaintext", iuml: "plaintext",
  mmd: "plaintext", mermaid: "plaintext", d2: "plaintext",
}

/**
 * 无扩展名（或点文件）特殊名 → 语言 id。键为**小写 basename**。
 *
 * `Dockerfile.dev`、`.env.local` 这类带后缀的变体由 `languageOfPath` 的**前缀规则**兜（见下）。
 */
export const SPECIAL_LANGUAGE: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".editorconfig": "ini",
  ".env": "ini",
  ".npmrc": "ini",
  license: "plaintext",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".bash_profile": "shell",
  ".gitconfig": "ini",
}

/**
 * 特殊名的**前缀**规则（`名称前缀 → 语言 id`）：`Dockerfile.dev`、`.env.example`、`.env.local`、
 * `Makefile.am` 这类变体在真实仓库里很常见，逐个列全不现实。
 *
 * 只对「无扩展名」或「扩展名恰好是变体后缀」的文件名生效的判定放在 `languageOfPath` 里：
 * 这里是按 basename 前缀匹配，顺序敏感（先长后短）。
 */
export const SPECIAL_PREFIX_LANGUAGE: Array<[string, string]> = [
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["cmakelists.txt", "cmake"],
  [".env.", "ini"],
  [".env", "ini"],
]

/** 路径的 basename（正反斜杠都认；不碰文件系统）。 */
export function baseNameOfPath(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").split("/").pop() ?? ""
}

/**
 * 路径扩展名（小写、不含点；无扩展名返回 ""）。
 *
 * 两处容错都是实测踩出来的：
 * - **尾随空格/点**：`"main.go "`（Windows 复制路径常见）原先解析出扩展名 `"go "` → 落 plaintext；
 * - 点文件（`.gitignore`）整段当扩展名（`"gitignore"`），由 `SPECIAL_LANGUAGE` 接管而不是这里。
 */
export function extOfPath(p: string): string {
  const base = baseNameOfPath(p).replace(/[ .]+$/, "")
  if (!base) return ""
  if (base.startsWith(".") && base.indexOf(".", 1) < 0) return base.slice(1).toLowerCase()
  const i = base.lastIndexOf(".")
  if (i <= 0) return ""
  return base.slice(i + 1).toLowerCase()
}

/**
 * 路径 → Monaco 语言 id（未知返回 `plaintext`）。**这是唯一入口**，服务端与前端都走它。
 *
 * 判定顺序（先扩展名、再特殊名）是有原因的：`makefile-helper.ts` 这种「特殊名前缀 + 真扩展名」必须以
 * 扩展名为准，否则会把一个 TS 源码文件当成 Makefile（反向也同理：`envoy.yaml` 不是 `.env`）。
 * 只有**扩展名认不出语言**时，特殊名与前缀规则才接管（`Dockerfile.dev` / `.env.example` / `Makefile.am`）。
 */
export function languageOfPath(p: string): string {
  const byExt = FILE_LANGUAGE[extOfPath(p)]
  if (byExt) return byExt
  const base = baseNameOfPath(p).replace(/[ .]+$/, "").toLowerCase()
  const special = SPECIAL_LANGUAGE[base]
  if (special) return special
  // 变体形态（Dockerfile.dev / .env.example / Makefile.am）：按前缀匹配，只在「base 以前缀 + 分隔符开头」
  // 时命中，避免 `envoy.yaml` 之类被误判（它本来就轮不到这里——扩展名已认出 yaml）
  for (const [prefix, lang] of SPECIAL_PREFIX_LANGUAGE) {
    if (base.length > prefix.length && base.startsWith(prefix) && /[.\-_]/.test(base.charAt(prefix.length))) return lang
  }
  return "plaintext"
}

/** 该路径是否属于「代码/文本」类（供前端判断要不要走编辑器，服务端的 kind 判定另有一套 MIME 表）。 */
export function isCodeLikeLanguage(language: string): boolean {
  return language !== "" && language !== "plaintext"
}
