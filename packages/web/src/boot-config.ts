/**
 * 前端独立配置文件（产物根 `gebai.config.js`，`index.html` / `files.html` 以普通 script 自动引入）——
 * 二次开发接入已有系统的扩展点：部署方在该文件里声明「环境变量预置」与「宿主 localStorage → 歌白设置」
 * 的映射，不必改动本包源码。配置经 `window.__GEBAI_WEB_CONFIG__` 暴露（对象，或返回对象的函数）。
 *
 * 应用时机：页面初始化最早期（`main.ts` / `files/main.ts` 的 init 首行），**先于**主题、低功耗、
 * 文件展示等读取 localStorage 的模块。优先级：URL 参数 > 用户本次手动选择 > localStorage 既有值 >
 * 配置文件 > 服务端全局注入 > 默认——即本模块**不覆盖用户已有选择**，只补齐尚未设置的键
 * （`force: true` 的规则例外，供部署方统一口径）。
 *
 * 配置形态（各字段均可选；未知字段忽略、类型不符的项丢弃、读取异常当作空配置）：
 * ```js
 * window.__GEBAI_WEB_CONFIG__ = {
 *   // ① 环境变量预置：随消息请求临时注入服务端（与设置面板同一通道，仅本浏览器生效、不落盘）
 *   env: { GEBAI_LLM_MODEL: "local-qwen" },
 *   // ② 环境变量 ← 宿主 localStorage 键（运行时读取，宿主系统的凭据可直接带进歌白环境变量）
 *   envFromStorage: { GEBAI_LLM_API_KEY: "myapp.llmKey" },
 *   // ③ 歌白设置键 ← 宿主素材：字符串=宿主 localStorage 键，或 { from } / { value } / { force }
 *   storage: {
 *     "gebai.ui.style": "myapp.theme",
 *     "gebai.ui.lowPower": { value: "on" },
 *     "gebai.ui.approvalSkip": { from: "myapp.approvalSkip", force: true },
 *   },
 *   // ④ 关闭外部链接携带提示词自动运行（URL 参数 gb_prompt，默认开启）
 *   allowUrlPrompt: false,
 * }
 * ```
 */

/** 配置挂载点（`gebai.config.js` 往 window 上写这个键）。 */
export const CONFIG_KEY = "__GEBAI_WEB_CONFIG__"

export interface WebConfigStorageRule {
  /** 宿主 localStorage 键：取其值写入歌白键。 */
  from?: string
  /** 字面值：直接写入歌白键。 */
  value?: string
  /** 覆盖已有值（默认只在歌白键未设置时写入）。 */
  force?: boolean
}

export interface WebConfig {
  env: Record<string, string>
  envFromStorage: Record<string, string>
  storage: Record<string, WebConfigStorageRule>
  allowUrlPrompt: boolean
}

type ConfigHost = Record<string, unknown>

interface StoreLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function emptyConfig(): WebConfig {
  return { env: {}, envFromStorage: {}, storage: {}, allowUrlPrompt: true }
}

/** 字符串映射项：键非空且值是非空字符串才保留（与设置面板「空值不保存」同口径）。 */
function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k.trim() || typeof v !== "string" || !v.trim()) continue
    out[k.trim()] = v.trim()
  }
  return out
}

/** storage 规则归一：字符串视为宿主键；对象取 from/value/force（两者皆空则丢弃）。 */
function storageMap(raw: unknown): Record<string, WebConfigStorageRule> {
  const out: Record<string, WebConfigStorageRule> = {}
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim()
    if (!key) continue
    if (typeof v === "string") {
      if (v.trim()) out[key] = { from: v.trim() }
      continue
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    const rule: WebConfigStorageRule = {}
    if (typeof o.from === "string" && o.from.trim()) rule.from = o.from.trim()
    if (typeof o.value === "string" && o.value.trim()) rule.value = o.value.trim()
    if (o.force === true) rule.force = true
    if (rule.from !== undefined || rule.value !== undefined) out[key] = rule
  }
  return out
}

/** 容错归一化：非对象/数组/缺字段一律回落默认（配置文件由部署方手改，不能因一处笔误让整页失效）。 */
export function normalizeWebConfig(raw: unknown): WebConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyConfig()
  const o = raw as Record<string, unknown>
  return {
    env: stringMap(o.env),
    envFromStorage: stringMap(o.envFromStorage),
    storage: storageMap(o.storage),
    // 只有显式 false 关闭（缺省/其它值均视为开启）
    allowUrlPrompt: o.allowUrlPrompt !== false,
  }
}

/** 读取页面上的配置（支持对象或返回对象的函数；读取或求值抛错时按空配置处理）。 */
export function readWebConfig(host: ConfigHost = window as unknown as ConfigHost): WebConfig {
  let raw: unknown
  try {
    raw = host[CONFIG_KEY]
    if (typeof raw === "function") raw = (raw as () => unknown)()
  } catch {
    return emptyConfig()
  }
  return normalizeWebConfig(raw)
}

/** 配置文件预置 + 宿主存储取到的环境变量（供 `loadLocalEnv` 打底，浏览器面板设置为准）。 */
export function configEnv(cfg: WebConfig, store: StoreLike): Record<string, string> {
  const out: Record<string, string> = { ...cfg.env }
  for (const [name, hostKey] of Object.entries(cfg.envFromStorage)) {
    try {
      const v = store.getItem(hostKey)
      if (v && v.trim()) out[name] = v.trim()
    } catch {
      /* 宿主存储不可用：跳过该项（其余照常合并） */
    }
  }
  return out
}

/** 便捷入口：按当前页面配置与浏览器存储取环境变量预置。 */
export function webConfigEnv(): Record<string, string> {
  try {
    return configEnv(readWebConfig(), localStorage)
  } catch {
    return {}
  }
}

/** 应用 storage 映射：只写尚未设置的歌白键（`force` 规则覆盖），返回实际写入的键名。 */
export function applyWebConfigStorage(cfg: WebConfig, store: StoreLike): string[] {
  const written: string[] = []
  for (const [key, rule] of Object.entries(cfg.storage)) {
    try {
      const value = rule.value ?? (rule.from ? store.getItem(rule.from) : null)
      if (value === null || value === undefined || !value.trim()) continue
      if (!rule.force && store.getItem(key) !== null) continue
      store.setItem(key, value)
      written.push(key)
    } catch {
      /* 存储不可用（隐私模式/配额满）：静默跳过，与主题/审批跳过等模块一致 */
    }
  }
  return written
}

/** 当前配置是否允许 URL 携带提示词自动运行（关闭时外部链接只打开页面，不自动建会话执行）。 */
let allowUrlPromptEnabled = true

/**
 * 页面启动最早期调用（幂等，两个页面入口各调一次）。
 * 返回实际写入的设置键与 URL 提示词开关状态，供调用方按需展示。
 */
export function applyWebConfig(opts: { host?: ConfigHost; store?: StoreLike } = {}): { written: string[]; allowUrlPrompt: boolean } {
  try {
    const store = opts.store ?? localStorage
    const cfg = readWebConfig(opts.host ?? (window as unknown as ConfigHost))
    allowUrlPromptEnabled = cfg.allowUrlPrompt
    return { written: applyWebConfigStorage(cfg, store), allowUrlPrompt: cfg.allowUrlPrompt }
  } catch {
    return { written: [], allowUrlPrompt: true }
  }
}

export function urlPromptAllowed(): boolean {
  return allowUrlPromptEnabled
}
