import { highlightCode, renderMarkdown } from "./md-core"
import { el } from "./state"
import { copyText } from "./ui"

// 渲染核心（markdown-it 规则 / 代码高亮 / DOMPurify 净化）在 md-core.ts —— 文件工作台的 markdown 预览共用同一套。
export { highlightCode, renderMarkdown, applyLinkTargetRule, applyTaskLists } from "./md-core"

/** 高亮代码元素（复用：代码块/文件预览/工具参数共用）。 */
export function highlightedCode(lang: string, code: string): HTMLElement {
  const codeEl = document.createElement("code")
  codeEl.innerHTML = highlightCode(lang, code)
  return codeEl
}

/** 代码块（语法高亮，不显示语言标签）。 */
export function codeBlock(lang: string, code: string): HTMLElement {
  const pre = el("pre")
  pre.className = "tool-code"
  pre.appendChild(highlightedCode(lang, code))
  return pre
}

export function blockText(text: string): HTMLElement {
  return el("div", "block-text", text)
}

export function markdownBlock(text: string): HTMLElement {
  const div = el("div", "markdown")
  div.innerHTML = renderMarkdown(text)
  enhanceCodeBlocks(div)
  return div
}

/** 代码块复制按钮（hover 显示）。 */
export function enhanceCodeBlocks(root: HTMLElement) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.querySelector(".copy-btn")) continue
    const btn = el("button", "copy-btn", "复制")
    btn.onclick = async () => {
      const code = pre.querySelector("code")?.textContent ?? ""
      try {
        await copyText(code)
        btn.textContent = "已复制"
        btn.classList.add("done")
        setTimeout(() => {
          btn.textContent = "复制"
          btn.classList.remove("done")
        }, 1600)
      } catch {
        /* 忽略 */
      }
    }
    pre.appendChild(btn)
  }
}
