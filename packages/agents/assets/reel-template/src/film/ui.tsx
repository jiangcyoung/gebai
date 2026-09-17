/**
 * 镜头原语 —— 全片共用的组件层（排版、光线、质感、面板、图元）。
 *
 * 用法约定：
 * - 组件默认按**当前序列的局部帧**计时（把镜头渲染在 `<Sequence>` 内，`useCurrentFrame()` 即从 0 起）；
 *   因此这里的 `delay` 一律写镜头内相对帧，镜头在时间线上平移时无需改动。
 * - 只暴露"语义参数"（文案、字号、强调色…），运动时值走 theme 的 token，不在调用处随手调曲线。
 * - 装饰性光效宁缺毋滥：一个镜头最多给主角一次高光（Glow 用作环境光时不占该名额）。
 */
import { interpolate, useCurrentFrame } from "remotion"
import type { CSSProperties, ReactNode } from "react"
import { C, EASE, F, T, clamp01, gridCss } from "./theme"

/* ────────────────────────────── 进度与运动工具 ────────────────────────────── */

/** 缓动进度：delay 起、dur 帧内按 ease 到 1（越界钳制）——所有入场动作的统一入口。 */
export const p = (frame: number, delay: number, dur: number, ease: (t: number) => number = EASE.out): number =>
  clamp01(ease(interpolate(frame, [delay, delay + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })))

/** 线性进度（颜色/亮度等不需要缓动的量）。 */
export const pl = (frame: number, delay: number, dur: number): number =>
  clamp01(interpolate(frame, [delay, delay + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))

/**
 * 批量元素入场进度：错峰 + 硬加速（越往后越密）——"越来越快"是批量入场的节奏感来源，
 * 匀速铺开读作 PPT。`i` 为元素序号，`count` 总数，`start`/`span` 为整批的时间窗。
 */
export const accel = (frame: number, i: number, count: number, start: number, span: number): number => {
  const t = interpolate(frame - start, [0, span], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const biased = Math.pow(t, 0.72)
  const slot = count <= 1 ? 0 : i / (count - 1)
  return clamp01(interpolate(biased, [slot * 0.82, Math.min(1, slot * 0.82 + 0.18)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))
}

/**
 * 跟随动作（follow-through）：把同一轨迹在 `frame − delay` 处采样即为"拖尾层"，
 * 每层给不同 delay 与幅度即成拖尾/影子层级。纯函数、无状态，逐帧可复现。
 */
export const lagged = <S,>(stateAt: (f: number) => S, frame: number, delay: number): S => stateAt(frame - delay)

/**
 * 阻尼振荡（落地回弹/收束尾音）：t 为自撞击起的帧数，返回衰减到 0 的有符号偏移系数，
 * 乘上目标振幅即得回弹位移。closed-form，无模拟状态。
 */
export const dampedSettle = (t: number, freq = 0.1, damping = 0.15): number =>
  t <= 0 ? 0 : Math.exp(-damping * t) * Math.sin(2 * Math.PI * freq * t)

/* ────────────────────────────── 时间窗容器 ────────────────────────────── */

/**
 * 时间窗：只在 `[start, start+span]` 内渲染 children，两端各 `fade` 帧淡入淡出——
 * 给"限时出现的注记"（某段动作期间才存在的标注框、光圈、辅助线）一个统一开关，
 * 免去每个镜头各写一套帧号分支。窗口按镜头局部帧计（与其余原语同一坐标系）。
 * `fade=0` 即硬切（不做插值）；fade 自动钳在窗口一半以内，避免淡入与淡出相撞。
 */
export const Show: React.FC<{
  start: number
  span: number
  children: ReactNode
  fade?: number
  delay?: number
}> = ({ start, span, children, fade = 6, delay = 0 }) => {
  const frame = useCurrentFrame() - delay
  if (frame < start || frame > start + span) return null
  const f = Math.max(0, Math.min(fade, span / 2))
  const opacity = f <= 0 ? 1 : Math.min(pl(frame, start, f), 1 - pl(frame, start + span - f, f))
  return <div style={{ position: "absolute", inset: 0, opacity, pointerEvents: "none" }}>{children}</div>
}

/* ────────────────────────────── 底版 · 光线 · 质感 ────────────────────────────── */

/** 环境光斑（呼吸）：用于给暗场一点"活气"，不占"主角高光"名额。 */
export const Glow: React.FC<{
  x: number
  y: number
  r: number
  color: string
  opacity: number
  delay?: number
  breathe?: number
  blur?: number
}> = ({ x, y, r, color, opacity, delay = 0, breathe = 90, blur = 28 }) => {
  const frame = useCurrentFrame()
  const on = p(frame, delay, T.big)
  const pulse = 1 + 0.04 * Math.sin((frame / breathe) * Math.PI * 2)
  return (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${color} 0%, transparent 68%)`,
        opacity: opacity * on,
        transform: `scale(${pulse})`,
        filter: `blur(${blur}px)`,
        pointerEvents: "none",
      }}
    />
  )
}

/** 扫描线质感（确定性：位移由帧号驱动，不用随机）——给纯色画面一点"屏"的味道。 */
export const Grain: React.FC<{ opacity?: number; lineHeight?: number }> = ({ opacity = 0.05, lineHeight = 3 }) => {
  const frame = useCurrentFrame()
  const shift = (frame * 1.7) % 4
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        opacity,
        backgroundImage: "repeating-linear-gradient(to bottom, rgba(255,255,255,0.5) 0 1px, transparent 1px 3px)",
        backgroundSize: `100% ${lineHeight + 1}px`,
        backgroundPosition: `0 ${shift}px`,
        mixBlendMode: "overlay",
      }}
    />
  )
}

/** 暗场底版：底色 + 可选网格 + 环境光 + 暗角。镜头内容作为 children 叠在其上。 */
export const Backplate: React.FC<{
  grid?: number
  glows?: Array<{ x: number; y: number; r: number; color: string; opacity: number; delay?: number }>
  vignette?: number
  bg?: string
  children?: ReactNode
}> = ({ grid, glows = [], vignette = 0.55, bg = C.bg, children }) => (
  <div style={{ position: "absolute", inset: 0, backgroundColor: bg, overflow: "hidden" }}>
    {grid ? <div style={{ position: "absolute", inset: 0, backgroundImage: gridCss(grid, "rgba(255,255,255,0.028)") }} /> : null}
    {glows.map((g, i) => (
      <Glow key={i} {...g} />
    ))}
    {children}
    {vignette > 0 ? (
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 46%, transparent 42%, rgba(0,0,0,${vignette}) 100%)`,
          pointerEvents: "none",
        }}
      />
    ) : null}
  </div>
)

