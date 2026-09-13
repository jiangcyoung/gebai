import { splitLines } from "./diff"

/**
 * patch 工具：unified diff 补丁解析与应用（纯函数，无 fs 依赖，与 diff.ts 同构）。
 * - 解析：`---`/`+++` 文件头（可省略）、`@@ -l,c +l,c @@` hunk 头（容错省略 count 的形式）、
 *   上下文/新增/删除行、`\ No newline` 标记；git 风格元数据行（diff --git/index/mode 等）容忍跳过；
 *   hunk 内的空行按空上下文行处理（unified diff 规范写作单个空格，构造补丁时常写成真空行）
 * - 匹配：hunk 的「上下文 + 删除」块在文件中逐档匹配——精确 → 忽略行尾空白 → 忽略首尾空白 →
 *   头尾上下文裁剪（各至多 PATCH_FUZZ_LINES 行）→ 仅删除行锚定；每档收集全部候选位置，
 *   再按 `@@` 声明行号就近选优；多候选且无行号可判时按歧义报错（绝不任选一处，防静默改错位置）
 * - 应用：统一走「块定位 + 块内按补丁顺序重放」——上下文沿用文件原有行、删除行跳过、新增行原位插入
 *   （纯新增 hunk 同一条路径，新增行夹在上下文中间也能正确落位）
 * - 原子性：任一 hunk 不匹配整体失败（返回失败 hunk 索引、原因与相近位置诊断），调用方保证不落盘
 */

/** 行号模糊容错：上下文裁剪行数上限。 */
export const PATCH_FUZZ_LINES = 3
/** 单次补丁 hunk 数上限。 */
export const PATCH_MAX_HUNKS = 100
/** patch 目标文件大小上限（字符）。 */
export const PATCH_MAX_FILE_BYTES = 5 * 1024 * 1024
/** 单处 hunk 的候选位置收集上限（重复内容极多时防拖慢）。 */
export const PATCH_MAX_CANDIDATES = 200
/** 多候选时声明行号的可信距离上限（行）：最佳候选超出即视为行号不可判，按歧义报错。 */
export const PATCH_ANCHOR_TOLERANCE = 30
/** 失败诊断中列出的相近位置条数上限。 */
export const PATCH_DIAG_CANDIDATES = 3

/** 补丁行类型：0=上下文、1=新增、-1=删除。 */
export type PatchLineKind = 0 | 1 | -1

export interface PatchLine {
  kind: PatchLineKind
  text: string
}

export interface PatchHunk {
  /** `@@` 头声明的旧侧起始行（1 起始；省略/未知为 0，仅用于多候选消歧与无上下文插入定位）。 */
  startA: number
  lines: PatchLine[]
}

export interface PatchFile {
  oldPath?: string
  newPath?: string
  /** 新建文件（`--- /dev/null`）。 */
  isNew: boolean
  hunks: PatchHunk[]
}

export interface AppliedHunk {
  /** 原始 hunk 序号（0 起始，对应补丁文本顺序）。 */
  index: number
  /** 应用后本 hunk 首个变更行在文件中的行号（1 起始）。 */
  line: number
  /** 本 hunk 造成的行数净变化（新增数 − 删除数）。 */
  delta: number
  /** 非精确匹配所用的宽松档位（精确匹配时缺省）。 */
  fuzzy?: string
}

export type ApplyPatchResult =
  | { ok: true; result: string; applied: AppliedHunk[] }
  | { ok: false; hunkIndex: number; error: string; diagnosis: string }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** 解析 unified diff 文本为文件补丁列表（git 风格元数据行容忍跳过；无 hunk 的文件不返回）。 */
