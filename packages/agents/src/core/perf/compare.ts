/**
 * 报告间对比（性能分析类子Agent 共用）：把两份报告的关键度量与问题清单做差异比对。
 *
 * 用途：改前改后的同一负载（或两次采集）**自动比对**——「利用率涨了多少、热点内核换了没有、
 * 哪个问题消失了、有没有新问题冒出来」。没有这一步，优化前后只能靠人肉读两份输出。
 *
 * 设计要点：
 * - **只比可比项**：按度量名对齐（两侧同名度量才比），缺项如实标「仅一侧有」，不臆造差值；
 * - **方向即结论**：高优（利用率、忙碌）升好降坏，低优（空闲缝、同步等待、显存传输）反之——
 *   方向由调用方按度量名声明，避免把「耗时降低」误报成退化；
 * - **问题清单按 id 对齐**：新增/消失/严重度变化三类，比数值更贴近「改了什么」。
 */

export interface CompareMetric {
  name: string
  /** 数值型度量（同名的数值项才计算差值）。 */
  value?: number
  /** 该度量「越大越好」为 true，「越小越好」为 false，无法定方向则 undefined。 */
  higherIsBetter?: boolean
  /** 展示用文本（无原始数值时的兜底）。 */
  text?: string
  /**
   * 数值的单位（如 "ms"/"MB"/"%"）——**只有两侧单位相同才比较数值**。
   * 否则 "3.9 MB" 与 "679.0 KB" 会被当成 3.9 与 679 直接比大小，得出完全错误的结论。
   */
  unit?: string
}

export interface CompareFinding {
  id: string
  severity: string
  title: string
  /** 可回收时间（ns），用于「改后回收了多少」。 */
  reclaimableNs?: number
}

export interface SideSnapshot {
  /** 该侧的标识（报告文件名或用户给的标签）。 */
  label: string
  metrics: CompareMetric[]
  findings: CompareFinding[]
}

export type DeltaKind = "improved" | "regressed" | "unchanged" | "negligible" | "only-before" | "only-after" | "incomparable"

/**
 * 显著差异的相对下限：变化幅度低于它记为「持平（差异在阈值内）」。
 *
 * 取舍理由：实测对比两份不同负载的报告时，0.0% → 0.4% 这类差异被判为「退化」——数值上成立，
 * 但对决策毫无价值，反而让真正的大变化被淹没。默认 1%，可用 options 覆盖。
 */
export const DEFAULT_SIGNIFICANCE_PCT = 1

export interface MetricDelta {
  name: string
  kind: DeltaKind
  beforeText: string
  afterText: string
  /** 相对变化（仅数值可比且有非零基准时给出）。 */
  changePct?: number
}

export interface FindingDelta {
  id: string
  title: string
  /** new=改后新出现，fixed=改后消失，changed=两侧都有但严重度/可回收量变化。 */
  kind: "new" | "fixed" | "changed" | "unchanged"
  beforeSeverity?: string
  afterSeverity?: string
  beforeReclaimableNs?: number
  afterReclaimableNs?: number
}

export interface CompareResult {
  metrics: MetricDelta[]
  findings: FindingDelta[]
  /**
   * 问题总代价（可回收时间）的净变化：**后侧全部问题之和 − 前侧全部问题之和**（含新增/消失）。
   * 负 = 问题代价下降。只算两侧共有问题会看不见「修好的问题省了多少」，故按两侧各自全量求和。
   */
  reclaimableDeltaNs: number
  /** 前侧问题可回收时间合计（含所有问题）。 */
  beforeReclaimableNs: number
  /** 后侧问题可回收时间合计。 */
  afterReclaimableNs: number
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

function rank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 5
}