/* ────────────────────────────── 排版层 ────────────────────────────── */

/** 拉丁小标（眉题）：宽字距全大写，用于给段落定调。 */
export const Kicker: React.FC<{ text: string; delay?: number; color?: string; size?: number; align?: "left" | "center" }> = ({
  text,
  delay = 0,
  color = C.accent,
  size = 15,
  align = "center",
}) => {
  const frame = useCurrentFrame()
  const on = p(frame, delay, T.small)
  return (
    <div
      style={{
        fontFamily: F.sans,
        fontSize: size,
        letterSpacing: "0.42em",
        textTransform: "uppercase",
        color,
        opacity: on * 0.92,
        transform: `translateY(${(1 - on) * 8}px)`,
        textAlign: align,
        whiteSpace: "pre",
      }}
    >
      {text}
    </div>
  )
}

/** 细线生长（分隔/收束用）。 */
export const Rule: React.FC<{
  width: number
  delay?: number
  color?: string
  thickness?: number
  duration?: number
  from?: "left" | "center"
}> = ({ width, delay = 0, color = C.lineStrong, thickness = 1, duration = T.mid, from = "center" }) => {
  const frame = useCurrentFrame()
  const on = p(frame, delay, duration)
  return (
    <div
      style={{
        width: width * on,
        height: thickness,
        backgroundColor: color,
        alignSelf: from === "center" ? "center" : "flex-start",
        marginLeft: from === "left" ? 0 : undefined,
      }}
    />
  )
}

