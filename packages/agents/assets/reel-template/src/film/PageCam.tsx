/**
 * 2.5D 页面相机 —— 一切"真实页面"镜头的地基（把真实截图当成可运镜的平面）。
 *
 * 两条不能降档的技法：
 * 1. **放大必须走 CSS `zoom`（布局级缩放），不能走 transform scale**。3D 合成层若用 transform scale 放大，
 *    Chromium 会先在布局尺寸上栅格化再由 GPU 放大——页面内的文字必然发糊（与相机/景深参数无关）。
 *    `zoom` 放大的是布局盒本身，页面按放大后的设备尺寸重新栅格化，从高清源向下采样，字形边缘保持锐利。
 * 2. **坐标系换算**：`zoom` 缩放元素本地坐标空间，页面点 (cx,cy) 落在 (cx*zoom, cy*zoom)，平移量因此是
 *    `960/zoom − cx`（Ty 同理）；旋转以 (cx,cy) 为 transform-origin，焦点在屏幕上不动。
 *    漏掉 `/zoom` 会让推近时取景跑偏。
 *
 * 素材要求：截图按显示尺寸的 **2–4 倍**采集（pageW 为布局宽，纹理像素宽为 pageW × 倍率），
 * 这样放大到 zoom≈2 仍有余量；1x 纹理的镜头请把 zoom 控制在 1.15 以内。
 */
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion"
import type { ReactNode } from "react"

export type CamKey = {
  /** 镜头内相对帧。 */
  frame: number
  /** 页面坐标（CSS px）中要对准视口中心的点。 */
  cx: number
  cy: number
  /** 缩放：1 = 1 CSS px 映射 1 输出 px。 */
  zoom: number
  /** 俯仰（正 = 上沿远离，像俯看桌面）。 */
  rotX?: number
  /** 偏航（正 = 右边后退，即从左侧看）。 */
  rotY?: number
  /** 画面内旋转。 */
  rotZ?: number
  /** 透视强度（px，越小越强）。 */
  persp?: number
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const PageCam: React.FC<{
  /** 纹理路径（相对 public/，如 "textures/home-2x.png"）。 */
  src: string
  /** 页面布局宽（与采集时视口宽一致）。 */
  pageW: number
  /** 页面布局高（整页高；只截首屏时给视口高）。 */
  pageH: number
  keys: CamKey[]
  /** 页面坐标系里的叠加层（注记/高亮框/光标），随页面一起被相机推动。 */
  children?: ReactNode
  blur?: number
  saturate?: number
  ease?: (t: number) => number
  /** 近似的景深：页面远处（上方）加一层渐变模糊。 */
  dof?: { focusY: number; strength: number }
  bg?: string
  /** 图片填充方式：整页截图用默认（拉伸到 pageW×pageH）；元素级抠图用 "contain"。 */
  fit?: "fill" | "contain"
}> = ({ src, pageW, pageH, keys, children, blur = 0, saturate = 1, ease = Easing.bezier(0.33, 0, 0.15, 1), dof, bg = "#0b0d12", fit = "fill" }) => {
  const frame = useCurrentFrame()
  let a = keys[0]
  let b = keys[keys.length - 1]
  for (let i = 0; i < keys.length - 1; i++) {
    if (frame >= keys[i].frame && frame <= keys[i + 1].frame) {
      a = keys[i]
      b = keys[i + 1]
      break
    }
  }
  const t = a.frame === b.frame ? 1 : interpolate(frame, [a.frame, b.frame], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease })
  const cx = lerp(a.cx, b.cx, t)
  const cy = lerp(a.cy, b.cy, t)
  const zoom = lerp(a.zoom, b.zoom, t)
  const rotX = lerp(a.rotX ?? 0, b.rotX ?? 0, t)
  const rotY = lerp(a.rotY ?? 0, b.rotY ?? 0, t)
  const rotZ = lerp(a.rotZ ?? 0, b.rotZ ?? 0, t)
  const persp = lerp(a.persp ?? 1400, b.persp ?? 1400, t)

  const filters: string[] = []
  if (blur > 0) filters.push(`blur(${blur}px)`)
  if (saturate !== 1) filters.push(`saturate(${saturate})`)

  const has3D = keys.some((k) => k.rotX !== undefined || k.rotY !== undefined || k.rotZ !== undefined || k.persp !== undefined)

  const plane = (
    <div
      style={{
        position: "absolute",
        width: pageW,
        height: pageH,
        zoom,
        transform: has3D
          ? `translate(${960 / zoom - cx}px, ${540 / zoom - cy}px) rotateY(${rotY}deg) rotateX(${rotX}deg) rotateZ(${rotZ}deg)`
          : `translate(${960 / zoom - cx}px, ${540 / zoom - cy}px)`,
        transformOrigin: has3D ? `${cx}px ${cy}px` : "0 0",
        transformStyle: has3D ? "preserve-3d" : undefined,
        filter: filters.length ? filters.join(" ") : undefined,
      }}
    >
      <Img src={staticFile(src)} style={{ position: "absolute", width: pageW, height: pageH, objectFit: fit }} />
      {children}
    </div>
  )

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", backgroundColor: bg }}>
      {has3D ? (
        <div style={{ position: "absolute", inset: 0, perspective: `${persp * zoom}px`, perspectiveOrigin: "960px 540px" }}>{plane}</div>
      ) : (
        plane
      )}
      {dof ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: Math.max(0, dof.focusY),
            backdropFilter: `blur(${dof.strength}px)`,
            maskImage: "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 100%)",
            pointerEvents: "none",
          }}
        />
      ) : null}
    </div>
  )
}

/** 页面坐标系里的注记框（高亮某个元素时用；坐标即截图里的 CSS px）。 */
export const PageBox: React.FC<{
  x: number
  y: number
  w: number
  h: number
  delay?: number
  color?: string
  label?: string
  labelSide?: "left" | "right"
}> = ({ x, y, w, h, delay = 0, color = "#7aa2f7", label, labelSide = "right" }) => {
  const frame = useCurrentFrame()
  const on = interpolate(frame, [delay, delay + 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.22, 1, 0.36, 1) })
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: w,
          height: h,
          border: `1px solid ${color}`,
          borderRadius: 6,
          boxShadow: `0 0 30px ${color}44`,
          opacity: on * 0.95,
          transform: `scale(${0.985 + on * 0.015})`,
        }}
      />
      {label ? (
        <div
          style={{
            position: "absolute",
            left: labelSide === "right" ? x + w + 18 : x - 18,
            top: y + h / 2,
            transform: `translate(${labelSide === "right" ? "0" : "-100%"}, -50%)`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            opacity: on,
          }}
        >
          <div style={{ width: 42, height: 1, backgroundColor: color, opacity: 0.7 }} />
          <div
            style={{
              fontFamily: '"Noto Sans CJK SC",system-ui,sans-serif',
              fontSize: 17,
              letterSpacing: "0.14em",
              color,
              background: "rgba(11,13,18,0.8)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 999,
              padding: "7px 14px",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
        </div>
      ) : null}
    </>
  )
}
