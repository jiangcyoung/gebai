/**
 * 全片装配：按 timeline 的镜头窗口铺开镜头、音效与解说。
 *
 * 扩容方式：在 `timeline.SHOTS` 增加镜头窗口 → 在这里加一条 `<Sequence>` → 在 `scenes/` 下新建该镜组件。
 * 镜头组件一律渲染在 `<Sequence>` 内（其 `useCurrentFrame()` 即镜头内相对帧）。
 */
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion"
import { CAPTIONS, SFX, SHOTS, sfxDuration } from "./timeline"
import { Caption } from "./ui"
import { SceneOpen } from "./scenes/SceneOpen"
import { SceneGrid } from "./scenes/SceneGrid"
import { SceneFlow } from "./scenes/SceneFlow"
import { SceneOutro } from "./scenes/SceneOutro"

export const Film: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#0b0d12" }}>
    {/* 音效：钉帧表驱动（占位为空表；填表后自动生效） */}
    {SFX.map((s, i) => (
      <Sequence key={`sfx-${i}`} from={s.from} durationInFrames={sfxDuration(s)}>
        <Audio src={staticFile(s.src)} volume={s.volume} />
      </Sequence>
    ))}

    <Sequence from={SHOTS.open.from} durationInFrames={SHOTS.open.duration}>
      <SceneOpen />
    </Sequence>
    <Sequence from={SHOTS.grid.from} durationInFrames={SHOTS.grid.duration}>
      <SceneGrid />
    </Sequence>
    <Sequence from={SHOTS.flow.from} durationInFrames={SHOTS.flow.duration}>
      <SceneFlow />
    </Sequence>
    <Sequence from={SHOTS.outro.from} durationInFrames={SHOTS.outro.duration}>
      <SceneOutro />
    </Sequence>

    {/* 解说条（跨镜头，统一挂在这一层，章节组件里不要再嵌 Caption） */}
    {CAPTIONS.map((c, i) => (
      <Sequence key={`cap-${i}`} from={c.from} durationInFrames={c.duration}>
        <Caption text={c.text} duration={c.duration} />
      </Sequence>
    ))}
  </AbsoluteFill>
)