/**
 * 大标题：逐字浮现（字距收紧 + 轻微上浮 + 模糊收敛）。
 * 语言无关——中文走衬线更沉稳，英文/代码标识走 `font` 显式指定等宽。
 */
export const Headline: React.FC<{
  text: string
  size?: number
  delay?: number
  perChar?: number
  color?: string
  font?: string
  weight?: number
  tracking?: string
  lineHeight?: number
  align?: "left" | "center"
}> = ({ text, size = 76, delay = 0, perChar = 4, color = C.text, font = F.serif, weight = 600, tracking = "0.06em", lineHeight = 1.35, align = "center" }) => {
  const frame = useCurrentFrame()
  const chars = Array.from(text)
  return (
    <div
      style={{
        fontFamily: font,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: tracking,
        lineHeight,
        color,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
      }}
    >
      {chars.map((ch, i) => {
        const on = p(frame, delay + i * perChar, T.mid)
        return (
          <span
            key={i}
            style={{
              opacity: on,
              transform: `translateY(${(1 - on) * size * 0.16}px)`,
              filter: on < 1 ? `blur(${(1 - on) * 5}px)` : undefined,
              whiteSpace: "pre",
            }}
          >
            {ch}
          </span>
        )
      })}
    </div>
  )
}

/**
 * 品牌字标（正片开场与结语的关键记忆点）：主标压印 + 副标淡入。
 * **落定后必须静止 ≥1s**（R1）——本组件只负责"落定"，hold 由调用方排进时间线。
 */
export const Wordmark: React.FC<{
  text: string
  sub?: string
  size?: number
  delay?: number
  color?: string
  glow?: number
  font?: string
}> = ({ text, sub, size = 132, delay = 0, color = C.text, glow = 0.5, font = F.serif }) => {
  const frame = useCurrentFrame()
  const on = p(frame, delay, T.mid)
  const settle = p(frame, delay + 6, T.big)
  const subOn = p(frame, delay + T.mid, T.small)
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size * 0.16 }}>
      <div
        style={{
          fontFamily: font,
          fontSize: size,
          fontWeight: 700,
          letterSpacing: "0.22em",
          color,
          opacity: on,
          transform: `scale(${1.05 - settle * 0.05})`,
          filter: on < 1 ? `blur(${(1 - on) * 6}px)` : undefined,
          textShadow: glow > 0 ? `0 0 ${40 * settle}px ${C.accent}${Math.round(glow * settle * 255).toString(16).padStart(2, "0")}` : undefined,
        }}
      >
        {text}
      </div>
      {sub ? (
        <div style={{ fontFamily: F.sans, fontSize: size * 0.1, letterSpacing: "0.5em", color: C.textDim, opacity: subOn * 0.9 }}>{sub}</div>
      ) : null}
    </div>
  )
}

