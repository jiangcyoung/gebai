import { Composition } from "remotion"
import { Film } from "./film/Film"
import { FPS, TOTAL } from "./film/timeline"

/**
 * 合成注册。竖屏/方屏交付时在这里再加一条 `<Composition>`（同一组件 + 不同 width/height），
 * 渲染时用 `composition` 参数选择。
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Reel" component={Film} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
  </>
)
