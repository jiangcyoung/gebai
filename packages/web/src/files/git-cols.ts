/**
 * Git 工具窗三栏的宽度数学（纯函数，可单测）。
 *
 * 为什么单独成模块：分支栏的宽度下限不是写死的数字，而是**量出来的**——工具条的按钮组随当前
 * tab 变（分支 / 标签 / 储存 / 远程）、也会增减按钮，写死的值在加按钮后静默失效（栏拖窄时按钮
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
 * 工具条（按钮组）的固有宽度 = 内边距 + 各项实测宽度 + 项间间隙。
 *
 * - `fixedWidths`：**全部可见子项**的实测宽度（按钮及其分组 + 状态文本「N 个标签 / N 条储存」）；
 * - `slots`：子项数（含间隔占位），间隙按它算。
 *
 * 为什么把状态文本也算进来（改过一次，这里记下原因）：文本确实可省略（`min-width: 0` + ellipsis），
 * 所以「下限只算按钮」看着更省宽度——但那正是现场看到的问题：标签 / 储存 / 远程三个 tab 的
 * 工具条被拖到下限时，「N 个标签」被省略成「N 个…」甚至只剩一个省略号，按钮与计数挤在一起像坏了。
 * 现在的口径是**下限 ≥ 内容宽度**：栏不宽到能装下整条工具条，就不允许把它拖到那个宽度。
 * 代价是这几个 tab 的栏不可能比工具条更窄——这正是「按钮栏最小宽度要大于内容」的诉求。
 */
export function toolbarMinWidth(o: { gap: number; paddingX: number; fixedWidths: number[]; slots: number }): number {
  const fixed = o.fixedWidths.reduce((n, w) => n + w, 0)
  const gaps = o.gap * Math.max(0, o.slots - 1)
  // +4px：+2px 取整余量（亚像素宽度与字体度量贴着算，某些缩放/字体下会差 1px 而裁掉控件边缘）
  //       +2px 呼吸位——「大于内容」而不是「恰好等于内容」，否则字体一换/一缩放就又贴到边
  return Math.max(COL_MIN_REFS_FLOOR, Math.ceil(o.paddingX + fixed + gaps + 4))
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
