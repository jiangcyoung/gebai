import { Config } from "@remotion/cli/config"

/**
 * Remotion 配置。渲染走 reel 子Agent 的原生渲染库（不经 CLI），此处只影响手动 `npx remotion` 调试；
 * 保持与子Agent 的默认档一致：720p 以上一律 JPEG 中间帧、并发交给子Agent 决策。
 */
Config.setVideoImageFormat("jpeg")
Config.setJpegQuality(82)
Config.setOverwriteOutput(true)