export function parsePatch(text: string): PatchFile[] {
  const out: PatchFile[] = []
  let cur: PatchFile | null = null
  let curHunk: PatchHunk | null = null
  const raw = text.split("\n")
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop() // 末尾换行不产生多余行
  for (const r of raw) {
    const line = r.endsWith("\r") ? r.slice(0, -1) : r // 容错 CRLF
    const m = HUNK_RE.exec(line)
    if (m) {
      curHunk = { startA: Number(m[1]), lines: [] }
      if (!cur) {
        // 无文件头直接出现 hunk（头可省略）：匿名文件条目
        cur = { oldPath: undefined, newPath: undefined, isNew: false, hunks: [] }
        out.push(cur)
      }
      cur.hunks.push(curHunk)
      continue
    }
    if (line.startsWith("--- ")) {
      curHunk = null
      cur = { oldPath: line.slice(4), newPath: undefined, isNew: false, hunks: [] }
      out.push(cur)
      continue
    }
    if (line.startsWith("+++ ")) {
      curHunk = null
      if (!cur) {
        cur = { oldPath: undefined, newPath: undefined, isNew: false, hunks: [] }
        out.push(cur)
      }
      cur.newPath = line.slice(4)
      cur.isNew = cur.oldPath === "/dev/null" || cur.oldPath === "a/dev/null"
      continue
    }
    if (!curHunk) continue // 文件头外的元数据（diff --git/index/mode 等）跳过
    if (line === "") {
      curHunk.lines.push({ kind: 0, text: "" }) // 空行 = 空上下文行（规范写作单个空格）
      continue
    }
    if (line.startsWith("\\")) continue // `\ No newline at end of file` 标记（按无尾换行容错）
    if (line.startsWith("+")) curHunk.lines.push({ kind: 1, text: line.slice(1) })
    else if (line.startsWith("-")) curHunk.lines.push({ kind: -1, text: line.slice(1) })
    else curHunk.lines.push({ kind: 0, text: line.startsWith(" ") ? line.slice(1) : line })
  }
  for (const f of out) for (const h of f.hunks) trimBlankTail(h)
  return out.filter((f) => f.hunks.length > 0)
}

/** 修剪 hunk 尾部的空上下文行（补丁排版空行：hunk 之间/末尾的空行不代表文件内容）。 */
function trimBlankTail(hunk: PatchHunk): void {
  while (hunk.lines.length > 0) {
    const last = hunk.lines[hunk.lines.length - 1]
    if (last.kind === 0 && last.text === "") hunk.lines.pop()
    else break
  }
}

/** 行比较档：0=精确、1=忽略行尾空白、2=忽略首尾空白。 */
type LineEq = (a: string, b: string) => boolean

const MATCH_LEVELS: Array<{ note: string; eq: LineEq }> = [
  { note: "", eq: (a, b) => a === b },
  { note: "忽略行尾空白", eq: (a, b) => a.trimEnd() === b.trimEnd() },
  { note: "忽略行首尾空白", eq: (a, b) => a.trim() === b.trim() },
]

/** 收集块在文件中的全部匹配起点（上限 PATCH_MAX_CANDIDATES，防重复内容拖慢）。 */
function findCandidates(lines: string[], block: string[], eq: LineEq): number[] {
  const out: number[] = []
  if (!block.length || block.length > lines.length) return out
  const anchor = block[0]
  for (let i = 0; i <= lines.length - block.length; i++) {
    if (!eq(lines[i], anchor)) continue
    let ok = true
    for (let k = 1; k < block.length; k++) {
      if (!eq(lines[i + k], block[k])) {
        ok = false
        break
      }
    }
    if (ok) {
      out.push(i)
      if (out.length >= PATCH_MAX_CANDIDATES) break
    }
  }
  return out
}

/** 候选选优：唯一候选直接采用；多候选时按声明行号取最近者——距离并列或最近者仍嫌远
 *  （超出 PATCH_ANCHOR_TOLERANCE，行号不可信）一律判为歧义，交调用方报错引导，绝不任选一处。 */
function pickCandidate(cands: number[], expected: number | null): number | "ambiguous" {
  if (cands.length === 1) return cands[0]
  if (expected === null) return "ambiguous"
  let best = cands[0]
  let bestD = Math.abs(cands[0] - expected)
  let tie = false
  for (let i = 1; i < cands.length; i++) {
    const d = Math.abs(cands[i] - expected)
    if (d < bestD) {
      best = cands[i]
      bestD = d
      tie = false
    } else if (d === bestD) tie = true
  }
  if (tie || bestD > PATCH_ANCHOR_TOLERANCE) return "ambiguous"
  return best
}

