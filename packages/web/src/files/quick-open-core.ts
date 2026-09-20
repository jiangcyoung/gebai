/**
 * 「快速打开」的匹配与排序（纯函数，无 DOM）——VSCode Quick Open 的手感由这里决定。
 *
 * 三条性质决定手感，缺一个都会「能用但别扭」：
 * ① **子序列匹配**：`smain` 命中 `src/main.ts`（敲缩写是主要用法）；
 * ② **最优对齐**：同一查询在同一路径里有多条对齐路径，必须挑分最高的那条。贪心取最左命中会挑错——
 *    `smain` 对 `packages/web/src/main.ts` 会先吃 `packages` 里的 s（离 `main` 老远），
 *    而正解是 `s(rc)…main` 两个**段首**对齐。这一条直接决定「敲缩写时第一个跳出来的是不是我想要的」；
 * ③ **段首与连续最值钱，跨目录跳跃要付代价**：`webmain` 该赢「web …（几十字符）… main」。
 *    排序不稳时用户会退化成滑鼠标去挑，快捷键就白做了。
 *
 * 实现：候选先用**廉价的子序列预筛**丢掉绝大多数，再用动态规划求最优对齐（O(查询长度 × 路径长度)），
 * 这样万级文件也不会逐键卡顿。
 */

/** 一次匹配的结果：得分 + 命中字符下标（下标供前端高亮）。 */
export interface FuzzyMatch {
  score: number
  positions: number[]
}

/* 打分权重：数值本身没有含义，只有相对关系有意义（校准见 quick-open-core.test.ts 的「排序符合直觉」用例）。 */
const BASE = 4
/** 连续命中：**手感最重的一项**——散落各处的命中与一段连续命中应该差出一大截。 */
const CONSEC = 16
const BOUNDARY = 14
const CAMEL = 8
/** 命中落在文件名段内的每个字符加分（目录名不该和文件名一样值钱）。 */
const IN_BASENAME = 5
/** 整个查询都落在文件名段内：强信号（“我要的就是这个文件名”）。 */
const NAME_MATCH = 24
/** 跳过的每个字符扣分（跨段跳跃代价更大，见下）。 */
const GAP = 2
/** 跳过的每一级目录（路径分隔符）额外扣分——跨段跳跃比同段内跳跃代价大。 */
const SEP_GAP = 16
/** 查询长度上限（超出按前缀截断：再长也不是「快速打开」的用法，且 DP 宽度要付代价）。 */
const MAX_QUERY = 48

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]!
  return prev === "/" || prev === "\\" || prev === "-" || prev === "_" || prev === "." || prev === " "
}

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z"
}

/** 命中该字符本身的价值（不含跳跃代价）。 */
function charScore(target: string, i: number, basenameStart: number): number {
  let s = BASE
  if (isBoundary(target, i)) s += BOUNDARY
  else if (isUpper(target[i]!) && !isUpper(target[i - 1]!)) s += CAMEL
  if (i >= basenameStart) s += IN_BASENAME
  return s
}

