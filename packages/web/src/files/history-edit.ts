/**
 * 文件工作台 · 编辑历史对话框（IDEA 的「Rebasing Commits」）。
 *
 * 列表按 **新→旧** 展示（读起来与日志栏一致），但提交给服务端时翻成**应用顺序（旧→新）**——
 * 服务端按数组顺序逐条 cherry-pick，`squash/fixup` 合并的是「数组里它的前一条」。
 *
 * 每个动作的语义（与 git 一致）：
 * - `pick` 原样重放；`reword` 重放后改提交信息；
 * - `squash` 并入**上一条**（信息合并，可编辑）；`fixup` 并入上一条但丢弃自己的信息；
 * - `drop` 不重放（改动消失）；`edit` 重放到这条停下，让用户先改再继续。
 *
 * 服务端侧的实现细节（cherry-pick 重放、备份分支、冲突计划落盘）见 core/git/service.ts。
 */
import type { FsApi, GitCommitInfo } from "./api"
import { h, clear, icon, toast, formatTime } from "./ui"

export type HistoryAction = "pick" | "drop" | "reword" | "squash" | "fixup" | "edit"

interface Row {
  commit: GitCommitInfo
  action: HistoryAction
  /** reword / squash 用的提交信息（初始为原信息） */
  message: string
}

const ACTION_LABEL: Record<HistoryAction, string> = {
  pick: "保留",
  reword: "改信息",
  squash: "压合",
  fixup: "修补",
  drop: "丢弃",
  edit: "停下编辑",
}

const ACTION_HINT: Record<HistoryAction, string> = {
  pick: "原样重放这条提交",
  reword: "重放后改写提交信息",
  squash: "并入上一条（两条信息合并，可编辑）",
  fixup: "并入上一条但丢弃自己的信息",
  drop: "不重放这条提交（它的改动消失）",
  edit: "重放到这条停下，改完再继续",
}

export interface HistoryEditOptions {
  api: FsApi
  root: string
  /** 仓库相对基准（这条之后的提交才在列表里） */
  base: string
  /** 列表（新→旧；内部会翻成应用顺序提交） */
  commits: GitCommitInfo[]
  onDone: () => void
}

