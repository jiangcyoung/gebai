/**
 * 冲突合并视图（三窗格）：左「我方（当前分支）」/ 中「合并结果（可编辑）」/ 右「对方」。
 *
 * 与 IDEA 的 Merge 工具对应：冲突块可逐个采纳（我方/对方/两者都留），也可整文件一键采纳一侧；
 * 结果窗格是可编辑的 Monaco——自动解决不满意的部分可以直接改，改完保存 + 标记为解决（git add）。
 * 解析与替换逻辑在 `merge.ts`（纯函数、已单测），本文件只负责渲染与交互。
 */
import { createEditor, type EditorHandle } from "./editor"
import type { FsApi } from "./api"
import { h, clear, icon, toast, confirmDialog } from "./ui"
import { applyResolution, blockSummary, parseConflictBlocks, type ConflictBlock, type Resolution } from "./merge"

export interface MergeHooks {
  api: FsApi
  /** 当前根 id */
  root: () => string
  /**
   * 仓库相对路径 → 打开/读写该文件所需的 `(根, 根内相对路径)`（可能换根：冲突文件可能在当前根之外）。
   * 返回 null = 定位不到（调用方给明确提示，不拿一条必然 404 的路径去写文件）。
   */
  resolvePath: (repoRel: string) => { root: string; rel: string } | null
  /** Monaco 语言 id */
  language: string
  /** 保存成功后刷新资源管理器/Git 装饰 */
  onSaved: (rootRel: string) => void
  /** 标记为已解决后刷新 Git 面板 */
  onResolved: () => void
}

export interface MergeSpec {
  /** 仓库相对路径（git 语义，冲突列表给出的就是它） */
  repoRel: string
}

export interface MergeView {
  el: HTMLElement
  refresh(): Promise<void>
  /** 保存合并结果（供工作台保存快捷键按活动标签分派调用）。 */
  save(): Promise<boolean>
  /** 跳到上一处（-1）/ 下一处（1）冲突块。 */
  gotoConflict(dir: 1 | -1): void
  /** 标记为已解决（git add）。 */
  markResolved(): Promise<void>
  dispose(): void
}

/** 三窗格里的一个只读侧栏（我方 / 对方 / 祖先）。 */
interface Pane {
  el: HTMLElement
  title: HTMLElement
  editor: EditorHandle
}

async function createPane(host: HTMLElement, opts: { label: string; value: string; language: string; accent?: string }): Promise<Pane> {
  const el = h("div", { class: "fw-merge-pane" })
  const head = h("div", { class: "fw-merge-pane-head" }, [
    h("span", { class: "fw-merge-pane-title", text: opts.label }),
    h("span", { class: "fw-merge-pane-meta", text: "" }),
  ])
  const editorHost = h("div", { class: "fw-merge-editor" })
  el.append(head, editorHost)
  if (opts.accent) el.style.setProperty("--merge-accent", opts.accent)
  host.appendChild(el)
  const editor = await createEditor(editorHost, { value: opts.value, language: opts.language, readOnly: true, minimap: false })
  return { el, title: head.querySelector(".fw-merge-pane-meta") as HTMLElement, editor }
}

