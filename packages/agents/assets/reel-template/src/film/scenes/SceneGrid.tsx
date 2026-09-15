/**
 * 示例镜头 ②：能力全景（左侧主张 + 右侧元素网格批量错峰入场，末尾点亮少数关键项）。
 * 演示 `Grid` 的用法：批量入场靠运动本身（越后越密），点光只给少数几个关键项、不群发。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion"
import { C, F, T } from "../theme"
import { Backplate, Grid, Headline, Kicker, Rule, p } from "../ui"
import { COPY } from "../timeline"

export const SceneGrid: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backplate grid={96} glows={[{ x: 1420, y: 560, r: 520, color: "rgba(122,162,247,0.14)", opacity: 0.8, delay: 20 }]}>
        <div style={{ position: "absolute", left: 140, top: 300, width: 620 }}>
          <Kicker text={COPY.gridKicker} delay={6} align="left" />
          <div style={{ marginTop: 26 }}>
            <Headline text={COPY.gridTitle} size={62} delay={14} perChar={3} align="left" tracking="0.04em" />
          </div>
          <div style={{ marginTop: 28 }}>
            <Rule width={260} delay={40} from="left" />
          </div>
          <div style={{ marginTop: 30, opacity: p(frame, 52, T.small), fontFamily: F.sans, fontSize: 22, lineHeight: 1.8, color: C.textDim, letterSpacing: "0.02em" }}>
            {COPY.gridBody}
          </div>
          <div style={{ marginTop: 40, opacity: p(frame, 96, T.mid) }}>
            <span style={{ fontFamily: F.mono, fontSize: 64, color: C.text }}>{COPY.gridCount}</span>
            <span style={{ marginLeft: 16, fontFamily: F.sans, fontSize: 20, color: C.textFaint, letterSpacing: "0.2em" }}>{COPY.gridCountUnit}</span>
          </div>
        </div>
        <div style={{ position: "absolute", left: 860, top: 250, width: 940, display: "flex", justifyContent: "center" }}>
          <Grid
            items={COPY.gridItems}
            columns={4}
            cellW={216}
            cellH={66}
            gap={14}
            start={20}
            span={110}
            ignite={[0, 5, 9]}
            igniteAt={150}
          />
        </div>
      </Backplate>
    </AbsoluteFill>
  )
}