/** 打开编辑历史对话框；返回是否真的执行了改写。 */
export function openHistoryEditDialog(opts: HistoryEditOptions): Promise<boolean> {
  const { api, root, base, commits } = opts
  if (!commits.length) {
    toast("这条提交之后没有可编辑的提交", "warn")
    return Promise.resolve(false)
  }

  const rows: Row[] = commits.map((c) => ({ commit: c, action: "pick" as HistoryAction, message: c.subject }))
  let busy = false

  const listHost = h("div", { class: "fw-hist-list" })
  const status = h("span", { class: "fw-hint" })
  const startBtn = h("button", { class: "fw-btn primary", text: "开始改写" })
  const cancelBtn = h("button", { class: "fw-btn", text: "取消" })
  const warning = h("div", { class: "fw-hint-bar" }, [
    icon("warning", 13),
    h("span", { text: `将改写「${commits[0]!.short}」之后的 ${commits.length} 条提交（hash 会变）；改写前会自动建备份分支，冲突时可在横幅里继续或中止。` }),
  ])
  const dialog = h("div", { class: "fw-dialog fw-hist-dialog" }, [
    h("div", { class: "fw-dialog-title" }, [icon("git"), h("span", { text: "编辑历史（交互式变基）" })]),
    h("div", { class: "fw-dialog-body" }, [warning, listHost, status]),
    h("div", { class: "fw-dialog-actions" }, [cancelBtn, startBtn]),
  ])
  const overlay = h("div", { class: "fw-overlay" }, [dialog])

  /** 列表自上而下是新→旧，与日志一致；操作顺序相反（旧→新）才是重放顺序。 */
  function render(): void {
    clear(listHost)
    rows.forEach((row, i) => {
      const c = row.commit
      const moveUp = h("button", { class: "fw-icon-btn", title: "在历史中提前（更早应用）" })
      moveUp.appendChild(icon("chevronUp", 12))
      moveUp.disabled = busy || i === rows.length - 1
      moveUp.onclick = () => {
        const j = i + 1
        ;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
        render()
      }
      const moveDown = h("button", { class: "fw-icon-btn", title: "在历史中推后（更晚应用）" })
      moveDown.appendChild(icon("chevronDown", 12))
      moveDown.disabled = busy || i === 0
      moveDown.onclick = () => {
        const j = i - 1
        ;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
        render()
      }

      const actions = h("div", { class: "fw-hist-actions" })
      for (const a of ["pick", "reword", "squash", "fixup", "edit", "drop"] as HistoryAction[]) {
        // 列表最后一条（最老）没有「上一条」可并入
        if ((a === "squash" || a === "fixup") && i === rows.length - 1) continue
        const b = h("button", { class: `fw-chip${row.action === a ? " active" : ""}`, title: ACTION_HINT[a], text: ACTION_LABEL[a] })
        b.disabled = busy
        b.onclick = () => {
          row.action = a
          if ((a === "reword" || a === "squash") && !row.message) row.message = c.subject
          render()
        }
        actions.appendChild(b)
      }

      const item = h("div", { class: `fw-hist-row${row.action === "drop" ? " dropped" : ""}${row.action === "squash" || row.action === "fixup" ? " squashed" : ""}` }, [
        h("div", { class: "fw-hist-row-main" }, [
          h("span", { class: "fw-hist-hash", text: c.short }),
          h("span", { class: "fw-hist-subject", text: c.subject || "(无提交信息)", title: c.subject }),
          h("span", { class: "fw-grow" }),
          h("span", { class: "fw-hist-meta", text: `${c.author} · ${formatTime(c.commitTime)}` }),
          actions,
          h("div", { class: "fw-hist-order" }, [moveUp, moveDown]),
        ]),
      ])
      // 改写信息：就地可编辑（压合时按 IDEA 的做法默认把两条信息拼起来）
      if (row.action === "reword" || row.action === "squash") {
        const ta = h("textarea", { class: "fw-hist-msg", rows: 2, placeholder: "提交信息" })
        ta.value = row.message
        ta.disabled = busy
        ta.oninput = () => {
          row.message = ta.value
        }
        item.appendChild(ta)
      }
      listHost.appendChild(item)
    })
    const kept = rows.filter((r) => r.action !== "drop").length
    const summary = [
      `${kept} 条保留`,
      rows.some((r) => r.action === "squash") ? "含压合" : "",
      rows.some((r) => r.action === "fixup") ? "含修补" : "",
      rows.some((r) => r.action === "drop") ? `${rows.filter((r) => r.action === "drop").length} 条丢弃` : "",
      rows.some((r) => r.action === "edit") ? "会在编辑点停下" : "",
    ].filter(Boolean)
    status.textContent = `基准 ${base} ｜ ${summary.join(" · ")}`
    startBtn.disabled = busy || !rows.length
  }

  function close(result: boolean): void {
    overlay.remove()
    document.removeEventListener("keydown", onKey, true)
    if (result) opts.onDone()
    resolve(result)
  }

  async function start(): Promise<void> {
    if (busy) return
    busy = true
    startBtn.disabled = true
    status.textContent = "正在重放提交…"
    try {
      // 新→旧的界面顺序翻成应用顺序（旧→新）
      const steps = [...rows].reverse().map((r) => ({
        commit: r.commit.hash,
        action: r.action,
        message: r.action === "reword" || r.action === "squash" ? r.message : undefined,
      }))
      const res = await api.gitHistoryEdit(root, base, steps)
      if (res.halted === "conflict") {
        toast(`重放停在冲突（${res.conflicts.join("、")}）：解决后点横幅上的「继续」`, "error", 10000)
      } else if (res.halted === "edit") {
        toast("已停在指定提交：改完点横幅上的「继续」接着重放", "info", 10000)
      } else {
        toast(`历史已改写（${res.applied} 条）${res.backupBranch ? `，备份分支 ${res.backupBranch}` : ""}`, "success", 7000)
      }
      close(true)
    } catch (err) {
      status.textContent = `失败：${(err as Error).message}`
      toast(`编辑历史失败：${(err as Error).message}`, "error", 9000)
      busy = false
      startBtn.disabled = false
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !busy) close(false)
  }
  startBtn.onclick = () => void start()
  cancelBtn.onclick = () => close(false)
  overlay.onclick = (e) => {
    if (e.target === overlay && !busy) close(false)
  }
  document.addEventListener("keydown", onKey, true)

  let resolve!: (v: boolean) => void
  const promise = new Promise<boolean>((r) => {
    resolve = r
  })
  render()
  document.body.appendChild(overlay)
  return promise
}