export async function createMergeView(hooks: MergeHooks, spec: MergeSpec): Promise<MergeView> {
  /**
   * 冲突文件的落点（根 + 根内相对路径）：**每次用时重解析**，不在创建时定一次——
   * 合并期间用户可能在资源管理器里换根、或切到别的目录，缓存的根会写到错误的地方
   * （写文件是不可逆动作，宁可按当下状态重算）。
   */
  const locate = (): { root: string; rel: string } => hooks.resolvePath(spec.repoRel) ?? { root: hooks.root(), rel: "" }
  const name = spec.repoRel.split("/").pop() ?? spec.repoRel

  let result: EditorHandle | null = null
  let ours: Pane | null = null
  let theirs: Pane | null = null
  let blocks: ConflictBlock[] = []
  let cursor = 0
  let etag = ""
  let dirty = false

  const nameEl = h("span", { class: "fw-merge-name", text: name, title: spec.repoRel })
  const navLabel = h("span", { class: "fw-merge-nav-label", text: "—" })
  const baseBtn = h("button", { class: "fw-chip", title: "显示共同祖先（diff3 三段式文件的中间段）" }, [icon("file", 12), h("span", { text: "祖先版本" })])

  const bar = h("div", { class: "fw-merge-bar" })
  const panes = h("div", { class: "fw-merge-panes" })
  const el = h("div", { class: "fw-merge" }, [bar, panes])

  /** 重新解析结果文本并刷新导航/标记。 */
  function reparse(): void {
    blocks = parseConflictBlocks(result?.getValue() ?? "")
    if (cursor >= blocks.length) cursor = Math.max(0, blocks.length - 1)
    renderNav()
  }

  function renderNav(): void {
    const unresolved = blocks.length
    navLabel.textContent = unresolved ? `冲突 ${Math.min(cursor + 1, unresolved)}/${unresolved}${unresolved ? `　${blockSummary(blocks[cursor])}` : ""}` : "无冲突标记"
    navLabel.classList.toggle("ok", unresolved === 0)
    for (const b of [prevBtn, nextBtn, oursBtn, theirsBtn, bothBtn, allOursBtn, allTheirsBtn, allBothBtn]) b.disabled = unresolved === 0
    // 冲突计数：IDEA 在右上角同样把「共几处冲突」摆出来（否则只能靠翻页数）
    countEl.textContent = unresolved ? `${unresolved} 处冲突` : "无冲突"
    statusEl.textContent = dirty ? "已修改未保存" : "未修改"
    statusEl.classList.toggle("dirty", dirty)
    saveBtn.disabled = !dirty
    resolveBtn.disabled = unresolved > 0
    resolveBtn.title = unresolved > 0 ? "先把全部冲突标记处理完（采纳或手工编辑）" : "git add 该文件，结束冲突态"
  }

  /** 跳到指定冲突块（滚动 + 选中该块文本，便于直接改）。 */
  function gotoBlock(i: number): void {
    if (!blocks.length) return
    cursor = (i + blocks.length) % blocks.length
    const b = blocks[cursor]
    result?.revealLine(b.startLine)
    renderNav()
  }

  /** 采纳当前块（或全部）。 */
  function resolve(choice: Resolution, all: boolean): void {
    if (!result) return
    const text = result.getValue()
    const allBlocks = parseConflictBlocks(text)
    if (!allBlocks.length) {
      toast("没有待处理的冲突标记", "info")
      return
    }
    const target = all ? allBlocks : [allBlocks[Math.min(cursor, allBlocks.length - 1)]]
    result.setValue(applyResolution(text, target, choice))
    dirty = true
    // 保持游标位置感：解决当前块后停在原下标（后面的块会上移一位）
    if (!all) cursor = Math.min(cursor, parseConflictBlocks(result.getValue()).length - 1)
    reparse()
    gotoBlock(cursor)
  }

  async function save(): Promise<boolean> {
    if (!result) return false
    try {
      const target = locate()
      const res = await hooks.api.write(target.root, target.rel, { content: result.getValue(), expectedEtag: etag || undefined })
      etag = res.etag
      dirty = false
      hooks.onSaved(target.rel)
      const left = parseConflictBlocks(result.getValue()).length
      toast(left ? `已保存（仍有 ${left} 处冲突标记）` : "已保存，可标记为已解决", "success")
      reparse()
      return true
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes("409")) {
        toast("文件已被外部修改，请刷新后重试", "error", 6000)
      } else {
        toast(`保存失败：${msg}`, "error", 6000)
      }
      return false
    }
  }

  async function markResolved(): Promise<void> {
    try {
      if (dirty) {
        const ok = await save()
        if (!ok) return
      }
      await hooks.api.gitOp("stage", hooks.root(), { paths: [spec.repoRel] })
      toast("已标记为解决（已暂存）", "success")
      hooks.onResolved()
    } catch (err) {
      toast(`标记失败：${(err as Error).message}`, "error", 6000)
    }
  }

  const prevBtn = h("button", { class: "fw-btn", title: "上一个冲突（F8）" }, [icon("chevronUp", 12), h("span", { text: "上一个" })])
  const nextBtn = h("button", { class: "fw-btn", title: "下一个冲突（F9）" }, [icon("chevronDown", 12), h("span", { text: "下一个" })])
  const oursBtn = h("button", { class: "fw-btn primary", title: "采纳我方（当前分支）内容解决当前冲突" }, [h("span", { text: "采纳我方" })])
  const theirsBtn = h("button", { class: "fw-btn", title: "采纳对方（合入分支）内容解决当前冲突" }, [h("span", { text: "采纳对方" })])
  const bothBtn = h("button", { class: "fw-btn", title: "两侧内容都保留（我方在前）" }, [h("span", { text: "两者都留" })])
  const allOursBtn = h("button", { class: "fw-btn", title: "整文件采纳我方" }, [h("span", { text: "全部我方" })])
  const allTheirsBtn = h("button", { class: "fw-btn", title: "整文件采纳对方" }, [h("span", { text: "全部对方" })])
  // 两侧都留是「两边都对」时的最快路径（报错信息、并列的配置项……），逐个点太慢
  const allBothBtn = h("button", { class: "fw-btn", title: "每个冲突块都保留两侧内容（我方在前）" }, [h("span", { text: "全部两者" })])
  const saveBtn = h("button", { class: "fw-btn", title: "保存（Ctrl+Alt+S）" }, [icon("save", 12), h("span", { text: "保存" })])
  const resolveBtn = h("button", { class: "fw-btn primary", title: "git add 该文件，结束冲突态" }, [icon("check", 12), h("span", { text: "标记为解决" })])
  const statusEl = h("span", { class: "fw-merge-status", text: "未修改" })
  const countEl = h("span", { class: "fw-merge-count", text: "" })

  prevBtn.onclick = () => gotoBlock(cursor - 1)
  nextBtn.onclick = () => gotoBlock(cursor + 1)
  oursBtn.onclick = () => resolve("ours", false)
  theirsBtn.onclick = () => resolve("theirs", false)
  bothBtn.onclick = () => resolve("both", false)
  allOursBtn.onclick = async () => {
    const ok = await confirmDialog({ title: "全部采纳我方", message: `将「${name}」中所有冲突块替换为我方内容？`, okText: "全部采纳" })
    if (ok) resolve("ours", true)
  }
  allTheirsBtn.onclick = async () => {
    const ok = await confirmDialog({ title: "全部采纳对方", message: `将「${name}」中所有冲突块替换为对方内容？`, okText: "全部采纳" })
    if (ok) resolve("theirs", true)
  }
  allBothBtn.onclick = async () => {
    const ok = await confirmDialog({ title: "全部保留两者", message: `将「${name}」中所有冲突块替换为「我方 + 对方」两段内容？`, okText: "全部保留" })
    if (ok) resolve("both", true)
  }
  saveBtn.onclick = () => void save()
  resolveBtn.onclick = () => void markResolved()
  baseBtn.onclick = () => void toggleBase()

  bar.append(
    icon("merge", 14),
    nameEl,
    h("span", { class: "fw-merge-sep" }),
    prevBtn,
    nextBtn,
    navLabel,
    countEl,
    h("span", { class: "fw-grow" }),
    statusEl,
    oursBtn,
    theirsBtn,
    bothBtn,
    allOursBtn,
    allTheirsBtn,
    allBothBtn,
    baseBtn,
    saveBtn,
    resolveBtn,
  )

  /** 祖先版本（diff3 的 base 段）：默认折叠，需要时展开为第三窗格。 */
  let basePane: Pane | null = null
  async function toggleBase(): Promise<void> {
    if (basePane) {
      basePane.el.remove()
      basePane.editor.dispose()
      basePane = null
      return
    }
    const baseText = blocks.map((b) => b.base?.join("\n") ?? "").filter(Boolean).join("\n\n")
    if (!baseText) {
      toast("该冲突文件没有祖先段（非 diff3 风格，合并时未写入 base）", "info", 5000)
      return
    }
    basePane = await createPane(panes, { label: "共同祖先（base）", value: baseText, language: "plaintext" })
  }

  // 快捷键（F8/F9 跳冲突、保存、标记为解决）统一登记在工作台键位表里
  // （files/main.ts 的 wb.save / wb.mergePrev / wb.mergeNext / wb.markResolved），本视图只提供动作
  el.tabIndex = -1

  async function refresh(): Promise<void> {
    try {
      const res = await hooks.api.gitConflicts(hooks.root())
      const info = res.files.find((f) => f.path === spec.repoRel)
      if (!info) {
        // 冲突已解决（被外部处理）——提示并清空
        toast("该文件已不在冲突列表中", "warn", 4000)
        hooks.onResolved()
        return
      }
      ours?.editor.setValue(info.ours ?? "")
      theirs?.editor.setValue(info.theirs ?? "")
      if (ours) ours.title.textContent = info.ours === null ? "（该侧已删除）" : `${(info.ours ?? "").split("\n").length} 行`
      if (theirs) theirs.title.textContent = info.theirs === null ? "（该侧已删除）" : `${(info.theirs ?? "").split("\n").length} 行`
      const current = info.current ?? ""
      if (!result) {
        panes.replaceChildren()
        ours = await createPane(panes, { label: "我方（当前分支）", value: info.ours ?? "", language: hooks.language, accent: "var(--success)" })
        const mid = h("div", { class: "fw-merge-pane fw-merge-result" })
        const midHead = h("div", { class: "fw-merge-pane-head" }, [
          h("span", { class: "fw-merge-pane-title", text: "合并结果（可编辑）" }),
          h("span", { class: "fw-merge-pane-meta", text: "采纳后可直接改，再保存" }),
        ])
        const resultHost = h("div", { class: "fw-merge-editor" })
        mid.append(midHead, resultHost)
        panes.appendChild(mid)
        result = await createEditor(resultHost, { value: current, language: hooks.language, readOnly: false, minimap: false })
        result.onChange(() => {
          dirty = true
          renderNav()
        })
        theirs = await createPane(panes, { label: "对方（合入分支）", value: info.theirs ?? "", language: hooks.language, accent: "var(--tool)" })
      } else if (result.getValue() !== current && !dirty) {
        result.setValue(current)
      }
      // 保存所需的 etag（乐观锁：外部改动时保存会 409 而非静默覆盖）
      try {
        // stat 走数组签名（与列表/多文件共用），取本条目的 etag 供保存乐观锁
        const target = locate()
        const st = await hooks.api.stat(target.root, [target.rel])
        etag = st.items[0]?.etag ?? ""
      } catch {
        etag = ""
      }
      dirty = false
      reparse()
      gotoBlock(0)
      for (const e of [ours?.editor, theirs?.editor, result]) setTimeout(() => e?.layout(), 30)
    } catch (err) {
      clear(el)
      el.appendChild(h("div", { class: "fw-empty", text: `加载冲突信息失败：${(err as Error).message}` }))
    }
  }

  return {
    el,
    refresh,
    save,
    gotoConflict: (dir) => gotoBlock(cursor + dir),
    markResolved,
    dispose: () => {
      ours?.editor.dispose()
      theirs?.editor.dispose()
      basePane?.editor.dispose()
      result?.dispose()
    },
  }
}
