/**
 * 文件工作台 · 三向暂存编辑器（HEAD ｜ 暂存结果（可编辑）｜ 工作区）。
 *
 * 与「逐块勾选」（partial.ts）解决同一件事的另一个入口，对应关系：
 * 勾选清单适合「我知道要哪几块」，三向编辑器适合「我要的是介于两者之间的第三份内容」——
 * 比如一行的某段字符、跨块的合并。中间栏就是**暂存区的实际内容**，改成什么样暂存区就是什么样。
 *
 * 只碰暂存区：写入走服务端 `stageContent`（hash-object + update-index），
 * 工作区与 HEAD 都不动，因此可以反复调、随时放弃。
 */
import type { FsApi } from "./api"
import { createEditor, type EditorHandle } from "./editor"
import { h, icon, toast } from "./ui"

export interface StageViewHooks {
  api: FsApi
  root: () => string
  /** 仓库相对路径 */
  repoRel: string
  language: string
  /** 写入暂存区成功后（刷新状态栏 / 变更面板 / 资源管理器装饰） */
  onStaged: () => void
}

export interface StageView {
  el: HTMLElement
  refresh: () => Promise<void>
  /** 保存暂存结果（供工作台保存快捷键按活动标签分派调用）。 */
  save: () => Promise<void>
  /** 是否有未写入暂存区的改动（离开确认用）。 */
  isDirty: () => boolean
  dispose: () => void
}

interface Pane {
  el: HTMLElement
  meta: HTMLElement
  editor: EditorHandle
}

/** 只读侧栏（HEAD / 工作区），带「用作暂存结果」按钮。 */
async function createSidePane(
  host: HTMLElement,
  opts: { label: string; value: string; language: string; accent: string; action: string; onAction: () => void },
): Promise<Pane> {
  const el = h("div", { class: "fw-stage-pane" })
  const meta = h("span", { class: "fw-merge-pane-meta", text: "" })
  const btn = h("button", { class: "fw-btn ghost sm", text: opts.action })
  btn.onclick = opts.onAction
  const head = h("div", { class: "fw-merge-pane-head" }, [
    h("span", { class: "fw-merge-pane-title", text: opts.label }),
    meta,
    h("span", { class: "fw-grow" }),
    btn,
  ])
  const editorHost = h("div", { class: "fw-merge-editor" })
  el.append(head, editorHost)
  el.style.setProperty("--merge-accent", opts.accent)
  host.appendChild(el)
  const editor = await createEditor(editorHost, { value: opts.value, language: opts.language, readOnly: true, minimap: false })
  return { el, meta, editor }
}

export async function createStageView(hooks: StageViewHooks): Promise<StageView> {
  const { api, repoRel } = hooks
  const name = repoRel.split("/").pop() ?? repoRel

  let head: Pane | null = null
  let work: Pane | null = null
  let result: EditorHandle | null = null
  let headText = ""
  let workText = ""
  let stagedText = ""
  let dirty = false
  let busy = false

  const statusEl = h("span", { class: "fw-merge-status", text: "—" })
  const saveBtn = h("button", { class: "fw-btn primary sm" }, [icon("check", 12), h("span", { text: "写入暂存区" })])
  const resetBtn = h("button", { class: "fw-btn sm", text: "还原" })
  const bar = h("div", { class: "fw-merge-bar" }, [
    h("span", { class: "fw-merge-name", text: name, title: repoRel }),
    h("span", { class: "fw-hint", text: "中间栏 = 暂存区内容（可编辑）" }),
    h("span", { class: "fw-grow" }),
    statusEl,
    resetBtn,
    saveBtn,
  ])
  const panes = h("div", { class: "fw-merge-panes" })
  const el = h("div", { class: "fw-merge fw-stage" }, [bar, panes])

  function renderStatus(): void {
    statusEl.textContent = dirty ? "已修改未写入" : "与暂存区一致"
    statusEl.classList.toggle("dirty", dirty)
    saveBtn.disabled = !dirty || busy
    resetBtn.disabled = !dirty || busy
  }

  async function save(): Promise<void> {
    if (!result || busy) return
    busy = true
    renderStatus()
    try {
      await api.gitStageContent(hooks.root(), repoRel, result.getValue())
      stagedText = result.getValue()
      dirty = false
      toast(`已写入暂存区：${name}`, "success")
      hooks.onStaged()
    } catch (err) {
      toast(`写入暂存区失败：${(err as Error).message}`, "error", 8000)
    } finally {
      busy = false
      renderStatus()
    }
  }

  async function refresh(): Promise<void> {
    const root = hooks.root()
    try {
      const [h, w, i] = await Promise.all([
        api.gitContent(root, "HEAD", repoRel).catch(() => null),
        api.gitContent(root, "WORKTREE", repoRel),
        api.gitContent(root, "INDEX", repoRel),
      ])
      headText = h && !h.missing && !h.tooLarge ? h.content : ""
      workText = w.missing || w.tooLarge ? "" : w.content
      stagedText = i.missing || i.tooLarge ? "" : i.content
    } catch (err) {
      panes.replaceChildren()
      panes.appendChild(h("div", { class: "fw-empty", text: `加载内容失败：${(err as Error).message}` }))
      return
    }

    if (!result) {
      head = await createSidePane(panes, {
        label: "HEAD（已提交）",
        value: headText,
        language: hooks.language,
        accent: "var(--success)",
        action: "用作暂存结果",
        onAction: () => {
          result?.setValue(headText)
          dirty = result?.getValue() !== stagedText
          renderStatus()
        },
      })
      const mid = h("div", { class: "fw-merge-pane fw-merge-result fw-stage-pane" })
      const midHead = h("div", { class: "fw-merge-pane-head" }, [
        h("span", { class: "fw-merge-pane-title", text: "暂存结果（可编辑）" }),
        h("span", { class: "fw-merge-pane-meta", text: "改完写入暂存区，工作区不受影响" }),
      ])
      const resultHost = h("div", { class: "fw-merge-editor" })
      mid.append(midHead, resultHost)
      panes.appendChild(mid)
      result = await createEditor(resultHost, { value: stagedText, language: hooks.language, readOnly: false, minimap: false })
      result.onChange(() => {
        dirty = result?.getValue() !== stagedText
        renderStatus()
      })
      work = await createSidePane(panes, {
        label: "工作区（未暂存）",
        value: workText,
        language: hooks.language,
        accent: "var(--tool)",
        action: "用作暂存结果",
        onAction: () => {
          result?.setValue(workText)
          dirty = result?.getValue() !== stagedText
          renderStatus()
        },
      })
    } else {
      // 外部（命令行 / 别的标签）改过暂存区：未被本地编辑过才跟随，否则会盖掉用户正在改的内容
      if (!dirty && result.getValue() !== stagedText) result.setValue(stagedText)
      head?.editor.setValue(headText)
      work?.editor.setValue(workText)
    }
    if (head) head.meta.textContent = headText ? `${headText.split("\n").length} 行` : "（无此版本）"
    if (work) work.meta.textContent = `${workText.split("\n").length} 行`
    renderStatus()
    for (const e of [head?.editor, work?.editor, result]) setTimeout(() => e?.layout(), 30)
  }

  saveBtn.onclick = () => void save()
  resetBtn.onclick = () => {
    result?.setValue(stagedText)
    dirty = false
    renderStatus()
  }
  el.tabIndex = -1
  renderStatus()

  return {
    el,
    refresh,
    save,
    isDirty: () => dirty,
    dispose: () => {
      head?.editor.dispose()
      work?.editor.dispose()
      result?.dispose()
    },
  }
}
