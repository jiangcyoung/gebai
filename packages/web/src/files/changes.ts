/**
 * 文件工作台 · 变更面板（左栏工具窗，与「资源管理器 / 搜索」互斥）。
 *
 * 为什么从底部 Git 工具窗里拆出来：IDEA 的「Commit」工具窗就在**左侧**，
 * 而"改了什么 / 提交"是编码时最频繁看的，放左侧随时可见；底部留给
 * 「分支 | 日志 | 提交内容」——那是**回顾历史**时才看的，两者节奏不同。
 *
 * 内容：头部一行（视野范围芯片 + 刷新）、按「冲突 / 已暂存 / 未暂存 / 未跟踪」分组的改动列表（行内 stage/unstage/
 * 丢弃/差异/历史），底部常驻提交框（消息 + 修补 + 提交 / 推送）——**提交框的动作全在一行**，
 * 选项在左、按钮在右；多步操作（merge/rebase/cherry-pick）进行中时顶部出现「继续 / 跳过 / 中止」条。
 *
 * 视野范围：root 可能只是仓库的子目录（典型：会话工作区在项目仓库内）——
 * 默认只看该子目录内的改动（IDEA 的 Commit 窗同理），可一键切整仓库。
 */
import type { GitChange, GitStatusInfo } from "./api"
import type { DiffSpec } from "./git"
import { confirmDialog, h, icon, showMenu, toast } from "./ui"
import { btnIcon, createOpRunner, operationAction, renderNotRepo, type GitOpHooks } from "./git-shared"
import { rowMinWidth } from "./panel-width"

export interface ChangesHooks extends GitOpHooks {
  /** 当前根在仓库内的相对前缀（root 指向仓库子目录时不为空） */
  repoPrefix: () => string
  /** 状态快照（由 main.ts 统一拉取，面板只读用） */
  status: () => GitStatusInfo | null
  /** 在主区域打开差异标签 */
  openDiff: (spec: DiffSpec) => void
  /** 打开文件（可定位行） */
  openFile: (root: string, path: string, line?: number) => void
  /** 打开比较标签 */
  openCompare: (init?: { from?: string; to?: string; path?: string; mergeBase?: boolean }) => void
  /** 打开冲突合并标签（三窗格） */
  openMerge: (repoRel: string) => void
  /** 打开三向暂存编辑器（HEAD ｜ 暂存结果 ｜ 工作区） */
  openStage: (repoRel: string) => void
  /** 是否可以写 */
  writable: () => boolean
  /** 远程操作是否可用 */
  remoteEnabled: () => boolean
  /** 文件系统变更后通知（树/状态栏刷新） */
  onFsChanged: () => void
  /** 打开某文件的 Git 历史（Git log --follow） */
  openFileHistory: (path: string) => void
  /** 在 Git 工具窗的日志栏按该文件过滤（宿主管工具窗的展开） */
  showInLog: (path: string) => void
  /** 改动总数变化（rail 上的「变更」按钮徽标） */
  onCount: (n: number) => void
  /**
   * 提交框动作行所需的最小宽度（左栏不得比它窄）。
   * 每次渲染提交框后按实测值回调，宿主据此定左栏下限（CSS 变量 + 拖动夹取）——
   * 宽度是**渲染后**才有的事实，而宿主看不见面板内部何时重渲染，所以由面板推、不靠宿主拉。
   */
  onMinWidth: (px: number) => void
}

export interface ChangesPanel {
  el: HTMLElement
  refresh: () => void
  dispose: () => void
}

