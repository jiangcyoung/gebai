/**
 * 主界面的「快捷键一览」弹窗：内容直接来自键位表（`keymap-main.ts`），
 * 与文件工作台「更多 → 快捷键」是同一份数据的两种呈现——不再各写一张会过期的键位表。
 */
import { el } from "./state"
import { helpGroups, popKeyScope, pushEscScope } from "./keymap"
import { mainKeymap } from "./keymap-main"

/** 打开一览弹窗（Esc / 遮罩 / 「知道了」关闭）。 */
export function showShortcutSheet(): void {
  const overlay = el("div", "preview-overlay")
  const card = el("div", "confirm-card kbd-sheet")
  card.append(el("div", "confirm-title", "快捷键"))
  const body = el("div", "kbd-sheet-body")
  for (const g of helpGroups(mainKeymap.bindings())) {
    body.append(el("div", "kbd-group-title", g.title))
    const list = el("div", "kbd-list")
    for (const r of g.rows) {
      const row = el("div", "kbd-row")
      row.append(el("kbd", undefined, r.keys.join(" / ")), el("span", undefined, r.note ? `${r.label}（${r.note}）` : r.label))
      // 接管了浏览器默认行为的键位标出来（如「接管 保存网页」），免得看着像普通键
      if (r.takesOver) row.append(el("span", "kbd-takeover", `接管 ${r.takesOver}`))
      list.append(row)
    }
    body.append(list)
  }
  card.append(body)
  const actions = el("div", "confirm-actions")
  const ok = el("button", "confirm-ok", "知道了")
  actions.append(ok)
  card.append(actions)
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  let scopeId = ""
  const close = () => {
    overlay.remove()
    popKeyScope(scopeId)
  }
  ok.onclick = close
  overlay.onclick = (e) => {
    if (e.target === overlay) close()
  }
  scopeId = pushEscScope("main.shortcutSheet", "关闭快捷键一览", close)
}

/** 绑定标题栏轮盘里的「快捷键」入口。 */
export function bindShortcutSheet(): void {
  const btn = document.getElementById("shortcuts-btn")
  if (!btn) return
  btn.addEventListener("click", () => showShortcutSheet())
}
