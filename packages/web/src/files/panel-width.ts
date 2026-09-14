/**
 * 面板宽度数学（左栏 / 底部工具窗）——纯函数，可单测。
 *
 * 为什么值得单独一处：左栏的宽度下限不该是写死的数（它与**栏内控件**有关：提交框的动作行随
 * 界面文案与主题字体变化），而「算错」在界面上只表现为「按钮被裁掉半个 / 挤成两行」——
 * 不报错、不崩，只是难看且点不到。把算术拿出来，测量在调用方（DOM）做，
 * 这样「多宽算够」这件事可以被单测钉住。
 */

/** 左栏的下限兜底（按钮组异常小、或提交框还没渲染时的取值）。 */
export const LEFT_MIN_FLOOR = 180
/** 左栏上限：再宽编辑区就没地方了（拖动夹取用）。 */
export const LEFT_MAX = 560

/**
 * 一行控件的固有宽度 = 各项实测宽度之和 + 项间间隙 + 容器左右内边距 + 取整余量。
 *
 * `widths` 传**不可压缩项**的实测宽度（可省略项不计入——它本就能被压到 0，计入会把下限顶得虚高）；
 * `itemCount` 传该行的**全部项数**（含可省略项），因为间隙按项算、与被压缩的宽度无关。
 */
export function rowMinWidth(o: { widths: number[]; gaps: number; paddingX: number; itemCount?: number }): number {
  const sum = o.widths.reduce((n, w) => n + w, 0)
  const count = o.itemCount ?? o.widths.length
  const gaps = o.gaps * Math.max(0, count - 1)
  // +2px：亚像素宽度与字体度量贴着算，某些缩放/字体下会差 1px 而裁掉控件边缘
  return Math.ceil(o.paddingX + sum + gaps + 2)
}

/** 把宽度夹进 [min, max]（下限来自测量，可能与上限冲突时保下限）。 */
export function clampPanelWidth(o: { want: number; min: number; max?: number }): number {
  const max = Math.max(o.min, o.max ?? LEFT_MAX)
  return Math.round(Math.max(o.min, Math.min(max, o.want)))
}
