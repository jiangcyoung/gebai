/**
 * 文件工作台 · 逐块／逐行暂存（IDEA「分块提交」的等价物）。
 *
 * 为什么单独成模块：Monaco 的并列差异是**只读阅读器**，塞不进逐块控件；而「只提交这次改动的一部分」
 * 要的是一张**可勾选的清单**——每块一个复选框、每个改动行一个复选框，勾完按一个按钮。
 * 这里用结构化 hunks 直接渲染成清单，与服务端 `buildPartialPatch` 共用同一套行序约定
 * （`hunk.lines` 的下标就是提交给服务端的 `lines`）。
 *
 * 两个方向语义不同，故面板按 `side` 分支：
 * - `unstaged`：差异是「暂存区 → 工作区」，可**暂存**选中（写进 index、工作区不动）或**丢弃**选中；
 * - `staged`：差异是「HEAD → 暂存区」，只能**取消暂存**选中（退回工作区）。
 */
import type { FsApi, GitFileDiff, HunkSelectionInput } from "./api"
import { h, icon, toast, confirmDialog, clear } from "./ui"

export interface PartialPanelHandle {
  dispose: () => void
  refresh: () => Promise<void>
}

export interface PartialPanelOptions {
  root: string
  /** 仓库相对路径（与服务端 git 命令同一坐标系） */
  path: string
  side: "unstaged" | "staged"
}

