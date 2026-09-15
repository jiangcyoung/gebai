/**
 * 示例镜头 ③：机制说明（环形节点流程：连线先画、节点后落位，配一组指标数字）。
 * 演示 `NodeFlow` 与 `DigitRoll`：机制类画面给"结构 + 数字"，比堆文字更易读。
 */
import { AbsoluteFill, useCurrentFrame } from "remotion"
import { C, F, T } from "../theme"
import { Backplate, DigitRoll, Headline, Kicker, NodeFlow, p } from "../ui"
import { COPY } from "../timeline"

export const SceneFlow: React.FC = () => {
  const frame = useCurrentFrame()
  return (
    <AbsoluteFill>
      <Backplate grid={140} glows={[{ x: 960, y: 540, r: 560, color: "rgba(122,162,247,0.12)", opacity: 0.85, delay: 10 }]}>
        <div style={{ position: "absolute", left: 120, top: 96 }}>
          <Kicker text={COPY.flowKicker} delay={4} align="left" />
        </div>
        <div style={{ position: "absolute", left: 120, top: 168 }}>
          <Headline text={COPY.flowTitle} size={52} delay={10} perChar={3} align="left" />
        </div>
        <NodeFlow
          nodes={COPY.flowNodes}
          radius={224}
          nodeSize={104}
          delay={30}
          nodeDelay={30}
          nodeStep={30}
          centerLabel={COPY.flowCenter}
          centerSize={32}
        />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 96, display: "flex", justifyContent: "center", gap: 96 }}>
          {COPY.flowMetrics.map((m, i) => (
            <div key={m.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, opacity: p(frame, 150 + i * 10, T.mid) }}>
              <DigitRoll value={m.value} suffix={m.suffix} delay={152 + i * 10} size={72} />
              <span style={{ fontFamily: F.sans, fontSize: 18, letterSpacing: "0.24em", color: C.textFaint }}>{m.label}</span>
            </div>
          ))}
        </div>
      </Backplate>
    </AbsoluteFill>
  )
}