export function createChangesPanel(hooks: ChangesHooks): ChangesPanel {
  let showWholeRepo = false
  let commitMessage = ""
  let commitAmend = false
  let committing = false
  /** 未完成的编辑历史（计划落在仓库里，面板只在值变化时重渲染，否则会自激循环）。 */
  let historyPlan: { branch: string; index: number; steps: unknown[] } | null = null
  let historyPlanLoading = false

  function resetHistoryPlan(): void {
    historyPlan = null
  }

  async function syncHistoryPlan(): Promise<void> {
    if (historyPlanLoading || !hooks.status()?.isRepo) return
    historyPlanLoading = true
    try {
      const res = await hooks.api.gitHistoryEditPlan(hooks.root())
      const next = res.plan ?? null
      const changed = JSON.stringify(next) !== JSON.stringify(historyPlan)
      historyPlan = next
      if (changed) render()
    } catch {
      // 读不到计划不影响主流程（例如刚切到非仓库根）
    } finally {
      historyPlanLoading = false
    }
  }

  /** 提交信息跨刷新保留（提交框每次重渲染，不保留会丢用户输入）。 */
  const el = h("div", { class: "fw-changes-panel" })
  const listHost = h("div", { class: "fw-changes-list" })
  const op = createOpRunner(hooks, async () => {
    render()
  })

  /* ------------------------------ 头部（一行控件） ------------------------------
   * 头部行高 34px（与资源管理器头部、编辑器标签栏同高：左栏首行与标签栏本是同一条横线），
   * 只放两件东西：**视野范围**（当前目录 / 整仓库，是本面板唯一的范围开关）与**刷新**。
   * 刷新是必需的：状态由宿主统一拉，但“我改完文件想立刻看结果”的预期落在面板自己的按钮上——
   * 它直接重取状态并重渲染（与 F5 同一条路），不依赖宿主的下一次刷新时机。
   * ---------------------------------------------------------------------------- */
  const scopeChip = h("button", { class: "fw-chip fw-scope-chip", hidden: true })
  scopeChip.onclick = () => {
    showWholeRepo = !showWholeRepo
    render()
  }
  const refreshBtn = h("button", { class: "fw-icon-btn sm", title: "刷新改动列表（F5）" })
  refreshBtn.appendChild(icon("refresh", 14))
  refreshBtn.onclick = () => void hooks.refreshStatus()
  const headHost = h("div", { class: "fw-changes-head" }, [scopeChip, h("span", { class: "fw-grow" }), refreshBtn])
  el.appendChild(headHost)

  /** 同步头部里的范围芯片（无前缀 = 根就是仓库根，没有“当前目录”这回事，芯片整块不显示）。 */
  function renderScopeChip(): void {
    const prefix = hooks.repoPrefix()
    scopeChip.hidden = !prefix
    if (!prefix) {
      scopeChip.replaceChildren()
      return
    }
    scopeChip.title = `当前限定：${prefix}（点击${showWholeRepo ? "仅看当前目录" : "看整仓库"}）`
    scopeChip.replaceChildren(
      icon(showWholeRepo ? "git" : "folder", 12),
      h("span", { text: showWholeRepo ? "整仓库" : `仅当前目录：${prefix.split("/").pop() ?? prefix}` }),
    )
  }

  /** 当前目录范围内的改动（root 为仓库子目录时；showWholeRepo 开启后为整仓库）。 */
  function scopedChanges(): { changes: GitChange[]; staged: number; unstaged: number; untracked: number; conflicted: number } {
    const s = hooks.status()
    const prefix = hooks.repoPrefix()
    const all = s?.changes ?? []
    const changes = prefix && !showWholeRepo ? all.filter((c) => c.path === prefix || c.path.startsWith(`${prefix}/`)) : all
    return {
      changes,
      staged: changes.filter((c) => c.staged).length,
      unstaged: changes.filter((c) => c.unstaged).length,
      untracked: changes.filter((c) => c.untracked).length,
      conflicted: changes.filter((c) => c.conflicted).length,
    }
  }

  /** Git 状态里的路径是仓库相对；转成当前根内的相对路径（root 可能指向仓库子目录）。 */
  function prefixPath(repoRel: string): string {
    const prefix = hooks.repoPrefix()
    return prefix && repoRel.startsWith(`${prefix}/`) ? repoRel.slice(prefix.length + 1) : repoRel === prefix ? "" : repoRel
  }

  /** 丢弃改动（服务端自动 stash 备份，可恢复）。 */
  async function discard(path: string): Promise<void> {
    const ok = await confirmDialog({
      title: "丢弃改动",
      message: `丢弃「${path}」的未暂存改动？\n会自动创建 stash 备份，可从「暂存」栏恢复。`,
      okText: "丢弃",
      danger: true,
    })
    if (!ok) return
    const res = await op("discard", { paths: [path] }, "已丢弃改动")
    if (res?.backupRef) toast(`已备份到 ${res.backupRef}`, "info", 6000)
    hooks.onFsChanged()
  }

  function changeRow(c: GitChange, group: "staged" | "unstaged" | "untracked" | "conflicted"): HTMLElement {
    const name = c.path.split("/").pop() ?? c.path
    const dir = c.path.slice(0, Math.max(0, c.path.length - name.length - 1))
    const mark = c.conflicted ? "!" : c.untracked ? "U" : c.kind === "added" ? "A" : c.kind === "deleted" ? "D" : c.kind === "renamed" ? "R" : c.staged && !c.unstaged ? "S" : "M"
    const row = h("div", { class: `fw-change-row${c.conflicted ? " conflict" : ""}`, title: c.path }, [
      h("span", { class: `fw-change-mark ${mark}`, text: mark }),
      h("span", { class: "fw-change-path" }, [
        dir ? h("span", { class: "fw-change-dir", text: `${dir}/` }) : null,
        h("span", { class: "fw-change-name", text: name }),
      ]),
      h("span", { class: "fw-grow" }),
      ...(group === "conflicted"
        ? [
            (() => {
              const b = btnIcon("git", "打开冲突解决（三窗格合并）", () => hooks.openMerge(c.path))
              b.classList.add("fw-hover-only")
              return b
            })(),
          ]
        : []),
      // 行内动作：hover 才显形（常态保持列表干净，IDEA 的改动列表同理）
      ...(group === "staged"
        ? [
            (() => {
              const b = btnIcon("undo", "取消暂存", () => void op("unstage", { paths: [c.path] }, undefined, { silent: true }))
              b.classList.add("fw-hover-only")
              return b
            })(),
          ]
        : [
            (() => {
              const b = btnIcon("check", "暂存", () => void op("stage", { paths: [c.path] }, undefined, { silent: true }))
              b.classList.add("fw-hover-only")
              return b
            })(),
            // 逐块暂存：只提交这次改动的一部分（IDEA 提交对话框的勾选清单）
            ...(c.untracked
              ? []
              : [
                  (() => {
                    const b = btnIcon("diff", "逐块暂存（勾选要提交的改动）", () => openPartial(c.path, "unstaged"))
                    b.classList.add("fw-hover-only")
                    return b
                  })(),
                ]),
          ]),
      ...(group !== "staged" && !c.untracked && !c.conflicted
        ? [
            (() => {
              const b = btnIcon("undo", "丢弃改动（自动 stash 备份）", () => void discard(c.path), "danger")
              b.classList.add("fw-hover-only")
              return b
            })(),
          ]
        : []),
    ])
    row.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button")) return
      // 单击开差异：变更列表的第一诉求是"我改了什么"
      if (c.untracked) hooks.openFile(hooks.root(), prefixPath(c.path))
      else
        hooks.openDiff({
          title: `${name}（${group === "staged" ? "已暂存" : "工作区"}）`,
          root: hooks.root(),
          path: c.path,
          source: { type: "worktree", staged: group === "staged" },
        })
    }
    row.ondblclick = () => {
      if (c.conflicted) hooks.openMerge(c.path)
      else if (c.untracked || c.kind === "added") hooks.openFile(hooks.root(), prefixPath(c.path))
    }
    row.oncontextmenu = (e) => {
      e.preventDefault()
      showMenu(e.clientX, e.clientY, [
        {
          label: c.untracked ? "打开文件" : "打开差异",
          icon: "diff",
          onClick: () => (c.untracked ? hooks.openFile(hooks.root(), prefixPath(c.path)) : row.click()),
        },
        ...(c.conflicted ? [{ label: "冲突解决（三窗格合并）", icon: "git", onClick: () => hooks.openMerge(c.path) }] : []),
        { separator: true },
        group === "staged"
          ? { label: "取消暂存", icon: "undo", onClick: () => void op("unstage", { paths: [c.path] }, undefined, { silent: true }) }
          : { label: "暂存", icon: "check", onClick: () => void op("stage", { paths: [c.path] }, undefined, { silent: true }) },
        ...(c.untracked || c.conflicted
          ? []
          : [
              {
                label: group === "staged" ? "逐块取消暂存…" : "逐块暂存…",
                icon: "diff",
                onClick: () => openPartial(c.path, group === "staged" ? "staged" : "unstaged"),
              },
              {
                label: "三向暂存编辑器…（HEAD ｜ 暂存结果 ｜ 工作区）",
                icon: "git",
                onClick: () => hooks.openStage(c.path),
              },
            ]),
        {
          label: "与 HEAD 比较",
          icon: "diff",
          onClick: () =>
            hooks.openDiff({
              title: `${name} ↔ HEAD`,
              root: hooks.root(),
              path: c.path,
              source: { type: "range", from: "HEAD", to: "WORKTREE" },
            }),
        },
        { label: "文件历史（Git log --follow）", icon: "history", onClick: () => hooks.openFileHistory(prefixPath(c.path)) },
        { label: "在日志栏中筛选该文件", icon: "history", onClick: () => hooks.showInLog(prefixPath(c.path)) },
        { label: "与任一提交比较…", icon: "sync", onClick: () => hooks.openCompare({ from: "HEAD", to: "WORKTREE" }) },
        { separator: true },
        { label: "复制路径", icon: "copy", onClick: () => void navigator.clipboard.writeText(c.path).then(() => toast("已复制路径", "success")) },
        { label: "在资源管理器中定位", icon: "folder", onClick: () => hooks.openFile(hooks.root(), prefixPath(c.path)) },
        ...(group !== "staged"
          ? [
              { separator: true },
              { label: "丢弃改动（自动 stash 备份）", icon: "undo", danger: true, disabled: c.untracked || c.conflicted, onClick: () => void discard(c.path) },
            ]
          : []),
      ])
    }
    return row
  }

  /** 逐块暂存：打开差异标签并直接进「逐块操作」态（Monaco 差异仍可切回）。 */
  function openPartial(path: string, side: "staged" | "unstaged"): void {
    const name = path.split("/").pop() ?? path
    hooks.openDiff({
      title: `${name}（逐块${side === "staged" ? "取消暂存" : "暂存"}）`,
      root: hooks.root(),
      path,
      source: { type: "worktree", staged: side === "staged" },
      partial: true,
    })
  }

  /** 最近的提交信息：写提交信息时最常用的参考（IDEA 提交框右侧的时钟按钮）。 */
  async function showMessageHistory(e: MouseEvent, area: HTMLTextAreaElement): Promise<void> {
    try {
      const res = await hooks.api.gitLog(hooks.root(), { limit: 30 })
      const items = [...new Set(res.commits.map((c) => c.subject).filter(Boolean))]
      if (!items.length) {
        toast("还没有可作为参考的提交信息", "info")
        return
      }
      showMenu(
        e.clientX,
        e.clientY,
        items.map((s) => ({
          label: s.length > 70 ? `${s.slice(0, 70)}…` : s,
          onClick: () => {
            area.value = s
            commitMessage = s
          },
        })),
      )
    } catch (err) {
      toast(`读取提交信息历史失败：${(err as Error).message}`, "error", 8000)
    }
  }

  function renderCommitBox(): HTMLElement {
    const area = h("textarea", { class: "fw-commit-msg", placeholder: "提交信息（Ctrl+Enter 提交）", rows: 3 })
    area.value = commitMessage
    area.oninput = () => {
      commitMessage = area.value
    }
    const stagedCount = scopedChanges().staged
    // 修补：栏窄（左栏 ~286px），文字缩到“修补”两字，完整语义与 --amend 写进 title
    const amendToggle = h("label", { class: "fw-check", title: "修补上次提交（git commit --amend）：不新建提交，改写 HEAD" }, [h("input", { type: "checkbox" })])
    ;(amendToggle.querySelector("input") as HTMLInputElement).checked = commitAmend
    ;(amendToggle.querySelector("input") as HTMLInputElement).onchange = (e) => {
      commitAmend = (e.target as HTMLInputElement).checked
    }
    amendToggle.append(h("span", { text: "修补" }))

    const doCommit = async (push: boolean) => {
      if (committing) return
      const msg = commitMessage.trim()
      if (!msg && !commitAmend) {
        toast("请填写提交信息", "error")
        return
      }
      committing = true
      commitBtn.setAttribute("disabled", "")
      try {
        const res = await hooks.api.gitOp<{ hash?: string; subject?: string }>("commit", hooks.root(), {
          message: msg,
          amend: commitAmend,
          push,
          setUpstream: push,
        })
        const pushRes = (res as { push?: { ok?: boolean; output?: string } }).push
        if (pushRes && pushRes.ok === false) {
          toast(`提交成功但推送失败：${pushRes.output?.slice(0, 300)}`, "error", 8000)
        } else {
          toast(push ? "已提交并推送" : "已提交", "success")
        }
        commitMessage = ""
        commitAmend = false
        await hooks.refreshStatus()
        render()
        hooks.onFsChanged()
      } catch (err) {
        toast(`提交失败：${(err as Error).message}`, "error", 8000)
      } finally {
        committing = false
        commitBtn.removeAttribute("disabled")
      }
    }

    const commitBtn = h("button", { class: "fw-btn primary", title: stagedCount ? `${stagedCount} 个文件已暂存` : "没有已暂存的变更（将提交工作区全部改动）" }, [
      icon("check"),
      h("span", { text: commitAmend ? "修补提交" : "提交" }),
    ])
    commitBtn.onclick = () => void doCommit(false)
    // 「推送」而非「提交并推送」：按钮组必须在**最窄左栏**（180px，内容宽 164）里完整排下——
    // “提交并推送”六字会把这一组撑到 185px，栏一拖窄主按钮就被顶出可视区（实测 286px 时就已经折行）。
    // 完整语义写进 title，图标与分支栏/远程栏的推送同一枚（upload）。
    const pushBtn = h("button", { class: "fw-btn", title: "提交并推送当前分支（未设置上游时自动发布）" }, [icon("upload"), h("span", { text: "推送" })])
    pushBtn.onclick = () => void doCommit(true)
    pushBtn.disabled = !hooks.remoteEnabled()

    area.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault()
        void doCommit(false)
      }
    }

    /* 一行到底：左 = 选项（修补 / 取历史信息），右 = 动作（推送 / 提交）
       ——两个按钮永远在同一行、靠右（`.fw-commit-btns` 是不可折的整体 + margin-left:auto）；
       栏宽不够时折在两组**之间**（正常不会发生：宿主把左栏下限定在**这一行的实测宽度**上，
       见下面的 reportMinWidth——两行只是字体/缩放异常时的兼底）。 */
    const opts = h("div", { class: "fw-commit-opts" }, [
      amendToggle,
      (() => {
        const b = h("button", { class: "fw-icon-btn", title: "最近的提交信息（点选即填入）" })
        b.appendChild(icon("history", 13))
        b.onclick = (e) => void showMessageHistory(e as MouseEvent, area)
        return b
      })(),
    ])
    const btns = h("div", { class: "fw-commit-btns" }, [pushBtn, commitBtn])
    const actions = h("div", { class: "fw-commit-actions" }, [opts, btns])
    const box = h("div", { class: "fw-commit-box" }, [area, actions])
    // 只记下待测的两个节点：此刻 box 还没进文档（调用方拿到后才会 replaceChildren），量出来是 0
    minWidthProbe = { box, actions }
    return box
  }

  /** 待测的一对节点（提交框与它的动作行）——上面那次 renderCommitBox 的产物。 */
  let minWidthProbe: { box: HTMLElement; actions: HTMLElement } | null = null

  /**
   * 把「提交框动作行要多宽」报给宿主（左栏下限）。
   *
   * 为什么不在 CSS 里用 `min-width: max-content` 之类代替：左栏宽度是**拖动设定**的，
   * CSS 下限只能阻止它变窄，不能把已有宽度顶回来；而且它还要参与拖动的夹取（不然拖到一半卡住），
   * 那一步在 JS 里。
   *
   * 量的是两个**不可折组**的自身宽度（它们 `flex: none`，量到的是“需要多宽”而非“被压成多宽”），
   * 加上间隙与容器内边距。必须在节点**进文档之后**量（否则是 0），面板隐藏（display: none）
   * 或未挂载时量不到——那就不报，保持宿主上一次的值。
   */
  function reportMinWidth(): void {
    const p = minWidthProbe
    if (!p || !p.box.isConnected) return
    if (!p.box.getBoundingClientRect().width) return
    const cs = getComputedStyle(p.box)
    const aCs = getComputedStyle(p.actions)
    hooks.onMinWidth(
      rowMinWidth({
        widths: [...p.actions.children].map((k) => k.getBoundingClientRect().width),
        gaps: parseFloat(aCs.columnGap) || 0,
        paddingX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
      }),
    )
  }

  /** 冲突/多步操作横幅（merge/rebase/cherry-pick 进行中）。 */
  function renderOperationBanner(s: GitStatusInfo): HTMLElement {
    return h("div", { class: "fw-git-banner warn" }, [
      icon("warning"),
      h("span", { text: `${s.operation} 进行中${s.counts.conflicted ? `（${s.counts.conflicted} 个冲突待解决）` : ""}` }),
      h("span", { class: "fw-grow" }),
      s.counts.conflicted
        ? (() => {
            const b = h("button", { class: "fw-btn sm", text: "打开冲突解决" })
            b.onclick = () => void openConflicts()
            return b
          })()
        : null,
      (() => {
        const b = h("button", { class: "fw-btn sm primary", text: "继续" })
        b.onclick = () => void op(operationAction(s.operation), {}, "已继续")
        return b
      })(),
      (() => {
        const b = h("button", { class: "fw-btn sm", text: "跳过" })
        b.disabled = s.operation !== "rebase"
        b.onclick = () => void op("rebase", { skip: true }, "已跳过")
        return b
      })(),
      (() => {
        const b = h("button", { class: "fw-btn sm danger", text: "中止" })
        b.onclick = () => void op(operationAction(s.operation), { abort: true }, "已中止")
        return b
      })(),
    ])
  }

  async function openConflicts(): Promise<void> {
    try {
      const res = await hooks.api.gitConflicts(hooks.root())
      if (!res.files.length) {
        toast("没有冲突文件", "info")
        return
      }
      const first = res.files[0]
      hooks.openMerge(first.path)
    } catch (err) {
      toast(`读取冲突失败：${(err as Error).message}`, "error")
    }
  }

  /** 未完成的「编辑历史」横幅（继续 / 中止）——状态里看不出来，故单独取一次计划。 */
  function renderHistoryBanner(): HTMLElement | null {
    const plan = historyPlan
    if (!plan) return null
    const box = h("div", { class: "fw-git-banner warn" }, [
      icon("history"),
      h("span", { text: `编辑历史进行中（${plan.branch}，已完成 ${plan.index}/${plan.steps.length} 条）` }),
      h("span", { class: "fw-grow" }),
    ])
    const cont = h("button", { class: "fw-btn sm primary", text: "继续" })
    cont.onclick = () =>
      void (async () => {
        try {
          const res = await hooks.api.gitHistoryEditContinue(hooks.root())
          if (res.halted === "conflict") toast(`仍有冲突未解决：${res.conflicts.join("、")}`, "error", 9000)
          else toast("历史已改写完成", "success")
        } catch (err) {
          toast(`继续失败：${(err as Error).message}`, "error", 9000)
        }
        resetHistoryPlan()
        hooks.refreshStatus()
        hooks.onFsChanged()
      })()
    const abort = h("button", { class: "fw-btn sm danger", text: "中止" })
    abort.onclick = () =>
      void (async () => {
        const ok = await confirmDialog({
          title: "中止编辑历史",
          message: `放弃本次改写，把「${plan.branch}」恢复到改写前？`,
          okText: "中止并恢复",
          danger: true,
        })
        if (!ok) return
        try {
          const res = await hooks.api.gitHistoryEditAbort(hooks.root())
          toast(`已恢复到 ${res.restored.slice(0, 8)}${res.backupBranch ? `（备份分支 ${res.backupBranch}）` : ""}`, "success", 6000)
        } catch (err) {
          toast(`中止失败：${(err as Error).message}`, "error", 9000)
        }
        resetHistoryPlan()
        hooks.refreshStatus()
        hooks.onFsChanged()
      })()
    box.append(cont, abort)
    return box
  }

  function render(): void {
    const s = hooks.status()
    const cnt = scopedChanges()
    const dirty = cnt.staged + cnt.unstaged + cnt.untracked + cnt.conflicted
    hooks.onCount(dirty)
    if (!s?.isRepo) {
      // 非仓库时头部只剩刷新（范围芯片说的是“仓库内的当前目录”，此时无意义）
      scopeChip.hidden = true
      listHost.replaceChildren(renderNotRepo(hooks, op))
      return
    }
    const scoped = cnt.changes
    const groups: Array<{ key: "conflicted" | "staged" | "unstaged" | "untracked"; label: string; items: GitChange[] }> = [
      { key: "conflicted", label: "冲突", items: scoped.filter((c) => c.conflicted) },
      { key: "staged", label: "已暂存", items: scoped.filter((c) => c.staged) },
      { key: "unstaged", label: "未暂存", items: scoped.filter((c) => c.unstaged && !c.conflicted) },
      { key: "untracked", label: "未跟踪", items: scoped.filter((c) => c.untracked) },
    ]
    const list = h("div", { class: "fw-git-list" })
    renderScopeChip()
    for (const g of groups) {
      if (!g.items.length) continue
      const groupEl = h("div", { class: "fw-change-group" })
      const head = h("div", { class: "fw-change-group-head" }, [
        icon("chevronDown", 12),
        h("span", { text: `${g.label}（${g.items.length}）` }),
        h("span", { class: "fw-grow" }),
        g.key !== "staged" && g.key !== "conflicted"
          ? btnIcon("check", "全部暂存", () => void op("stage", { paths: g.items.map((c) => c.path) }, "已全部暂存", { silent: true }))
          : null,
        g.key === "staged" ? btnIcon("undo", "全部取消暂存", () => void op("unstage", { paths: g.items.map((c) => c.path) }, undefined, { silent: true })) : null,
      ])
      const inner = h("div", { class: "fw-change-group-body" }, g.items.map((c) => changeRow(c, g.key)))
      head.onclick = (e) => {
        if ((e.target as HTMLElement).closest("button")) return
        inner.classList.toggle("collapsed")
      }
      groupEl.append(head, inner)
      list.appendChild(groupEl)
    }
    if (!s.changes.length) list.appendChild(h("div", { class: "fw-empty", text: "工作区干净，没有未提交的变更" }))
    if (s.operation) list.prepend(renderOperationBanner(s))
    const historyBanner = renderHistoryBanner()
    if (historyBanner) list.prepend(historyBanner)
    listHost.replaceChildren(list, renderCommitBox())
    // 量下限：必须等节点进文档之后（上一步刚 append），否则量出来是 0
    reportMinWidth()
    void syncHistoryPlan()
  }

  el.appendChild(listHost)
  // 字体/缩放变化会改动作行宽度（系统缩放、浏览器缩放）：重报一次下限
  window.addEventListener("resize", () => reportMinWidth())
  return { el, refresh: render, dispose: () => el.remove() }
}