/** 对比两侧快照（options.significancePct 控制「多小算持平」，默认 1%）。 */
export function compareSnapshots(before: SideSnapshot, after: SideSnapshot, options: { significancePct?: number } = {}): CompareResult {
  const significance = options.significancePct ?? DEFAULT_SIGNIFICANCE_PCT
  const beforeByName = new Map(before.metrics.map((m) => [m.name, m]))
  const afterByName = new Map(after.metrics.map((m) => [m.name, m]))
  const names = [...new Set([...beforeByName.keys(), ...afterByName.keys()])]
  const metrics: MetricDelta[] = []
  for (const name of names) {
    const b = beforeByName.get(name)
    const a = afterByName.get(name)
    const show = (m?: CompareMetric): string => (m ? (m.text ?? (m.value === undefined ? "—" : String(m.value))) : "（无）")
    if (!b || !a) {
      metrics.push({ name, kind: b ? "only-before" : "only-after", beforeText: show(b), afterText: show(a) })
      continue
    }
    // 单位不同则不可比（跨单位比大小会得出错误结论，如 MB 与 KB）
    const unitMismatch = (b.unit ?? "") !== (a.unit ?? "")
    if (b.value === undefined || a.value === undefined || b.higherIsBetter === undefined || unitMismatch) {
      metrics.push({ name, kind: "incomparable", beforeText: show(b), afterText: show(a) })
      continue
    }
    const diff = a.value - b.value
    const changePct = b.value !== 0 ? (diff / Math.abs(b.value)) * 100 : undefined
    // 差异小于显著性阈值 → 持平（不把噪声级差异报成改善/退化）
    if (diff === 0 || (changePct !== undefined && Math.abs(changePct) < significance)) {
      metrics.push({ name, kind: diff === 0 ? "unchanged" : "negligible", beforeText: show(b), afterText: show(a), changePct })
      continue
    }
    const improved = b.higherIsBetter ? diff > 0 : diff < 0
    metrics.push({ name, kind: improved ? "improved" : "regressed", beforeText: show(b), afterText: show(a), changePct })
  }

  // 问题清单按 id 对齐
  const beforeById = new Map(before.findings.map((f) => [f.id, f]))
  const afterById = new Map(after.findings.map((f) => [f.id, f]))
  const beforeReclaimableNs = before.findings.reduce((acc, f) => acc + (f.reclaimableNs ?? 0), 0)
  const afterReclaimableNs = after.findings.reduce((acc, f) => acc + (f.reclaimableNs ?? 0), 0)
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])]
  const findings: FindingDelta[] = []
  let reclaimableDeltaNs = 0
  for (const id of ids) {
    const b = beforeById.get(id)
    const a = afterById.get(id)
    if (!b && a) {
      findings.push({ id, title: a.title, kind: "new", afterSeverity: a.severity, afterReclaimableNs: a.reclaimableNs })
      reclaimableDeltaNs += a.reclaimableNs ?? 0
      continue
    }
    if (b && !a) {
      findings.push({ id, title: b.title, kind: "fixed", beforeSeverity: b.severity, beforeReclaimableNs: b.reclaimableNs })
      reclaimableDeltaNs -= b.reclaimableNs ?? 0
      continue
    }
    if (!b || !a) continue
    reclaimableDeltaNs += (a.reclaimableNs ?? 0) - (b.reclaimableNs ?? 0)
    const changed = rank(a.severity) !== rank(b.severity) || (a.reclaimableNs ?? 0) !== (b.reclaimableNs ?? 0)
    findings.push({
      id,
      title: a.title,
      kind: changed ? "changed" : "unchanged",
      beforeSeverity: b.severity,
      afterSeverity: a.severity,
      beforeReclaimableNs: b.reclaimableNs,
      afterReclaimableNs: a.reclaimableNs,
    })
  }
  return { metrics, findings, reclaimableDeltaNs, beforeReclaimableNs, afterReclaimableNs }
}

/** 对比结果的紧凑文本（模型可直接引用；数值带箭头与百分比）。 */
export function renderCompare(
  before: SideSnapshot,
  after: SideSnapshot,
  result: CompareResult,
  fmtNs: (ns: number) => string,
): string[] {
  const lines: string[] = []
  lines.push(`对比：${before.label} → ${after.label}`)
  lines.push("")
  lines.push("【度量差异】")
  // 标记只说「好还是坏」，百分比只说「变化多少」——早期用 ↑/↓ 表示数值升降、与好坏标签混在一起，
  // 读起来自相矛盾（如「↑ 退化（-75.9%）」），故拆开表述。
  const label: Record<DeltaKind, string> = {
    improved: "改善",
    regressed: "退化",
    unchanged: "持平",
    negligible: "持平（差异在阈值内）",
    "only-before": "仅改前有",
    "only-after": "仅改后有",
    incomparable: "无法比较",
  }
  for (const m of result.metrics) {
    const pct = m.changePct === undefined ? "" : `，变化 ${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%`
    lines.push(`  ${m.name}：${m.beforeText} → ${m.afterText}　[${label[m.kind]}${pct}]`)
  }
  lines.push("")
  lines.push("【问题清单差异】")
  const newOnes = result.findings.filter((f) => f.kind === "new")
  const fixed = result.findings.filter((f) => f.kind === "fixed")
  const changed = result.findings.filter((f) => f.kind === "changed")
  lines.push(`  新增 ${newOnes.length} 项、消失 ${fixed.length} 项、严重度或代价变化 ${changed.length} 项`)
  for (const f of newOnes) lines.push(`  ＋ [${f.afterSeverity}] ${f.title}`)
  for (const f of fixed) lines.push(`  － [${f.beforeSeverity}] ${f.title}`)
  for (const f of changed) {
    const d = (f.afterReclaimableNs ?? 0) - (f.beforeReclaimableNs ?? 0)
    lines.push(
      `  ~ [${f.beforeSeverity} → ${f.afterSeverity}] ${f.title}${d !== 0 ? `（可回收时间变化 ${d > 0 ? "+" : ""}${fmtNs(d)}）` : ""}`,
    )
  }
  lines.push("")
  const net = result.reclaimableDeltaNs
  lines.push(
    `问题可回收时间合计（两侧各自全部问题）：${fmtNs(result.beforeReclaimableNs)} → ${fmtNs(result.afterReclaimableNs)}（净变化 ${
      net === 0 ? "持平" : `${net > 0 ? "+" : "-"}${fmtNs(Math.abs(net))}${net > 0 ? "（问题总代价上升）" : "（问题总代价下降）"}`
    }）`,
  )
  lines.push("")
  lines.push("说明：度量差异按同名对齐（仅一侧有的如实标注，不做推算）；问题差异按问题 id 对齐——比数值更贴近「改了什么」。")
  return lines
}
