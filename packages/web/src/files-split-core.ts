/**
 * 分屏的**纯逻辑**（零 DOM、零副作用）：停靠侧解析、宽度夹取、拖分界时的宽度换算。
 *
 * 为什么单独一个文件：这几件事都是"算错了一眼看不出来"的量——换到左侧后拖分界拖反、
 * 夹取漏掉一边、持久化的脏值（老版本写入的其它字符串）导致布局诡异或刷新后突然开出一个分屏。
 * 它们藏在 DOM 事件里时只能靠肉眼看，抽成纯函数就能直接测（见 files-split-core.test.ts）。
 */

/** 分屏停靠侧：文件工作区停在窗口的哪一边（另一边给会话区）。 */
export type SplitSide = "left" | "right"

/**
 * 两个工作台的**同窗形态**（文件工作台与「会话工作台」的三种共存方式）：
 * - `off`   会话工作台独占整个窗口（缺省）；
 * - `split` 会话与文件**并列**（文件工作台停靠一侧，另一边留给会话）；
 * - `solo`  文件工作台**独占整个窗口**（会话工作台收起，DOM 与状态全留着，切回来是原样）。
 *
 * 会话侧入口主按钮 = `off ⇄ split`（窗口容不下分屏时退化为 `off ⇄ solo`），悬浮副按钮 = 「全屏文件工作台」；
 * 文件工作台侧（活动栏最下方）= 「关闭文件工作台」（恒回 `off`）+ 悬浮弹出的「进入分屏」（`solo → split`）。
 */
export type SplitMode = "off" | "split" | "solo"

/** 缺省停靠侧：文件工作区在**左**（会话区在右）。 */
export const SPLIT_DEFAULT_SIDE: SplitSide = "left"

/** 分屏面板最小宽度（窄于此 ID/编辑器就没意义，此时不如全屏打开）。 */
export const SPLIT_MIN_PANEL = 360
/** 会话区最小宽度（再窄就没法看消息了）。 */
export const SPLIT_MIN_MAIN = 420
/** 低于此窗口宽度不提供分屏（左右都挤成条），入口改为「全屏打开文件工作台」。 */
export const SPLIT_MIN_WINDOW = 1100

/**
 * 窗口宽度是否容得下分屏。低于下限时**入口换成「全屏打开」**——
 * 分屏在这个宽度下点下去只会把两侧都挤成条（见 files-split.ts 的 enterSplit），
 * 入口还写着"分屏打开"就是承诺一件做不到的事；而全屏形态与窗口宽度无关，任何宽度都成立。
 */
export function splitFitsWindow(windowWidth: number): boolean {
  return windowWidth >= SPLIT_MIN_WINDOW
}

/** 归一化停靠侧：只认 "left"/"right"，其余（含 localStorage 里的脏值）一律落回缺省。 */
export function normalizeSplitSide(raw: unknown): SplitSide {
  return raw === "left" || raw === "right" ? raw : SPLIT_DEFAULT_SIDE
}

/**
 * 归一化**上次的同窗形态**（刷新后照旧恢复）：
 * - `"split"` / `"solo"` 认；
 * - `"1"` 是旧版本的分屏记忆键值（那时只有开/关两态），当作 `split` 平移过来；
 * - 其余（null / 脏值）一律落回 `off`——刷新时多开一个重工作台比少开一个难收拾得多。
 */
export function normalizeSplitMode(raw: unknown): SplitMode {
  if (raw === "split" || raw === "solo") return raw
  if (raw === "1") return "split"
  return "off"
}

/** 把宽度夹进「面板不小于 SPLIT_MIN_PANEL、会话区不小于 SPLIT_MIN_MAIN」区间（窗口过窄时以面板下限为准）。 */
export function clampSplitWidth(w: number, windowWidth: number): number {
  const max = Math.max(SPLIT_MIN_PANEL, windowWidth - SPLIT_MIN_MAIN)
  return Math.round(Math.min(Math.max(w, SPLIT_MIN_PANEL), max))
}

/**
 * 拖分界时由指针位置算宽度。
 * 面板贴着窗口的哪一侧，就用「指针到那一侧边缘」的距离当宽度：
 * 右停靠 → 窗口宽 - 指针 x；左停靠 → 指针 x - 面板左缘（不是恒等于 x：窗口可能有偏移）。
 */
export function splitWidthFromPointer(clientX: number, panelLeft: number, windowWidth: number, side: SplitSide): number {
  return side === "right" ? windowWidth - clientX : clientX - panelLeft
}