/** 头/尾裁剪组合（按裁剪总量升序——少裁剪优先，减少误配空间）。 */
function fuzzCombos(maxHead: number, maxTail: number): Array<{ h: number; t: number }> {
  const out: Array<{ h: number; t: number }> = []
  for (let sum = 0; sum <= maxHead + maxTail; sum++) {
    for (let h = 0; h <= Math.min(sum, maxHead); h++) {
      const t = sum - h
      if (t <= maxTail) out.push({ h, t })
    }
  }
  return out
}

interface HunkMatch {
  at: number
  fuzzHead: number
  fuzzTail: number
  /** 宽松档位说明（精确匹配为空串）。 */
  note: string
  /** 仅按删除行锚定（上下文未校验，替换范围 = 删除行块）。 */
  delsOnly: boolean
}

type MatchOutcome =
  | { ok: true; match: HunkMatch }
  | { ok: false; ambiguous?: number[]; ambiguousNote?: string }

/**
 * 定位 hunk 的「上下文 + 删除」块：逐档匹配（精确 → 忽略空白 → 头尾裁剪 → 仅删除行锚定），
 * 每档收集全部候选后按声明行号就近选优；候选多且无行号可判 → 返回歧义（调用方报错引导）。
 */
function matchHunk(lines: string[], ctxAndDel: PatchLine[], expected: number | null): MatchOutcome {
  const len = ctxAndDel.length
  const firstDel = ctxAndDel.findIndex((l) => l.kind === -1)
  const lastDel = len - 1 - [...ctxAndDel].reverse().findIndex((l) => l.kind === -1)
  const hasDel = firstDel >= 0
  // 含删除行：删除行必在块内，裁剪只发生在头/尾上下文；无删除行：至少留 1 行上下文
  const maxHead = hasDel ? Math.min(PATCH_FUZZ_LINES, firstDel) : Math.min(PATCH_FUZZ_LINES, len - 1)
  const maxTail = hasDel ? Math.min(PATCH_FUZZ_LINES, len - 1 - lastDel) : Math.min(PATCH_FUZZ_LINES, len - 1)
  let ambiguous: { cands: number[]; note: string } | null = null
  // 优先「校验尽量多、比较尽量严」：外层按裁剪量升序，内层按匹配档升序——
  // 裁剪是最后手段（多一行上下文参与校验，就少一分误配风险）
  for (const { h, t } of fuzzCombos(maxHead, maxTail)) {
    if (h + t >= len) continue
    const block = ctxAndDel.slice(h, len - t).map((l) => l.text)
    if (!block.length) continue
    for (const level of MATCH_LEVELS) {
      const cands = findCandidates(lines, block, level.eq)
      if (!cands.length) continue
      const picked = pickCandidate(cands, expected)
      if (picked === "ambiguous") {
        if (!ambiguous) ambiguous = { cands, note: [level.note, h + t > 0 ? `已裁剪 ${h + t} 行上下文` : ""].filter(Boolean).join("；") }
        continue
      }
      const note = [level.note, h + t > 0 ? `已裁剪 ${h + t} 行上下文` : ""].filter(Boolean).join("；")
      return { ok: true, match: { at: picked, fuzzHead: h, fuzzTail: t, note, delsOnly: false } }
    }
  }
  // 兜底：仅删除行锚定（上下文抄错但删除行准确时救场；要求唯一或行号可判）
  if (hasDel) {
    const dblock = ctxAndDel.filter((l) => l.kind === -1).map((l) => l.text)
    const cands = findCandidates(lines, dblock, MATCH_LEVELS[2].eq)
    if (cands.length) {
      const picked = cands.length === 1 ? cands[0] : pickCandidate(cands, expected)
      if (picked !== "ambiguous") {
        return { ok: true, match: { at: picked, fuzzHead: 0, fuzzTail: 0, note: "仅按删除行定位（上下文未校验）", delsOnly: true } }
      }
      if (!ambiguous) ambiguous = { cands, note: "仅按删除行定位（上下文未校验）" }
    }
  }
  return ambiguous ? { ok: false, ambiguous: ambiguous.cands, ambiguousNote: ambiguous.note } : { ok: false }
}

