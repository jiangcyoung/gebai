/**
 * 音效钉帧表 —— 由 reel_voice action=sfx 生成（纯本地波形合成，零联网）。
 *
 * 空表 = 全片无合成音效（示例片默认如此，可直接渲染）。
 * 与 `timeline.SFX`（手工登记的素材音效）**并行生效**：同一动作不要两处都写。
 * `volume` 是成片里的播放音量；`duration` 是播放窗帧数（窗口短于音频会把声音截断）。
 */
export const SFX_TRACKS: Array<{ from: number; duration: number; src: string; volume: number; note?: string }> = []