/** 底部解说条（叙述型片子不留"哑巴段落"：超过 3s 的无解说动画段落应补一条）。 */
export const Caption: React.FC<{ text: string; duration: number; accent?: string; left?: number; bottom?: number; size?: number }> = ({
  text,
  duration,
  accent = C.accent,
  left = 120,
  bottom = 92,
  size = 25,
}) => {
  const frame = useCurrentFrame()
  const inn = p(frame, 4, T.small)
  const out = interpolate(frame, [duration - 14, duration - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <div
      style={{
        position: "absolute",
        left,
        bottom,
        display: "flex",
        alignItems: "center",
        gap: 18,
        opacity: inn * out,
        transform: `translateY(${(1 - inn) * 14}px)`,
      }}
    >
      <div style={{ width: 3, height: size * 1.05, backgroundColor: accent, opacity: 0.9 }} />
      <div style={{ fontFamily: F.sans, fontSize: size, letterSpacing: "0.16em", color: C.text, opacity: 0.94 }}>{text}</div>
    </div>
  )
}

/**
 * 底部居中整句字幕（配音字幕）：窗口由 `voice.generated.ts` 给（reel_voice 生成），帧号与配音音频同源——
 * 字幕不会比声音早到或晚走。进入/退出各取一个微时值，长句停得住、短句不拖尾。
 *
 * 与 Caption 的分工：Caption 是左侧带竖条的画内解说条（无配音的段落用它），Subtitle 是配音的口播字幕；
 * 同一句话不要两处都写。
 */
export const Subtitle: React.FC<{ text: string; duration: number; bottom?: number; size?: number; maxWidth?: number }> = ({
  text,
  duration,
  bottom = 76,
  size = 34,
  maxWidth = 1240,
}) => {
  const frame = useCurrentFrame()
  const inn = p(frame, 2, T.micro)
  const fade = Math.min(T.micro, Math.max(2, Math.floor(duration / 3)))
  const out = interpolate(frame, [duration - fade, duration], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom, display: "flex", justifyContent: "center", opacity: inn * out }}>
      <div
        style={{
          maxWidth,
          padding: `${size * 0.26}px ${size * 0.8}px ${size * 0.32}px`,
          backgroundColor: "rgba(8,10,14,0.68)",
          borderBottom: `2px solid ${C.accent}`,
          borderRadius: 4,
          transform: `translateY(${(1 - inn) * 10}px)`,
          fontFamily: F.sans,
          fontSize: size,
          lineHeight: 1.35,
          letterSpacing: "0.06em",
          color: C.text,
          textAlign: "center",
        }}
      >
        {text}
      </div>
    </div>
  )
}

/** 等宽文本块（命令 / 路径 / 代码 / 指标清单）：逐行浮现，可高亮若干行。 */
export const Mono: React.FC<{
  lines: string[]
  delay?: number
  lineDelay?: number
  size?: number
  color?: string
  highlight?: number[]
  highlightColor?: string
  align?: "left" | "center"
}> = ({ lines, delay = 0, lineDelay = 6, size = 28, color = C.textDim, highlight = [], highlightColor = C.accent, align = "left" }) => {
  const frame = useCurrentFrame()
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: size * 0.55, alignItems: align === "center" ? "center" : "flex-start" }}>
      {lines.map((line, i) => {
        const on = p(frame, delay + i * lineDelay, T.small)
        const hot = highlight.includes(i)
        return (
          <div
            key={i}
            style={{
              fontFamily: F.mono,
              fontSize: size,
              color: hot ? highlightColor : color,
              opacity: on,
              transform: `translateX(${(1 - on) * -12}px)`,
              whiteSpace: "pre",
            }}
          >
            {line}
          </div>
        )
      })}
    </div>
  )
}

/** 玻璃面板（承载一组信息时用它统一材质，别让每个元素各带一套圆角/描边）。 */
export const Panel: React.FC<{ children?: ReactNode; style?: CSSProperties; pad?: number; glow?: string; radius?: number }> = ({
  children,
  style,
  pad = 28,
  glow,
  radius = 16,
}) => (
  <div
    style={{
      background: C.surface,
      border: `1px solid ${C.line}`,
      borderRadius: radius,
      padding: pad,
      backdropFilter: "blur(14px)",
      boxShadow: glow ? `0 0 60px -10px ${glow}` : undefined,
      ...style,
    }}
  >
    {children}
  </div>
)

/* ────────────────────────────── 镜头图元 ────────────────────────────── */

/**
 * 准星（十字描线）。用于"定位/瞄准"语气的开场或强调：
 * 先横后纵描线，落位后压暗为基准线，可视为后续内容的坐标系。
 */
