/**
 * 文件工作台 · 资源管理器剪贴板（复制 / 粘贴）的纯逻辑。
 *
 * 只管「贴到哪儿、叫什么名字、什么时候不能贴」，与 DOM、网络无关。单独成模块的原因：
 * 落点算错就是覆盖别人的文件、或把一个目录粘进它自己的子树里（递归复制），
 * 这类判断必须能脱离浏览器单测。
 */

/** 剪贴板里的一个条目：根 id + **根内**相对路径。 */
export interface ClipEntry {
  root: string
  path: string
  isDir: boolean
}

/** 路径最后一段（条目名）。 */
export function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? path : path.slice(i + 1)
}

/** 父目录（根内相对路径；根目录自己返回空串）。 */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

/** 目录 + 名字拼成根内相对路径（目录为空串即根目录）。 */
export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/^\/+|\/+$/g, "")
  return d ? `${d}/${name}` : name
}

/** 目标就是源本身、或落在源的子树内——二者都拒绝（目录粘进自己的子目录会递归复制到爆）。 */
export function isSelfOrInside(src: string, dest: string): boolean {
  return dest === src || dest.startsWith(`${src}/`)
}

/**
 * 能否把剪贴板条目贴进这个根：服务端 `/fs/copy` 的源与目标都在**同一个根**内解析，
 * 跨根复制没有接口支持（如实禁止，不做「看起来能贴、贴了报错」的入口）。
 */
export function canPasteInto(clip: ClipEntry | null, root: string, writable: boolean): boolean {
  return !!clip && writable && clip.root === root
}

/**
 * 名字拆成「主干 + 扩展名」。目录没有扩展名；`.env` 这类隐藏文件整名当主干
 * （按最后一个点拆会得到「无主干 + 扩展名 `.env`」，副本名就成了「 - 副本.env」）。
 */
export function splitName(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: "" }
  const i = name.lastIndexOf(".")
  if (i <= 0) return { stem: name, ext: "" }
  return { stem: name.slice(0, i), ext: name.slice(i) }
}

/** 第 n 个副本名：`a.txt` → `a - 副本.txt` → `a - 副本 (2).txt`。 */
export function copyName(name: string, isDir: boolean, n = 1): string {
  const { stem, ext } = splitName(name, isDir)
  return n <= 1 ? `${stem} - 副本${ext}` : `${stem} - 副本 (${n})${ext}`
}

/**
 * 在 `taken`（目标目录现有条目名）里挑一个不撞名的落点：原名空着就用原名，
 * 否则依次试「- 副本」「- 副本 (2)」…，`limit` 次仍全撞则返回 null
 * （调用方据此报错——捏一个怪名字不如让用户知道这里已经堆满同名副本）。
 */
export function pickTargetPath(
  dir: string,
  name: string,
  isDir: boolean,
  taken: Iterable<string>,
  limit = 50,
): { path: string; renamed: boolean } | null {
  const used = new Set(taken)
  if (!used.has(name)) return { path: joinPath(dir, name), renamed: false }
  for (let n = 1; n <= limit; n++) {
    const candidate = copyName(name, isDir, n)
    if (!used.has(candidate)) return { path: joinPath(dir, candidate), renamed: true }
  }
  return null
}
