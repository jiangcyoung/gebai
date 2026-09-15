/**
 * 设计 token —— 全片视觉与动效的唯一真相源。
 *
 * 这里的默认值是一套**中性的暗场占位色**，不是"宣传片皮肤"。按工作流第一条纪律：视觉语言必须
 * 从目标产品自身生长——开工第一步应当把本文件换成从产品提取的 tokens（字体家族与字重、字号层级、
 * 行高字距、圆角与间距、背景/表面/正文/强调/状态色、渐变与材质），片中所有标题、字幕、数字、
 * 字卡、版式、转场、粒子与光效都复用同一套值。改这一个文件即可换掉整片皮肤。
 */
import { Easing } from "remotion"

/** 色板。accent 承担"唯一强调色"职责；多色相并发会把画面推向廉价。 */
export const C = {
  bg: "#0b0d12",
  bgSoft: "#12151c",
  /** 玻璃表面（低不透明度白 + 背景模糊，配 Panel 使用）。 */
  surface: "rgba(255,255,255,0.045)",
  accent: "#7aa2f7",
  accentSoft: "rgba(122,162,247,0.18)",
  /** 暖色副调（只用于点缀：金尘、余晖）。 */
  warm: "#e0b070",
  text: "#e9edf5",
  textDim: "#98a2b6",
  textFaint: "#5b6577",
  line: "rgba(255,255,255,0.10)",
  lineStrong: "rgba(255,255,255,0.18)",
  success: "#5fd39a",
  danger: "#e06c75",
  paper: "#f2efe8",
  black: "#000000",
} as const

/**
 * 字体栈。中文字体必须**渲染机本机存在**（Remotion 走 Chromium 系统字体），
 * 故按"常见开源中文字体 → 系统字体 → 通用族"排列，末尾永远留通用族兜底。
 */
export const F = {
  serif: '"Noto Serif CJK SC","Noto Serif SC","Source Han Serif SC","Songti SC",Georgia,serif',
  sans: '"Noto Sans CJK SC","Noto Sans SC","Source Han Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  mono: '"JetBrains Mono","DejaVu Sans Mono",ui-monospace,SFMono-Regular,Menlo,monospace',
} as const

/**
 * 缓动族——**一个品牌一种动效嗓音**：入场/相机/批量/退场都从这里取，
 * 不允许各镜头自造曲线（混两套曲线读作拼盘）。
 */
export const EASE = {
  /** 主入场（缓和出，最常用）。 */
  out: Easing.bezier(0.22, 1, 0.36, 1),
  /** 相机与位移（长时间运动不疲劳）。 */
  cam: Easing.bezier(0.33, 0, 0.15, 1),
  /** 对称进出（网格/整墙批量）。 */
  inOut: Easing.bezier(0.4, 0, 0.2, 1),
  /** 硬加速：批量入场越往后越密（批量元素的节奏感来源）。 */
  accel: Easing.bezier(0.6, 0, 0.9, 0.4),
  /** 起笔（微 anticipation）。 */
  in: Easing.bezier(0.6, 0, 0.8, 0.2),
  /** 弹性落定（仅用于"新元素注册/落位"这类需要一点活性的场合）。 */
  lively: Easing.bezier(0.16, 1, 0.3, 1),
} as const

/**
 * 时值 token（帧 @30fps）。排时间线时**先划走 hold/rest 帧再排动效**——
 * 节奏偏好是单向的：观众只会说"太快了"，从不说"太慢了"。
 */
export const T = {
  micro: 12,
  small: 21,
  mid: 34,
  big: 48,
  /** 关键信息/品牌字标落定后的完整静止（≥1s）。 */
  hold: 30,
  /** 批量动作收尾的呼吸。 */
  rest: 15,
  /** 相邻镜头的最小交棒缓冲。 */
  gap: 6,
} as const

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 网格底纹（Backplate 用）：返回可直接塞进 backgroundImage 的 CSS。 */
export const gridCss = (size: number, color: string): string =>
  `repeating-linear-gradient(to right, ${color} 0 1px, transparent 1px ${size}px), repeating-linear-gradient(to bottom, ${color} 0 1px, transparent 1px ${size}px)`

/**
 * 确定性伪随机（mulberry32）。渲染必须逐帧可复现：**禁用 Math.random / Date.now**，
 * 一切"随机感"都从这里取，种子由调用方给定（同一画面每次渲染完全一致）。
 */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由索引派生的稳定伪随机（无需保存生成器状态，适合逐元素抖动）。 */
export const jitter = (index: number, salt = 1): number => {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}
