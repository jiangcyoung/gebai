/**
 * 时间线 —— 全片的唯一真相源：镜头窗口、文案、解说、音效钉帧都在这里。
 *
 * 组织约定：
 * - 镜头窗口用 `{ from, duration }` 表达，组件自己只关心"镜头内相对帧"（渲染在 `<Sequence>` 内）。
 * - 音效/解说都写**相对表达式**（`SHOTS.x.from + 偏移`），绝不在别处写死绝对帧号——
 *   时间线整体平移时全表自动跟随，不需要逐条重钉。
 * - 文案集中在 COPY：改词只改一处，镜头组件只负责排版与动效。
 * - 排期纪律：先划走 hold/rest 帧再排动效（品牌落定静止 ≥1s、批量收尾留 0.5s）。
 *   节奏偏好是单向的——观众只会说"太快了"。
 */
export const FPS = 30

export const SHOTS = {
  /** ① 品牌开场：准星 → 字标压印 → 副标 → tagline，落定后静止满 1s。 */
  open: { from: 0, duration: 150 },
  /** ② 能力全景：左侧主张 + 右侧元素网格（末尾点亮少数关键项）。 */
  grid: { from: 150, duration: 180 },
  /** ③ 机制说明：环形节点流程（连线先画、节点后落）+ 指标数字滚动。 */
  flow: { from: 330, duration: 230 },
  /** ④ 结语：元素合影围住字标（全片能量峰值，字标落定后静止 ≥1s）。 */
  outro: { from: 560, duration: 270 },
} as const

export const TOTAL = 830 // 27.7s @30fps —— 示例片时长；替换成正式内容后按分镜重排

/**
 * 示例文案。**这些是占位内容**：正式制作时应按目标产品的定位重写——
 * 标语要具体（带产品功能名与收益），抽象隐喻词一律具体化。
 */
export const COPY = {
  brand: "星轨",
  brandSub: "ORBIT STUDIO",
  kicker: "PRODUCT FILM",
  tagline: "把复杂，讲清楚。",

  gridKicker: "CAPABILITIES",
  gridTitle: "能力全景",
  gridBody: "四组能力、十二个模块，共用同一套视觉语言与操作习惯。",
  gridCount: "12",
  gridCountUnit: "MODULES",
  gridItems: [
    "巡检",
    "编排",
    "观测",
    "归档",
    "权限",
    "审计",
    "回滚",
    "扩缩",
    "调度",
    "通知",
    "报表",
    "集成",
  ],

  flowKicker: "HOW IT WORKS",
  flowTitle: "一条闭环",
  flowNodes: ["采集", "编排", "执行", "归档"],
  flowCenter: "闭环",
  flowMetrics: [
    { label: "自动化率", value: 92, suffix: "%" },
    { label: "节点规模", value: 240, suffix: "+" },
    { label: "平均恢复", value: 3, suffix: "s" },
  ],

  rosterItems: ["巡检", "编排", "观测", "归档", "权限", "审计", "回滚", "扩缩", "调度", "通知"],
  outroTagline: "把复杂，讲清楚。",
  outroFoot: "STORYBOARD · SHOT · CUT · MIX",
} as const

/**
 * 解说字幕（叙述型片子不留"哑巴段落"：超过 3 秒的无解说动画段落应补一条）。
 * 品牌开场与结语保持干净——这两处靠画面本身说话。
 */
export const CAPTIONS: Array<{ from: number; duration: number; text: string }> = [
  { from: SHOTS.grid.from + 26, duration: 92, text: "一套视觉语言，贯穿全部模块" },
  { from: SHOTS.flow.from + 30, duration: 96, text: "采集 → 编排 → 执行 → 归档，闭环自持" },
]

/**
 * 音效钉帧表（占位为空）。
 *
 * 用法：把音频素材放进 `public/audio/`，然后按下面的形状逐条登记——
 * `{ from: SHOTS.<鏡>.from + 偏移, src: "audio/xxx.mp3", volume: 0.4, note: "对应画面动作" }`。
 * 纪律：有辨识度的画面动作要配拟音（点击/打字/落位各配各的）；音量按素材实际峰值给，
 * 不要照抄区间；长样本（>5s）用 `durationInFrames` 截断到与动作等长；
 * 结尾固定句式 riser → impact → sparkle。若配了 BGM，终渲出带 BGM / 无 BGM 两版。
 */
export const SFX: Array<{ from: number; src: string; volume: number; durationInFrames?: number; note?: string }> = []

/** 默认播放窗：短样本（≤3s）统一给 90 帧；长样本请在表里显式给 durationInFrames。 */
export const sfxDuration = (s: { durationInFrames?: number }): number => s.durationInFrames ?? 90
