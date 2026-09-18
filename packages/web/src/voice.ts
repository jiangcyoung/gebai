/**
 * 助手回复朗读（文本转语音）：把消息文本交给服务端 `POST /api/v1/tts` 合成，取回 WAV 后本机播放。
 * 合成与引擎细节全在服务端（离线系统语音），前端只管「取音频 → 播 → 收尾」。
 *
 * 三条约束：
 * - **全局单实例**：同一时刻至多一条在播——点另一条先停旧的（不叠音），再点同一条 = 停止。
 * - **状态归属按钮**：合成中/播放中以按钮上的类名表达（样式见 chat.css `.msg-act.voice-*`），
 *   状态只落在本模块记录的按钮上，不依赖调用方传参。
 * - **请求代际**：合成是异步的，期间可能已被新的朗读/停止取代——用自增序号作废旧请求，
 *   其迟到结果既不播放也不残留按钮状态。
 */
import { client } from "./state"
import { appPath } from "@gebai/sdk"
import { toast } from "./ui"

/** 单次朗读文本上限（与服务端同一口径）：超长在前端拦下，不发请求。 */
export const VOICE_MAX_TEXT = 20000

/** 合成请求超时（毫秒）：服务端合成超时 120 秒，这里给足余量——挂住时按钮不会永远停在「合成中」。 */
export const VOICE_REQUEST_TIMEOUT_MS = 150_000

/** 按钮状态类：合成中 / 播放中。 */
export const VOICE_LOADING_CLASS = "voice-loading"
export const VOICE_PLAYING_CLASS = "voice-playing"

interface VoiceSession {
  btn: HTMLElement | null
  /** 代际：与模块级序号不一致即视为已作废。 */
  seq: number
  /** 合成请求的中断句柄（停止朗读时中止在途请求，不白白占用服务端合成）。 */
  controller?: AbortController
  /** 进入播放阶段后填充。 */
  audio?: HTMLAudioElement
  url?: string
}

/** 当前朗读会话（合成中或播放中）；null = 空闲。 */
let current: VoiceSession | null = null
/** 请求代际：每次发起朗读/停止自增，使在途合成结果作废。 */
let seq = 0

function setBtnState(btn: HTMLElement | null, cls: string | null): void {
  if (!btn) return
  btn.classList.remove(VOICE_LOADING_CLASS, VOICE_PLAYING_CLASS)
  if (cls) btn.classList.add(cls)
}

/** 停止朗读并释放资源：blob URL 必须显式 revoke，否则每次朗读都会留一份音频在内存里。
 *  空闲时调用无副作用；同时中止在途合成请求（其迟到结果直接丢弃）。 */
export function stopSpeaking(): void {
  seq++
  const cur = current
  current = null
  if (!cur) return
  setBtnState(cur.btn, null)
  cur.controller?.abort()
  if (cur.audio) {
    try {
      cur.audio.pause()
    } catch {
      /* 未进入播放或已释放：忽略 */
    }
  }
  if (cur.url) URL.revokeObjectURL(cur.url)
}

/** 是否正在朗读（合成中或播放中）。 */
export function isSpeaking(): boolean {
  return current !== null
}

/** 请求服务端合成：失败时优先透出服务端 JSON `{ error }` 里的原因（文本为空/超长/引擎不可用）。 */
async function synthesize(text: string, signal: AbortSignal): Promise<Blob> {
  const token = client.getToken()
  const res = await fetch(appPath("/api/v1/tts"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) detail = body.error
    } catch {
      /* 非 JSON 响应：保留状态码 */
    }
    throw new Error(detail)
  }
  return res.blob()
}

/** 朗读结果：ok=true 已开始播放；ok=false 带原因（与 toast 文案同源，调用方可直接引用）。 */
export type VoiceOutcome = { ok: true } | { ok: false; reason: string }

/**
 * 朗读文本：`btn` 传消息上的朗读按钮时以其表达状态（缺省仅播放，不显示状态）。
 * 再点同一条消息的按钮 = 停止（切换语义），视为成功结束（用户预期内，非错误）。
 */
export async function speak(text: string, btn?: HTMLElement | null): Promise<VoiceOutcome> {
  // 切换：正在合成/播放的就是这个按钮 → 停止
  if (current && btn && current.btn === btn) {
    stopSpeaking()
    return { ok: true }
  }
  stopSpeaking()

  const content = text.trim()
  if (!content) return { ok: false, reason: "朗读失败：内容为空" }
  if (content.length > VOICE_MAX_TEXT) {
    const reason = `文本过长（${content.length} 字符，上限 ${VOICE_MAX_TEXT}），请分段朗读`
    toast(reason)
    return { ok: false, reason }
  }

  const mine = ++seq
  const controller = new AbortController()
  const session: VoiceSession = { btn: btn ?? null, seq: mine, controller }
  current = session
  setBtnState(session.btn, VOICE_LOADING_CLASS)
  const timer = setTimeout(() => controller.abort(), VOICE_REQUEST_TIMEOUT_MS)

  let url = ""
  try {
    const blob = await synthesize(content, controller.signal)
    clearTimeout(timer)
    if (current?.seq !== mine) return { ok: true } // 期间已发起新的朗读或停止：结果丢弃（其按钮状态已由对方复位）
    url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    session.url = url
    session.audio = audio
    setBtnState(session.btn, VOICE_PLAYING_CLASS)
    audio.onended = () => {
      if (current === session) stopSpeaking()
    }
    audio.onerror = () => {
      if (current !== session) return
      stopSpeaking()
      toast("朗读失败：音频无法播放")
    }
    await audio.play()
    return { ok: true }
  } catch (err) {
    clearTimeout(timer)
    if (current !== session) return { ok: true } // 已被新的朗读/停止取代：状态与资源归对方处置
    current = null
    setBtnState(session.btn, null)
    if (url) URL.revokeObjectURL(url)
    const aborted = (err as Error)?.name === "AbortError"
    const reason = aborted ? `朗读失败：合成超时（服务端未在 ${VOICE_REQUEST_TIMEOUT_MS / 1000} 秒内返回）` : `朗读失败：${(err as Error).message}`
    toast(reason)
    return { ok: false, reason }
  }
}
