/**
 * 「显示隐藏文件」的**纯逻辑**（零 DOM、零副作用）：服务端配置的默认值只在用户手动切换前生效。
 *
 * 为什么单独一个文件：这个状态决定每次列举请求发给服务端的 `showHidden`（目录项由服务端按它过滤），
 * 算错不会报错——只表现成「树里看不到 .env / .git」，或者用户在菜单里关掉了、下一次「刷新根清单」
 * 又自己弹开。抽成纯函数即可直接测（见 hidden-core.test.ts）。
 */

export interface HiddenState {
  /** 是否列出隐藏文件（发给 `/fs/list` 的 `showHidden`）。 */
  on: boolean
  /** 用户是否手动切换过：此后服务端配置的默认值不再套用（「默认」只管首次）。 */
  picked: boolean
}

/** 初始状态：先不列隐藏文件；真实默认值在根清单到达后经 {@link withDefault} 套用。 */
export const HIDDEN_INITIAL: HiddenState = { on: false, picked: false }

/**
 * 套用服务端配置的默认值（`GEBAI_FS_HIDDEN`）。用户已手动切换过、或与当前值相同 → 返回**原对象**，
 * 调用方据引用相等即可跳过无谓的整树重取。
 */
export function withDefault(state: HiddenState, on: boolean): HiddenState {
  return state.picked || state.on === on ? state : { on, picked: false }
}

/** 用户手动切换（「更多」菜单）：此后服务端默认不再套用。 */
export function toggled(state: HiddenState): HiddenState {
  return { on: !state.on, picked: true }
}
