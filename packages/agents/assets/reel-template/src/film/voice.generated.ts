/**
 * 配音与字幕表 —— 由 reel_voice 生成（本机离线语音引擎，零联网）。
 *
 * 空表 = 整片无配音、无字幕（示例片默认如此，可直接渲染）。
 * reel_voice action=build 会写入本文件：`VOICEOVER` 是配音音频钉帧表（Film.tsx 逐条挂 `<Audio>`），
 * `SUBTITLES` 是与配音逐句同窗的字幕表（走 Subtitle 原语烧入成片）。**手改会在下次生成时被覆盖**——
 * 要改文案就改 reel_voice 的入参后重跑。帧号与 `timeline.FPS` 同一坐标系。
 */
export const VOICEOVER: Array<{ from: number; duration: number; src: string; volume: number; text: string }> = []

export const SUBTITLES: Array<{ from: number; duration: number; text: string }> = []
