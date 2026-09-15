/**
 * 示例镜头 ④：结语（元素合影围住字标 → 字标落地 → 标语）。
 * 全片能量峰值：`Roster` 把已展示的元素按硬加速错峰收拢，字标随后压印并静止 ≥1 秒（R1）。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion"
import { C, F, T } from "../theme"
import { Backplate, Headline, Roster, p } from "../ui"
import { COPY } from "../timeline"

export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame()
  const markOn = p(frame, 170, T.mid)
  const tagline = p(frame, 214, T.mid)
  return (
    <AbsoluteFill>
      <Backplate
        glows={[
          { x: 960, y: 540, r: 560, color: "rgba(122,162,247,0.16)", opacity: 0.9, delay: 40 },
          { x: 620, y: 380, r: 320, color: "rgba(224,176,112,0.10)", opacity: 0.8, delay: 120 },
        ]}
        vignette={0.6}
      >
        <Roster items={COPY.rosterItems.map((text) => ({ text }))} start={30} span={130} delay={10} />
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ transform: "translateY(-46px)" }}>
            <Headline text={COPY.brand} size={142} delay={170} perChar={6} tracking="0.24em" weight={700} />
          </div>
          <div style={{ position: "absolute", top: "62%", opacity: tagline, transform: `translateY(${(1 - tagline) * 12}px)` }}>
            <span style={{ fontFamily: F.serif, fontSize: 44, letterSpacing: "0.2em", color: C.text }}>{COPY.outroTagline}</span>
          </div>
          <div style={{ position: "absolute", top: "71%", opacity: p(frame, 236, T.small) }}>
            <span style={{ fontFamily: F.sans, fontSize: 18, letterSpacing: "0.42em", color: C.textDim }}>{COPY.brandSub}</span>
          </div>
        </AbsoluteFill>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 84, textAlign: "center", opacity: p(frame, 240, T.small) }}>
          <span style={{ fontFamily: F.mono, fontSize: 17, letterSpacing: "0.3em", color: C.textFaint, opacity: markOn }}>{COPY.outroFoot}</span>
        </div>
      </Backplate>
    </AbsoluteFill>
  )
}
