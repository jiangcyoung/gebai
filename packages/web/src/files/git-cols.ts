/**
 * Git 工具窗三栏的宽度数学（纯函数，可单测）。
 *
 * 为什么单独成模块：分支栏的宽度下限不是写死的数字，而是**量出来的**——工具条的按钮组随当前
 * tab 变（分支 / 标签 / 暂存 / 远程）、也会增减按钮，写死的值在加按钮后静默失效（栏拖窄时按钮
 * 被裁掉半个，看不出是设计如此还是坏了）。量那一步要 DOM，算这一步不该要：
 * 「数字算错只表现为界面怪」，只有纯函数能被单测钉住。
 */

/** 提交内容栏的最小宽度：要放得下变更文件名（与 files.css 的 min-width 同口径）。 */
export const COL_MIN_COMMIT = 240
/** 中间日志栏的最小宽度：空间不够时优先保住它，而不是让固定 px 的侧栏硬挤上去。 */
export const COL_MIN_LOG = 240
/** 分支栏的下限兜底：按钮组异常小的极端情况也不该让栏收到没法用。 */
export const COL_MIN_REFS_FLOOR = 120

/**
 * 工具条（按钮组）的固有宽度 = 内边距 + 固定项宽度 + 项间间隙。
 *
 * - `fixedWidths`：不许压缩的子项（按钮及其分组）的实测宽度；
 * - `slots`：**所有**子项数（含可压缩的状态文本与占位空白）——它们在极限状态下宽度为 0，
 *   但间隔仍在，故间隙按全部子项算。
 * 状态文本不计入是有意的：它可省略（`min-width: 0` + ellipsis），计入会把下限顶到远大于
 * 按钮组实际需要的宽度；固定项不计入则是错的（它们被压缩后的宽度不代表需要多宽）。
 */
export function toolbarMinWidth(o: { gap: number; paddingX: number; fixedWidths: number[]; slots: number }): number {
  const fixed = o.fixedWidths.reduce((n, w) => n + w, 0)
  const gaps = o.gap * Math.max(0, o.slots - 1)
  // +2px 取整余量：亚像素宽度与字体度量真贴着算，某些缩放/字体下会差 1px 裁掉按钮边缘
  return Math.max(COL_MIN_REFS_FLOOR, Math.ceil(o.paddingX + fixed + gaps + 2))
}

/**
 * 把某栏想给的宽度夹进可用范围：下限是该栏自己的最小宽度，上限是「总宽 − 另一侧栏下限 − 日志栏下限」
 * （两个固定 px 的侧栏不许把中间的日志栏挤没）。下限本身大于上限时取下限——三栏都留最小值仍放不下时，
 * 宁可整体横向溢出，也不让某一栏被压成一条缝。
 */
export function clampColWidth(o: { want: number; min: number; otherMin: number; total: number }): number {
  const max = Math.max(o.min, o.total - o.otherMin - COL_MIN_LOG)
  return Math.round(Math.max(o.min, Math.min(max, o.want)))
}
