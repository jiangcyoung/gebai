/**
 * 示例镜头 ①：品牌开场（准星描线 → 字标压印 → 副标 → tagline），落定后静止满 1 秒再走。
 * 这是全片唯一的"仪式感"镜头：一个主角（字标）、一条完整动作弧、一次高光（Wordmark 的光晕）。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion"
import { C, F, T } from "../theme"
import { Backplate, Crosshair, Headline, Kicker, Rule, p } from "../ui"
import { COPY } from "../timeline"

export const SceneOpen: React.FC = () => {
  const frame = useCurrentFrame()
  const subOn = p(frame, 96, T.small)
  const tagline = p(frame, 128, T.mid)
  return (
    <AbsoluteFill>
      <Backplate grid={120} glows={[{ x: 960, y: 520, r: 620, color: "rgba(122,162,247,0.20)", opacity: 0.9, delay: 16 }]}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Crosshair w={720} h={340} delay={2} />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
            <Headline text={COPY.brand} size={168} delay={40} perChar={6} tracking="0.22em" weight={700} />
            <div style={{ display: "flex", alignItems: "center", gap: 14, opacity: subOn }}>
              <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.accent }} />
              <span style={{ fontFamily: F.mono, fontSize: 18, letterSpacing: "0.42em", color: C.textDim }}>{COPY.brandSub}</span>
            </div>
          </div>
          <div style={{ marginTop: 34, display: "flex", justifyContent: "center" }}>
            <Rule width={520} delay={110} color="rgba(122,162,247,0.5)" />
          </div>
          <div style={{ marginTop: 30, opacity: tagline, transform: `translateY(${(1 - tagline) * 10}px)` }}>
            <span style={{ fontFamily: F.serif, fontSize: 34, letterSpacing: "0.28em", color: C.textDim }}>{COPY.tagline}</span>
          </div>
        </AbsoluteFill>
        <div style={{ position: "absolute", left: 120, top: 96 }}>
          <Kicker text={COPY.kicker} delay={118} size={14} align="left" />
        </div>
      </Backplate>
    </AbsoluteFill>
  )
}