export function createPartialPanel(
  host: HTMLElement,
  api: FsApi,
  opts: PartialPanelOptions,
  hooks: { onChanged: () => void; onOpenStage?: () => void },
): PartialPanelHandle {
  /** 选中项：hunk 下标 → 该块内被选中的改动行下标；不选中的块不出现在表里 */
  let selected = new Map<number, Set<number>>()
  let diff: GitFileDiff | null = null
  let loadError = ""
  let busy = false
  let disposed = false

  const unstaged = opts.side === "unstaged"
  const endpoints = unstaged ? { to: "WORKTREE" } : { to: "INDEX" }

  /** 改动行（+/-）在 `hunk.lines` 里的下标——上下文行不可勾选。 */
  const changeIdx = (lines: GitFileDiff["hunks"][number]["lines"]): number[] =>
    lines.map((l, i) => (l.type === "context" ? -1 : i)).filter((i) => i >= 0)

  const selections = (): HunkSelectionInput[] =>
    [...selected.entries()]
      .filter(([, set]) => set.size > 0)
      .map(([hunk, set]) => ({ hunk, lines: [...set].sort((a, b) => a - b) }))

  const totalSelected = (): number => [...selected.values()].reduce((n, s) => n + s.size, 0)

  async function load(): Promise<void> {
    loadError = ""
    try {
      diff = await api.gitFileDiff(opts.root, opts.path, endpoints)
    } catch (err) {
      diff = null
      loadError = (err as Error).message
    }
    if (disposed) return
    // 内容变了，旧的勾选下标不再成立——宁可让用户重选，也不拿旧下标去改错行
    selected = new Map()
    render()
  }

  async function run(kind: "stage" | "unstage" | "discard"): Promise<void> {
    const sel = selections()
    if (!sel.length) {
      toast("先勾选要处理的改动", "warn")
      return
    }
    if (busy) return
    const n = totalSelected()
    if (kind === "discard") {
      const ok = await confirmDialog({
        title: "丢弃选中的改动",
        message: `丢弃「${opts.path}」里选中的 ${n} 处改动？\n会自动创建 stash 备份，可从「暂存」栏恢复。`,
        okText: "丢弃",
        danger: true,
      })
      if (!ok) return
    }
    busy = true
    render()
    try {
      if (kind === "stage") {
        await api.gitStageHunks(opts.root, opts.path, sel)
        toast(`已暂存 ${n} 处改动`, "success")
      } else if (kind === "unstage") {
        await api.gitUnstageHunks(opts.root, opts.path, sel)
        toast(`已取消暂存 ${n} 处改动`, "success")
      } else {
        const res = await api.gitDiscardHunks(opts.root, opts.path, sel)
        toast(`已丢弃 ${n} 处改动`, "success")
        if (res.backupRef) toast(`已备份到 ${res.backupRef}`, "info", 6000)
      }
      hooks.onChanged()
    } catch (err) {
      toast(`${kind === "discard" ? "丢弃" : kind === "unstage" ? "取消暂存" : "暂存"}失败：${(err as Error).message}`, "error", 8000)
    } finally {
      busy = false
      await load()
    }
  }

  /** 勾选状态：块级复选框三态（全选 / 半选 / 未选）。 */
  function hunkBox(hunkIndex: number, lines: GitFileDiff["hunks"][number]["lines"]): HTMLInputElement {
    const idxs = changeIdx(lines)
    const set = selected.get(hunkIndex)
    const box = h("input", { type: "checkbox" }) as HTMLInputElement
    box.checked = !!set && idxs.every((i) => set.has(i))
    box.indeterminate = !!set && !box.checked && idxs.some((i) => set.has(i))
    box.disabled = busy
    box.onchange = () => {
      if (box.checked) selected.set(hunkIndex, new Set(idxs))
      else selected.delete(hunkIndex)
      render()
    }
    return box
  }

  function render(): void {
    clear(host)
    const shell = h("div", { class: "fw-partial" })

    const count = totalSelected()
    const bar = h("div", { class: "fw-partial-bar" }, [
      icon(unstaged ? "check" : "undo", 13),
      h("span", { class: "fw-partial-note", text: unstaged ? "勾选要暂存的改动（未勾选的留在工作区）" : "勾选要取消暂存的改动（退回工作区）" }),
      h("span", { class: "fw-grow" }),
      h("span", { class: "fw-hint", text: count ? `已选 ${count} 处` : "未选" }),
      (() => {
        const b = h("button", { class: "fw-btn sm", text: "全选" })
        b.disabled = busy || !diff?.hunks.length
        b.onclick = () => {
          diff?.hunks.forEach((hk, i) => selected.set(i, new Set(changeIdx(hk.lines))))
          render()
        }
        return b
      })(),
      (() => {
        const b = h("button", { class: "fw-btn sm", text: "清空" })
        b.disabled = busy || !count
        b.onclick = () => {
          selected = new Map()
          render()
        }
        return b
      })(),
      ...(hooks.onOpenStage
        ? [
            (() => {
              const b = h("button", { class: "fw-btn sm", title: "需要介于 HEAD 与工作区之间的内容时用它（中间栏就是暂存区）", text: "三向编辑器…" })
              b.disabled = busy
              b.onclick = () => hooks.onOpenStage?.()
              return b
            })(),
          ]
        : []),
      ...(unstaged
        ? [
            (() => {
              const b = h("button", { class: "fw-btn sm danger", text: "丢弃选中" })
              b.disabled = busy || !count
              b.onclick = () => void run("discard")
              return b
            })(),
            (() => {
              const b = h("button", { class: "fw-btn sm primary", text: "暂存选中" })
              b.disabled = busy || !count
              b.onclick = () => void run("stage")
              return b
            })(),
          ]
        : [
            (() => {
              const b = h("button", { class: "fw-btn sm primary", text: "取消暂存选中" })
              b.disabled = busy || !count
              b.onclick = () => void run("unstage")
              return b
            })(),
          ]),
    ])
    shell.appendChild(bar)

    if (loadError) {
      shell.appendChild(h("div", { class: "fw-empty", text: `读取差异失败：${loadError}` }))
      const retry = h("button", { class: "fw-btn sm", text: "重试" })
      retry.onclick = () => void load()
      shell.appendChild(h("div", { class: "fw-partial-retry" }, [retry]))
      host.appendChild(shell)
      return
    }
    if (!diff) {
      shell.appendChild(h("div", { class: "fw-loading", text: "正在读取差异…" }))
      host.appendChild(shell)
      return
    }
    if (diff.binary) {
      shell.appendChild(h("div", { class: "fw-empty", text: "二进制文件无法逐块处理，请整文件暂存／取消暂存" }))
      host.appendChild(shell)
      return
    }
    if (!diff.hunks.length) {
      shell.appendChild(
        h("div", { class: "fw-empty", text: unstaged ? "这个文件当前没有可逐块处理的改动" : "暂存区里没有这个文件的改动" }),
      )
      host.appendChild(shell)
      return
    }

    for (const [hunkIndex, hk] of diff.hunks.entries()) {
      const box = hunkBox(hunkIndex, hk.lines)
      const head = h("div", { class: "fw-partial-hunk-head" }, [
        box,
        h("span", { class: "fw-partial-hunk-range", text: hk.header.replace(/^@@\s*/, "@@ ") }),
        h("span", { class: "fw-grow" }),
        (() => {
          const b = h("button", { class: "fw-btn ghost sm", text: unstaged ? "暂存此块" : "取消暂存此块" })
          b.disabled = busy
          b.onclick = () => {
            selected.set(hunkIndex, new Set(changeIdx(hk.lines)))
            render()
            void run(unstaged ? "stage" : "unstage")
          }
          return b
        })(),
        ...(unstaged
          ? [
              (() => {
                const b = h("button", { class: "fw-btn ghost sm danger", text: "丢弃此块" })
                b.disabled = busy
                b.onclick = () => {
                  selected.set(hunkIndex, new Set(changeIdx(hk.lines)))
                  render()
                  void run("discard")
                }
                return b
              })(),
            ]
          : []),
      ])
      const body = h("div", { class: "fw-partial-hunk" })
      for (const [lineIndex, line] of hk.lines.entries()) {
        const selectable = line.type !== "context"
        const set = selected.get(hunkIndex)
        const lineBox = h("input", { type: "checkbox", class: "fw-partial-line-box" }) as HTMLInputElement
        lineBox.checked = !!set?.has(lineIndex)
        lineBox.disabled = busy || !selectable
        lineBox.onchange = () => {
          const cur = selected.get(hunkIndex) ?? new Set<number>()
          if (lineBox.checked) cur.add(lineIndex)
          else cur.delete(lineIndex)
          if (cur.size) selected.set(hunkIndex, cur)
          else selected.delete(hunkIndex)
          render()
        }
        body.appendChild(
          h("div", { class: `fw-hunk-line ${line.type}` }, [
            lineBox,
            h("span", { class: "fw-hunk-no", text: line.oldLine ? String(line.oldLine) : "" }),
            h("span", { class: "fw-hunk-no", text: line.newLine ? String(line.newLine) : "" }),
            h("span", { class: "fw-hunk-sign", text: line.type === "add" ? "+" : line.type === "del" ? "-" : " " }),
            h("span", { class: "fw-hunk-text", text: line.text }),
          ]),
        )
      }
      shell.appendChild(head)
      shell.appendChild(body)
    }
    host.appendChild(shell)
  }

  render()
  void load()
  return {
    dispose: () => {
      disposed = true
      clear(host)
    },
    refresh: load,
  }
}