export const Crosshair: React.FC<{ w?: number; h?: number; delay?: number; color?: string; dim?: number }> = ({
  w = 700,
  h = 320,
  delay = 0,
  color = C.accent,
  dim = 0.66,
}) => {
  const frame = useCurrentFrame()
  const hx = p(frame, delay, T.mid)
  const vx = p(frame, delay + 10, T.mid + 4)
  const faded = 1 - p(frame, delay + T.big, T.mid) * dim
  const line = (extra: CSSProperties): CSSProperties => ({ position: "absolute", backgroundColor: "rgba(255,255,255,0.34)", opacity: faded, ...extra })
  const tick = (extra: CSSProperties): CSSProperties => ({ position: "absolute", backgroundColor: color, opacity: faded * 0.9, ...extra })
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={line({ width: w * hx, height: 1 })} />
      <div style={line({ width: 1, height: h * vx })} />
      <div style={tick({ width: 1, height: 12, transform: `translateX(${(-w / 2) * hx}px)` })} />
      <div style={tick({ width: 1, height: 12, transform: `translateX(${(w / 2) * hx}px)` })} />
      <div style={tick({ width: 12, height: 1, transform: `translateY(${(-h / 2) * vx}px)` })} />
      <div style={tick({ width: 12, height: 1, transform: `translateY(${(h / 2) * vx}px)` })} />
    </div>
  )
}

/**
 * 元素网格：把一列标签/图标/字段按栅格铺满，批量错峰入场（越后越密），
 * 可选"停一拍后点亮其中若干"（把注意力交给少数关键项）。
 * 用于"能力全景""字段墙""生态位"这类"多而有序"的画面。
 */