const clip = (s: string): string => (s.length > 60 ? s.slice(0, 60) + "…" : s)

/** 行相似度（0~1，用于诊断中的「最相近位置」）：精确 1、仅空白差异 0.99、公共前缀占比 / 包含关系。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  const x = a.trim()
  const y = b.trim()
  if (x === y) return 0.99
  if (!x || !y) return 0
  let i = 0
  while (i < x.length && i < y.length && x[i] === y[i]) i++
  const prefix = i / Math.max(x.length, y.length)
  const contains = x.includes(y) || y.includes(x) ? 0.8 : 0
  return Math.max(prefix, contains)
}

/** 失败诊断：列出块内关键行在文件中的相近位置与建议 read 区间，供模型据实修正补丁。 */
function diagnoseHunk(lines: string[], hunk: PatchHunk, expected: number | null): string {
  const parts: string[] = []
  const key = hunk.lines.find((l) => l.kind === -1) ?? hunk.lines.find((l) => l.kind === 0)
  if (expected !== null) parts.push(`hunk 声明旧侧第 ${hunk.startA} 行（本次在第 ${expected + 1} 行附近寻找）`)
  if (!key) return parts.join("\n")
  const kindName = key.kind === -1 ? "删除行" : "上下文行"
  parts.push(`块内关键${kindName}「${clip(key.text)}」未在文件中找到相匹配的连续块`)
  const kt = key.text.trim()
  const same: number[] = []
  const scored: Array<{ i: number; s: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (kt !== "" && lines[i].trim() === kt) {
      same.push(i)
      continue
    }
    const s = similarity(key.text, lines[i])
    if (s >= 0.5) scored.push({ i, s })
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  const shown: Array<{ i: number; tag: string }> = []
  for (const i of same.slice(0, PATCH_DIAG_CANDIDATES)) shown.push({ i, tag: "内容一致（仅空白差异）" })
  for (const c of scored.slice(0, PATCH_DIAG_CANDIDATES)) shown.push({ i: c.i, tag: "最相近" })
  const uniq = shown.filter((s, idx) => shown.findIndex((u) => u.i === s.i) === idx).slice(0, PATCH_DIAG_CANDIDATES)
  if (uniq.length) {
    parts.push(`文件共 ${lines.length} 行，相近位置：`)
    for (const s of uniq) parts.push(`  第 ${s.i + 1} 行：${clip(lines[s.i])}（${s.tag}）`)
    parts.push(`建议 read 第 ${Math.max(1, uniq[0].i - 2)}-${uniq[0].i + 4} 行核对后重写该 hunk，或改用 edit 定点替换`)
  } else {
    parts.push(`文件中没有内容相近的行（文件共 ${lines.length} 行）——请确认目标文件是否正确、内容是否已被改动`)
  }
  return parts.join("\n")
}

function fail(hunkIndex: number, error: string, diagnosis = ""): ApplyPatchResult {
  return { ok: false, hunkIndex, error, diagnosis }
}

/**
 * 应用补丁（单个文件）。oldText 为当前文件内容（新文件传 ""，或 isNew 且内容为空时按新建处理）。
 * 失败时返回失败 hunk 序号、原因与相近位置诊断（整体不应用，调用方不得落盘）。
 */
export function applyPatch(oldText: string, patch: PatchFile): ApplyPatchResult {
  const newFile = patch.isNew && oldText === ""
  const trailingNL = oldText.endsWith("\n")
  const fileLines = splitLines(oldText)
  let lines = fileLines
  const applied: AppliedHunk[] = []
  let cumOffset = 0 // 先前 hunk 造成的行数偏移（声明行号的换算基准）

  for (let hi = 0; hi < patch.hunks.length; hi++) {
    const hunk = patch.hunks[hi]
    const ctxAndDel = hunk.lines.filter((l) => l.kind !== 1) // 上下文 + 删除（待匹配块）
    const dels = ctxAndDel.filter((l) => l.kind === -1)
    const adds = hunk.lines.filter((l) => l.kind === 1)

    if (newFile) {
      if (dels.length > 0 || ctxAndDel.some((l) => l.kind === 0)) {
        return fail(hi, "新建文件补丁仅允许新增行（+），不应包含删除/上下文行")
      }
      lines = [...lines, ...adds.map((l) => l.text)]
      applied.push({ index: hi, line: lines.length - adds.length + 1, delta: adds.length })
      cumOffset += adds.length
      continue
    }

    const expected = hunk.startA >= 1 ? hunk.startA - 1 + cumOffset : null

    // 无任何上下文/删除行（纯插入）：只能按声明行号定位
    if (ctxAndDel.length === 0) {
      const at = expected === null ? lines.length : expected
      if (at > lines.length) {
        return fail(
          hi,
          `hunk 声明旧侧第 ${hunk.startA} 行，但文件只有 ${lines.length} 行`,
          `该 hunk 只有新增行、没有上下文行，只能按 @@ 行号插入。请补上几行上下文行（推荐首尾各 2~3 行），或在 @@ 头写明正确的旧侧行号。`,
        )
      }
      lines = [...lines.slice(0, at), ...adds.map((l) => l.text), ...lines.slice(at)]
      applied.push({
        index: hi,
        line: at + 1,
        delta: adds.length,
        ...(expected === null ? { fuzzy: "无上下文行且未声明行号，已追加到文件末尾" } : {}),
      })
      cumOffset += adds.length
      continue
    }

    // 统一路径：定位「上下文 + 删除」块，再按补丁顺序在块内重放（纯新增同样适用）
    const outcome = matchHunk(lines, ctxAndDel, expected)
    if (!outcome.ok) {
      if (outcome.ambiguous && outcome.ambiguous.length > 1) {
        const at = outcome.ambiguous.slice(0, 8).map((i) => i + 1).join("、")
        return fail(
          hi,
          `hunk 在文件中有 ${outcome.ambiguous.length} 处候选位置（第 ${at} 行${outcome.ambiguous.length > 8 ? " 等" : ""}），无法判定目标`,
          `多候选且${expected === null ? "未声明旧侧行号" : `声明行号（旧侧第 ${hunk.startA} 行）附近无唯一候选`}：请补充（或修正）上下文行使块唯一，或在 @@ 头写明正确的旧侧行号。匹配档位：${outcome.ambiguousNote || "精确"}。`,
        )
      }
      const key = hunk.lines.find((l) => l.kind === -1) ?? hunk.lines.find((l) => l.kind === 0)
      return fail(
        hi,
        key ? `块内关键${key.kind === -1 ? "删除行" : "上下文行"}「${clip(key.text)}」未匹配到连续上下文` : "hunk 无可定位内容",
        diagnoseHunk(lines, hunk, expected),
      )
    }

    const { at, fuzzHead, fuzzTail, note, delsOnly } = outcome.match
    const out = lines.slice(0, at)
    if (delsOnly) {
      // 宽松兜底：删除行块被新增行替换，上下文行不参与定位（保持文件其余部分不变）
      for (const l of hunk.lines) if (l.kind === 1) out.push(l.text)
      out.push(...lines.slice(at + dels.length))
    } else {
      const blockLen = ctxAndDel.length - fuzzHead - fuzzTail
      let cursor = 0
      for (const l of hunk.lines) {
        if (l.kind === 1) {
          out.push(l.text) // 新增行插在补丁给定的位置上
          continue
        }
        const ci = cursor++
        if (l.kind === -1) continue // 删除行跳过
        // 上下文行沿用文件原有行（宽松匹配下避免把补丁里的写法差异写回文件）
        if (ci >= fuzzHead && ci < fuzzHead + blockLen) out.push(lines[at + (ci - fuzzHead)])
      }
      out.push(...lines.slice(at + blockLen))
    }
    const firstChange = hunk.lines.findIndex((l) => l.kind !== 0)
    const changeAt = firstChange >= 0 ? at + Math.max(0, firstChange - fuzzHead) : at
    lines = out
    applied.push({ index: hi, line: changeAt + 1, delta: adds.length - dels.length, ...(note ? { fuzzy: note } : {}) })
    cumOffset += adds.length - dels.length
  }

  const result = lines.length === 0 ? "" : lines.join("\n") + (trailingNL || newFile ? "\n" : "")
  return { ok: true, result, applied }
}
