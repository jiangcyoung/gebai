/**
 * 标题栏最右的「按钮轮盘」入口：hover `#wheel-btn` 展开双弧扇形快捷菜单。
 *
 * 内弧 = 会话操作组（导出 / 压缩上下文 / 待办），外弧 = 应用操作组（自动审批 / 主题 / 设置 / 登出），
 * 两弧之间一条细弧线分区。半径与张角由 `wheel-core.ts` 按**项数与按钮尺寸自适应**（入参的 85/145 是首选值）：
 * 项一多就自动撑角度、再不够就加大半径，保证相邻按钮方块不叠（判定用方块的实际不重叠条件，不是圆心距）；
 * 几何与交互（hover 展开、离开保持区收起、外点 / Esc / resize 关闭）全在 `wheel-core.ts` 里实现——
 * 文件工作台编辑器右上角的动作轮盘用同一套，这里只负责点名。
 */
import { createWheel } from "./wheel-core"

export function bindWheel() {
  const wheelBtn = document.getElementById("wheel-btn") as HTMLButtonElement | null
  if (!wheelBtn) return
  const pick = (ids: string[]): HTMLButtonElement[] =>
    ids.map((id) => document.getElementById(id)).filter((b): b is HTMLButtonElement => !!b)
  const inner = pick(["export-btn", "compact-btn", "todo-btn"])
  const outer = pick(["approval-skip", "theme-btn", "shortcuts-btn", "settings-btn", "logout-btn"])
  createWheel({
    trigger: wheelBtn,
    items: [...inner.map((el) => ({ el, group: "inner" as const })), ...outer.map((el) => ({ el }))],
    innerRange: [93, 147],
    outerRange: [97, 153],
  })
}