/**
 * 在 `target` 中按子序列匹配 `query`（大小写不敏感），无匹配返回 null。
 *
 * 返回的是**最优对齐**（分数最高的那组命中位置）：贪心最左匹配在同一路径有多种对齐时会挑到差的那个。
 *
 * 计分刻意**不罚前置目录**：`packages/web/src/main.ts` 不该因为路径深就输给 `scripts/resources/manifest.json`
 * —— 真正区分「想要的是哪个」的信号是对齐质量（连续、段首、落在文件名段），不是路径长短。
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim()
  if (!q) return { score: 0, positions: [] }
  const ql = q.toLowerCase()
  const tl = target.toLowerCase()
  const qn = Math.min(ql.length, MAX_QUERY)
  const tn = target.length

  // 廉价预筛：先确认子序列存在，不存在立刻返回（绝大多数候选死在这一步）
  let ti = 0
  for (let qi = 0; qi < qn; qi++) {
    const c = ql[qi]!
    while (ti < tn && tl[ti] !== c) ti++
    if (ti >= tn) return null
    ti++
  }
  if (qn === 0) return { score: 0, positions: [] }

  // 分隔符前缀计数：算「一段里跨了几级目录」用（O(1) 取值）
  const sepPrefix = new Int32Array(tn + 1)
  for (let i = 0; i < tn; i++) sepPrefix[i + 1] = sepPrefix[i]! + (target[i] === "/" || target[i] === "\\" ? 1 : 0)
  const lastSep = target.lastIndexOf("/")
  const basenameStart = lastSep < 0 ? 0 : lastSep + 1

  const NEG = -1e9
  // dp[i] = 以 target[i] 结尾、对齐到当前查询字符的最优分数；parent 用于回溯命中位置
  let prev = new Float64Array(tn).fill(NEG)
  let cur = new Float64Array(tn).fill(NEG)
  // 同层的对齐起点（查询首字符落在哪儿）——判「整个查询都在文件名段内」用（文件名命中是强信号）
  let prevStart = new Int32Array(tn).fill(-1)
  let curStart = new Int32Array(tn).fill(-1)
  const parents: Int32Array[] = []
  for (let qi = 0; qi < qn; qi++) {
    cur.fill(NEG)
    curStart.fill(-1)
    const parent = new Int32Array(tn).fill(-1)
    parents.push(parent)
    // 上一步的「跳跃转移」增量最大值：p ≤ i-2 的最优值（含跳跃代价的可分离部分）
    let bestJump = NEG
    let bestJumpAt = -1
    let bestJumpStart = -1
    for (let i = 0; i < tn; i++) {
      const targetChar = tl[i]!
      if (targetChar === ql[qi]) {
        const base = charScore(target, i, basenameStart)
        let best = NEG
        let from = -1
        let start = -1
        if (qi === 0) {
          // 首个查询字符：前面的目录不计代价（路径深度不该影响“想要的是哪个文件”）
          best = base
          from = -1
          start = i
        } else {
          // ① 紧邻上一个命中（连续命中，不付跳跃代价）
          if (i > 0 && prev[i - 1]! > NEG) {
            best = prev[i - 1]! + base + CONSEC
            from = i - 1
            start = prevStart[i - 1]!
          }
          // ② 跳跃转移（p ≤ i-2）：跳跃代价可分离，用滚动最大值 O(1) 取最优
          if (bestJump > NEG) {
            const cand = bestJump + base - (i - 1) * GAP - sepPrefix[i]! * SEP_GAP
            if (cand > best) {
              best = cand
              from = bestJumpAt
              start = bestJumpStart
            }
          }
        }
        cur[i] = best
        curStart[i] = start
        parent[i] = from
      }
      // 把 p = i-1 纳入下一轮的跳跃候选（这样下一轮可选的 p ≤ (i+1)-2 = i-1）
      if (qi > 0 && i >= 1 && prev[i - 1]! > NEG) {
        const p = i - 1
        const value = prev[p]! + p * GAP + sepPrefix[p + 1]! * SEP_GAP
        if (value > bestJump) {
          bestJump = value
          bestJumpAt = p
          bestJumpStart = prevStart[p]!
        }
      }
    }
    let swap = prev
    prev = cur
    cur = swap
    let swapStart = prevStart
    prevStart = curStart
    curStart = swapStart
  }

  // 取最优终点，并按 parent 回溯命中位置
  let bestEnd = -1
  let bestScore = NEG
  for (let i = 0; i < tn; i++) {
    const v = prev[i]!
    if (v <= NEG) continue
    // 尾部未命中的部分按字符/目录计代价（晚命中更好：越靠后越具体）
    const tail = (tn - 1 - i) * GAP + (sepPrefix[tn]! - sepPrefix[i + 1]!) * SEP_GAP
    // 整个查询都落在文件名段内：额外加成（“要的就是这个文件名”）
    const nameBonus = prevStart[i]! >= basenameStart ? NAME_MATCH : 0
    const score = v - tail + nameBonus
    if (score > bestScore) {
      bestScore = score
      bestEnd = i
    }
  }
  if (bestEnd < 0) return null
  const positions: number[] = []
  let idx = bestEnd
  for (let qi = qn - 1; qi >= 0 && idx >= 0; qi--) {
    positions.push(idx)
    idx = parents[qi]![idx]!
  }
  positions.reverse()
  return { score: bestScore, positions }
}

/** 路径归一（统一分隔符、去首尾空白）：索引与查询两侧同口径，避免 Windows 反斜杠漏匹配。 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}

/** 排序结果项。 */
export interface QuickOpenItem {
  path: string
  /** 命中字符下标（整路径坐标系），供高亮。 */
  positions: number[]
  score: number
  /** 是否来自「最近打开」。 */
  recent: boolean
}

export interface RankOptions {
  limit?: number
  /** 最近打开的文件（相对当前根，最近的在前）——空查询时显示它，有查询时给加成。 */
  recent?: string[]
}

/**
 * 排序候选：有查询 → 模糊筛选 + 打分排序；无查询 → 最近打开（VSCode 的空查询行为）。
 *
 * 同分时按路径长度、再按字典序——**顺序必须稳定**，否则同样的输入每次结果顺序不同，
 * 用户刚记住的位置就变了（键盘操作最怕这个）。
 */
export function rankPaths(query: string, paths: readonly string[], opts: RankOptions = {}): QuickOpenItem[] {
  const limit = opts.limit ?? 200
  const q = query.trim()
  const recentList = (opts.recent ?? []).map(normalizePath)
  const recentSet = new Set(recentList)
  if (!q) {
    return recentList.slice(0, limit).map((path, i) => ({ path, positions: [], score: limit - i, recent: true }))
  }
  const scored: QuickOpenItem[] = []
  for (const raw of paths) {
    const path = normalizePath(raw)
    const m = fuzzyMatch(q, path)
    if (!m) continue
    // 最近打开过的候选抬一手（VSCode 同样把它带回前面），但不至于压过精确对齐
    const bonus = recentSet.has(path) ? 25 : 0
    scored.push({ path, positions: m.positions, score: m.score + bonus, recent: recentSet.has(path) })
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return scored.slice(0, limit)
}