export const Grid: React.FC<{
  items: readonly string[]
  columns?: number
  cellW?: number
  cellH?: number
  gap?: number
  start?: number
  span?: number
  delay?: number
  size?: number
  color?: string
  /** 点亮项（下标或文本匹配），delay 后翻成强调色（每镜最多一次，勿群发）。 */
  ignite?: number[]
  igniteAt?: number
  igniteColor?: string
  align?: "center" | "left"
}> = ({
  items,
  columns = 6,
  cellW = 196,
  cellH = 62,
  gap = 14,
  start = 0,
  span = 90,
  delay = 0,
  size = 21,
  color = C.textDim,
  ignite = [],
  igniteAt,
  igniteColor = C.accent,
  align = "center",
}) => {
  const frame = useCurrentFrame()
  const rows = Math.ceil(items.length / columns)
  const gridW = columns * cellW + (columns - 1) * gap
  const gridH = rows * cellH + (rows - 1) * gap
  const containerOpacity = p(frame, delay, T.small)
  const isIgnited = (i: number): number => {
    if (igniteAt === undefined) return 0
    if (!ignite.includes(i)) return 0
    return p(frame, igniteAt + ignite.indexOf(i) * 5, T.small)
  }
  return (
    <div
      style={{
        width: gridW,
        height: gridH,
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, ${cellW}px)`,
        gridAutoRows: `${cellH}px`,
        gap,
        opacity: containerOpacity,
        justifyContent: align === "center" ? "center" : "flex-start",
      }}
    >
      {items.map((label, i) => {
        const on = accel(frame, i, items.length, start, span)
        const hot = isIgnited(i)
        return (
          <div
            key={label + i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              border: `1px solid ${hot > 0 ? C.accentSoft : C.line}`,
              borderRadius: 10,
              background: hot > 0 ? `rgba(122,162,247,${0.06 + hot * 0.1})` : "rgba(255,255,255,0.028)",
              opacity: on,
              transform: `translateY(${(1 - on) * 14}px) scale(${0.94 + on * 0.06})`,
            }}
          >
            <span
              style={{
                fontFamily: F.sans,
                fontSize: size,
                letterSpacing: "0.02em",
                color: hot > 0 ? igniteColor : color,
                opacity: 0.72 + on * 0.28,
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 节点流程 / 循环机制图：节点按给定角度排布，连线先画、节点后落位（可循环标注）。
 * 用于"主循环""因果链""工作流"这类机制说明——比堆文字更容易被看懂。
 */
export const NodeFlow: React.FC<{
  nodes: readonly string[]
  radius?: number
  nodeSize?: number
  delay?: number
  lineDelay?: number
  /** 首个节点的延迟。 */
  nodeDelay?: number
  /** 相邻节点的落位间隔（越密越局促，默认 42）。 */
  nodeStep?: number
  /** 圆形布局（true）或水平布局（false）。 */
  circular?: boolean
  centerLabel?: string
  centerSize?: number
  accent?: string
  clockwise?: boolean
}> = ({ nodes, radius = 240, nodeSize = 108, delay = 0, lineDelay = 0, nodeDelay = 40, nodeStep = 42, circular = true, centerLabel, centerSize = 30, accent = C.accent, clockwise = true }) => {
  const frame = useCurrentFrame()
  const n = nodes.length
  const points = nodes.map((_, i) => {
    const t = (i / n) * Math.PI * 2 - Math.PI / 2
    return circular ? { x: 960 + Math.cos(t) * radius, y: 540 + Math.sin(t) * radius } : { x: 960 + (i - (n - 1) / 2) * radius, y: 540 }
  })
  const draw = p(frame, delay, lineDelay || T.big)
  return (
    <>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {points.map((pt, i) => {
          const next = points[(i + 1) % n]
          if (!circular && i === n - 1) return null
          const segStart = i / n
          const segEnd = (i + 1) / n
          const local = clamp01(interpolate(draw, [segStart, segEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))
          const x2 = pt.x + (next.x - pt.x) * local
          const y2 = pt.y + (next.y - pt.y) * local
          return <line key={i} x1={pt.x} y1={pt.y} x2={x2} y2={y2} stroke="rgba(255,255,255,0.22)" strokeWidth={1.5} strokeDasharray="0" />
        })}
        {clockwise && circular
          ? points.map((pt, i) => {
              const next = points[(i + 1) % n]
              const mid = { x: (pt.x + next.x) / 2, y: (pt.y + next.y) / 2 }
              const on = p(frame, delay + T.big + i * 6, T.small)
              const ang = (Math.atan2(next.y - pt.y, next.x - pt.x) * 180) / Math.PI
              return (
                <polygon
                  key={`arrow-${i}`}
                  points="0,-5 10,0 0,5"
                  fill={accent}
                  opacity={on * 0.5}
                  transform={`translate(${mid.x},${mid.y}) rotate(${ang})`}
                />
              )
            })
          : null}
      </svg>
      {points.map((pt, i) => {
        const on = p(frame, nodeDelay + i * nodeStep, T.mid)
        return (
          <div
            key={nodes[i]}
            style={{
              position: "absolute",
              left: pt.x,
              top: pt.y,
              width: nodeSize,
              height: nodeSize,
              marginLeft: -nodeSize / 2,
              marginTop: -nodeSize / 2,
              borderRadius: "50%",
              border: `1px solid ${C.lineStrong}`,
              background: "rgba(18,21,28,0.92)",
              backdropFilter: "blur(10px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: on,
              transform: `scale(${0.9 + on * 0.1})`,
              boxShadow: `0 0 ${24 * on}px rgba(0,0,0,0.5)`,
            }}
          >
            <span style={{ fontFamily: F.sans, fontSize: nodeSize * 0.19, color: C.text, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{nodes[i]}</span>
          </div>
        )
      })}
      {centerLabel ? (
        <div style={{ position: "absolute", left: 960, top: 540, transform: "translate(-50%, -50%)", opacity: p(frame, nodeDelay, T.mid) }}>
          <span style={{ fontFamily: F.serif, fontSize: centerSize, letterSpacing: "0.14em", color: C.text }}>{centerLabel}</span>
        </div>
      ) : null}
    </>
  )
}

/**
 * 数字滚动（指标）：整数位从 0 冲刺到目标值并带轻微过冲落定。
 * 千分位与小数位按 `decimals` 处理；货币/单位由 suffix/prefix 给出。
 */
export const DigitRoll: React.FC<{
  value: number
  delay?: number
  duration?: number
  size?: number
  decimals?: number
  prefix?: string
  suffix?: string
  color?: string
  font?: string
  overshoot?: number
}> = ({ value, delay = 0, duration = T.big, size = 96, decimals = 0, prefix = "", suffix = "", color = C.text, font = F.mono, overshoot = 1.04 }) => {
  const frame = useCurrentFrame()
  const t = p(frame, delay, duration, EASE.out)
  const boost = 1 + (1 - t) * (overshoot - 1) * Math.sin(Math.PI * clamp01(t))
  const shown = value * t * boost
  const text = shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const on = p(frame, delay, T.small)
  return (
    <span style={{ fontFamily: font, fontSize: size, color, opacity: on, letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
      {prefix ? <span style={{ marginRight: "0.08em", opacity: 0.75 }}>{prefix}</span> : null}
      {text}
      {suffix ? <span style={{ marginLeft: "0.08em", opacity: 0.75 }}>{suffix}</span> : null}
    </span>
  )
}

/**
 * 闪切：跨镜头交棒的短促过场（闪白/闪黑/强调色）。
 * 惯例：`from` 给"切点前几帧"，由调用方在时间线上跨两个镜头摆放；用量要克制（全片 ≤3 处大冲击）。
 */
export const FlashCut: React.FC<{ duration?: number; color?: string; peak?: number; mode?: "flash" | "dip" }> = ({
  duration = 10,
  color = "#ffffff",
  peak = 0.9,
  mode = "flash",
}) => {
  const frame = useCurrentFrame()
  const mid = duration / 2
  const v = interpolate(frame, [0, mid, duration], mode === "flash" ? [0, 1, 0] : [1, 0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  return <div style={{ position: "absolute", inset: 0, backgroundColor: color, opacity: v * peak, pointerEvents: "none" }} />
}

/**
 * 合影围标（结语）：一批元素从四面八方飞来，在字标周围就位——"把已展示的东西一次性收拢"。
 * 槽位为**显式排布**（外圈为主），中央留空给字标与标语，保证零遮挡。
 */
export const Roster: React.FC<{
  items: readonly { text: string }[]
  centerX?: number
  centerY?: number
  radiusX?: number
  radiusY?: number
  start?: number
  span?: number
  delay?: number
  chipSize?: number
  /** 环绕起始角（度）：槽位整体旋转，用于避开同屏其它元素（0 = 自正上方起，顺时针）。 */
  rotation?: number
  accent?: string
}> = ({ items, centerX = 960, centerY = 540, radiusX = 640, radiusY = 330, start = 40, span = 240, delay = 0, chipSize = 19, rotation = 0, accent = C.accent }) => {
  const frame = useCurrentFrame()
  const containerOpacity = p(frame, delay, T.small)
  return (
    <div style={{ position: "absolute", inset: 0, opacity: containerOpacity }}>
      {items.map((item, i) => {
        const t = (i / items.length) * Math.PI * 2 - Math.PI / 2 + (rotation * Math.PI) / 180
        const wobble = 0.88 + ((i * 37) % 11) / 11 * 0.18
        const x = centerX + Math.cos(t) * radiusX * wobble
        const y = centerY + Math.sin(t) * radiusY * wobble
        const on = accel(frame, i, items.length, start, span)
        const dx = x - centerX
        const dy = y - centerY
        const off = 2.1 * (1 - on)
        return (
          <div
            key={item.text + i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              transform: `translate(-50%, -50%) translate(${dx * off}px, ${dy * off}px)`,
            }}
          >
            <div
              style={{
                fontFamily: F.sans,
                fontSize: chipSize,
                letterSpacing: "0.05em",
                color: C.text,
                background: "rgba(255,255,255,0.05)",
                border: `1px solid ${C.line}`,
                borderRadius: 999,
                padding: `${chipSize * 0.5}px ${chipSize * 1.05}px`,
                whiteSpace: "nowrap",
                opacity: on,
                transform: `scale(${0.9 + on * 0.1})`,
              }}
            >
              {item.text}
            </div>
          </div>
        )
      })}
      <div
        style={{
          position: "absolute",
          left: centerX,
          top: centerY,
          width: radiusX * 0.7,
          height: radiusY * 0.68,
          marginLeft: (-radiusX * 0.7) / 2,
          marginTop: (-radiusY * 0.68) / 2,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accent}22 0%, transparent 70%)`,
          opacity: p(frame, delay + 30, T.big),
          pointerEvents: "none",
        }}
      />
    </div>
  )
}
