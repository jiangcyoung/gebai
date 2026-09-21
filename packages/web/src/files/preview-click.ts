/**
 * 资源管理器里「单击 = 预览、双击 = 固定」的**时序判定**（纯逻辑，无 DOM、可单测）。
 *
 * 为什么需要这一层：双击在浏览器里是一串 `click, click, dblclick`（实测还会把第二发 click 合并掉），
 * 而单击与双击的**第一发**在事件层完全一样——单看一个 click 分不出它是不是双击的开头。而“开预览”在
 * 标签层是个**就位替换**动作（唯一预览槽里的文件会被顶掉，见 `files/main.ts` 的 openFile）：立刻打开的话，
 * 双击一个文件会先顶掉上一个预览、再被钉住，用户看到的是“双击没反应 / 先前那个标签莫名没了”。
 *
 * 因此预览的打开**延后一个双击窗口**再落地：窗口内等到了 dblclick 就作废（改走固定），否则就是单击。
 * 这一层只管“什么时候该开、什么时候该作废”，真正的打开动作由调用方（explorer.ts）给。
 */

/** 计时器接口（生产用 window.setTimeout/clearTimeout，测试可注入假时钟）。 */
export interface PreviewClock {
  set(fn: () => void, ms: number): number
  clear(handle: number): void
}

/** 待定预览要打开的东西。 */
export interface PreviewTarget {
  /** `根|路径`（作废/去重按它比对） */
  key: string
  /** 标签层用的根 id */
  root: string
  /** 文件相对路径 */
  path: string
  /** 打开时用来判断“这一次单击是否还有效”（行可能已被重画），由调用方提供 */
  el?: unknown
}

export interface PreviewClickOptions {
  /** 打开**预览**标签（斜体、会被下一个预览顶掉） */
  openPreview: (t: PreviewTarget) => void
  /**
   * 打开**常驻**标签（双击）。
   * 调用方在这里要保证「只要这一个」语义：把预览槽里别的文件收掉（见 main.ts 的 openFile 的 only）。
   */
  openPinned: (t: PreviewTarget) => void
  /** 看这一行是否还有效（已从文档里摘掉的行不再开预览）；缺省视为一直有效 */
  isAlive?: (t: PreviewTarget) => boolean
  /**
   * 双击窗口（毫秒）。取 220：低于常见系统双击阈值（Windows 500 / macOS ~300），
   * 又比手速的两击间隔（60～150）宽裕——单击的观感延迟基本无感（选中态是点击即给的）。
   */
  delay?: number
  /** 时钟（缺省 window；单测注入假时钟） */
  clock?: PreviewClock
}

export interface PreviewClick {
  /** 单击（可能在窗口后被兑现成预览；窗口内又来一发就作废） */
  click(t: PreviewTarget): void
  /** 双击（作废待定预览，直接按常驻打开，只开一次） */
  dblclick(t: PreviewTarget): void
  /** 作废待定的预览（换根、外部打开别的文件等） */
  cancel(): void
  /** 当前是否有待定预览（调试/测试用） */
  pending(): string | null
}

const DEFAULT_DELAY = 220

export function createPreviewClick(opts: PreviewClickOptions): PreviewClick {
  const delay = opts.delay ?? DEFAULT_DELAY
  const clock: PreviewClock = opts.clock ?? {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (h) => window.clearTimeout(h),
  }
  let handle: number | null = null
  let pendingKey: string | null = null
  /** 待定项：key 与最新的 target（重复单击同一文件时用后来的那个，行元素可能已经换了） */
  let pendingTarget: PreviewTarget | null = null

  function clearPending(): void {
    if (handle !== null) clock.clear(handle)
    handle = null
    pendingKey = null
    pendingTarget = null
  }

  function click(t: PreviewTarget): void {
    // 同一文件连点（手抖）：只保留一个待定项，不叠加、也不重新计时
    if (pendingKey === t.key) {
      pendingTarget = t
      return
    }
    clearPending()
    pendingKey = t.key
    pendingTarget = t
    handle = clock.set(() => {
      const fire = pendingTarget
      clearPending()
      if (!fire) return
      if (opts.isAlive && !opts.isAlive(fire)) return
      opts.openPreview(fire)
    }, delay)
  }

  function dblclick(t: PreviewTarget): void {
    clearPending() // 单击那一发不落地（预览不开，连请求都不会发）
    opts.openPinned(t)
  }

  return {
    click,
    dblclick,
    cancel: clearPending,
    pending: () => pendingKey,
  }
}
