/**
 * 全片装配：按 timeline 的镜头窗口铺开镜头与音效，再挂上配音、字幕与合成音效
 * （voice.generated.ts / sfx.generated.ts，由 reel_voice 生成）。
 *
 * 扩容方式：在 `timeline.SHOTS` 增加镜头窗口 → 在这里加一条 `<Sequence>` → 在 `scenes/` 下新建该镜组件。
 * 镜头组件一律渲染在 `<Sequence>` 内（其 `useCurrentFrame()` 即镜头内相对帧）。
 */
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion"
import { CAPTIONS, SFX, SHOTS, sfxDuration } from "./timeline"
import { Caption, Subtitle } from "./ui"
import { SFX_TRACKS } from "./sfx.generated"
import { SUBTITLES, VOICEOVER } from "./voice.generated"
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

    {/* 合成音效：reel_voice action=sfx 生成的钉帧表（空表 = 无合成音效） */}
    {SFX_TRACKS.map((s, i) => (
      <Sequence key={`sfx-gen-${i}`} from={s.from} durationInFrames={s.duration}>
        <Audio src={staticFile(s.src)} volume={s.volume} />
      </Sequence>
    ))}

    {/* 配音：reel_voice 生成的钉帧表（空表 = 全片无声，示例片即如此） */}
    {VOICEOVER.map((v, i) => (
      <Sequence key={`vo-${i}`} from={v.from} durationInFrames={v.duration}>
        <Audio src={staticFile(v.src)} volume={v.volume} />
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

    {/* 配音字幕（同样统一挂在这一层）：与配音逐句同窗，帧号来自同一份生成数据 */}
    {SUBTITLES.map((s, i) => (
      <Sequence key={`sub-${i}`} from={s.from} durationInFrames={s.duration}>
        <Subtitle text={s.text} duration={s.duration} />
      </Sequence>
    ))}
  </AbsoluteFill>
)
