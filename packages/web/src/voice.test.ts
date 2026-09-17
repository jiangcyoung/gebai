/**
 * voice.ts 用例：合成请求契约、播放生命周期、全局单实例与请求代际。
 * 全程桩驱动的 fetch / Audio / blob URL——不联网、不发声、不依赖真实音频。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { client } from "./state"
import { VOICE_LOADING_CLASS, VOICE_MAX_TEXT, VOICE_PLAYING_CLASS, isSpeaking, speak, stopSpeaking } from "./voice"

const g = globalThis as unknown as Record<string, unknown>

/** 可断言的按钮桩（classList 记录类名变化）。 */
interface Btn {
  classes: Set<string>
  classList: { add: (c: string) => void; remove: (...cs: string[]) => void; contains: (c: string) => boolean }
}
function makeBtn(): Btn & HTMLElement {
  const classes = new Set<string>()
  return {
    classes,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (...cs: string[]) => {
        for (const c of cs) classes.delete(c)
      },
      contains: (c: string) => classes.has(c),
    },
  } as unknown as Btn & HTMLElement
}

/** Audio 桩：记录实例与 pause 调用；play 行为可用 rejectPlay 切换。 */
class AudioStub {
  static instances: AudioStub[] = []
  src: string
  paused = false
  played = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  rejectPlay = false
  constructor(src: string) {
    this.src = src
    AudioStub.instances.push(this)
  }
  play(): Promise<void> {
    this.played++
    return this.rejectPlay ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  /** 模拟播放自然结束。 */
  end(): void {
    this.onended?.()
  }
  fail(): void {
    this.onerror?.()
  }
}

/** 记录请求并按需给出响应（可控延迟用于验证请求代际）。 */
interface FetchCall {
  url: string
  init?: RequestInit
}
let calls: FetchCall[] = []
let responder: (call: FetchCall) => Promise<Response> | Response = () => wavResponse()

function wavResponse(): Response {
  return new Response(new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" }), {
    status: 200,
    headers: { "Content-Type": "audio/wav" },
  })
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } })
}

let origFetch: unknown
let origAudio: unknown
let origCreateUrl: unknown
let origRevokeUrl: unknown
let origToken: string | undefined
let origCreateEl: ((tag: string) => Record<string, unknown>) | undefined
let docRef: unknown
const created: string[] = []
const revoked: string[] = []

beforeEach(() => {
  calls = []
  // 响应者重置到成功档：上一用例可能改成错误响应，泄漏到下一个用例
  responder = () => wavResponse()
  created.length = 0
  revoked.length = 0
  AudioStub.instances = []
  origFetch = g.fetch
  origAudio = g.Audio
  origCreateUrl = URL.createObjectURL
  origRevokeUrl = URL.revokeObjectURL
  origToken = client.getToken()
  g.fetch = ((url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init }
    calls.push(call)
    return Promise.resolve(responder(call))
  }) as unknown as typeof fetch
  g.Audio = AudioStub as unknown as typeof Audio
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:stub/${created.length}-${blob.size}`
    created.push(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url)
  }) as typeof URL.revokeObjectURL
  captureToasts()
})

afterEach(() => {
  stopSpeaking()
  g.fetch = origFetch
  g.Audio = origAudio
  URL.createObjectURL = origCreateUrl as typeof URL.createObjectURL
  URL.revokeObjectURL = origRevokeUrl as typeof URL.revokeObjectURL
  if (docRef) (docRef as { createElement: unknown }).createElement = origCreateEl
  client.setToken(origToken ?? "")
})

/** 最近一条 toast 文案。ui.toast 的元素是进程级单例（可能已由先前的测试文件创建并缓存），
 *  此处仅能在本文件内首次创建时捕获——故失败文案的断言以 speak 返回值为准，本函数只作辅助校验。 */
let toasts: string[] = []

function captureToasts(): void {
  const doc = g.document as { createElement: (tag: string) => Record<string, unknown> }
  origCreateEl = doc.createElement
  docRef = doc
  doc.createElement = (tag: string) => {
    const node = origCreateEl!.call(doc, tag)
    if (String(tag).toLowerCase() !== "div") return node
    return new Proxy(node, {
      set(target, key, value) {
        if (key === "textContent" && String((target as { className?: unknown }).className ?? "").startsWith("toast")) toasts.push(String(value ?? ""))
        ;(target as Record<string, unknown>)[key as string] = value
        return true
      },
    })
  }
}

describe("合成请求", () => {
  test("POST /api/v1/tts，JSON 正文，本地模式无令牌时不带 Authorization", async () => {
    client.setToken("")
    const btn = makeBtn()
    await speak("你好", btn)
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe("/api/v1/tts")
    expect(calls[0].init?.method).toBe("POST")
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: "你好" })
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers.Authorization).toBeUndefined()
  })

  test("服务模式（已登录）：带 Bearer 令牌", async () => {
    client.setToken("tok-123")
    await speak("你好")
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer tok-123")
  })

  test("空文本不发请求", async () => {
    const out = await speak("   \n ")
    expect(calls.length).toBe(0)
    expect(out.ok).toBe(false)
  })

  test("超长文本前端拦下：不发请求并给出分段提示", async () => {
    const out = await speak("啊".repeat(VOICE_MAX_TEXT + 1))
    expect(calls.length).toBe(0)
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain("文本过长")
    expect((out as { reason: string }).reason).toContain(String(VOICE_MAX_TEXT))
  })
})

describe("播放生命周期", () => {
  test("成功：按钮 合成中 → 播放中，Audio 取 blob URL 且 play 被调用", async () => {
    const btn = makeBtn()
    await speak("朗读我", btn)
    expect(created.length).toBe(1)
    expect(AudioStub.instances.length).toBe(1)
    expect(AudioStub.instances[0].src).toBe(created[0])
    expect(AudioStub.instances[0].played).toBe(1)
    expect(btn.classes.has(VOICE_LOADING_CLASS)).toBe(false)
    expect(btn.classes.has(VOICE_PLAYING_CLASS)).toBe(true)
    expect(isSpeaking()).toBe(true)
  })

  test("播放自然结束：状态复位并释放 blob URL", async () => {
    const btn = makeBtn()
    await speak("朗读我", btn)
    AudioStub.instances[0].end()
    expect(btn.classes.has(VOICE_PLAYING_CLASS)).toBe(false)
    expect(isSpeaking()).toBe(false)
    expect(revoked).toEqual([created[0]])
  })

  test("音频解码失败：停止并释放 URL", async () => {
    const btn = makeBtn()
    await speak("朗读我", btn)
    AudioStub.instances[0].fail()
    expect(btn.classes.has(VOICE_PLAYING_CLASS)).toBe(false)
    expect(revoked).toEqual([created[0]])
    expect(isSpeaking()).toBe(false)
  })

  test("播放被浏览器拒绝（NotAllowedError）：原因透出、按钮复位、URL 释放", async () => {
    const btn = makeBtn()
    const origPlay = AudioStub.prototype.play
    AudioStub.prototype.play = function (this: AudioStub) {
      this.played++
      return Promise.reject(new Error("NotAllowedError"))
    }
    let out: Awaited<ReturnType<typeof speak>>
    try {
      out = await speak("朗读我", btn)
    } finally {
      AudioStub.prototype.play = origPlay
    }
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain("NotAllowedError")
    expect(btn.classes.has(VOICE_PLAYING_CLASS)).toBe(false)
    expect(btn.classes.has(VOICE_LOADING_CLASS)).toBe(false)
    expect(isSpeaking()).toBe(false)
    expect(revoked).toEqual([created[0]])
  })

  test("服务端失败：原因透出服务端 error 文案，不播放、按钮复位", async () => {
    responder = () => errorResponse(400, "语音合成不可用：未检测到本机离线语音引擎。")
    const btn = makeBtn()
    const out = await speak("朗读我", btn)
    expect(AudioStub.instances.length).toBe(0)
    expect(btn.classes.size).toBe(0)
    expect(isSpeaking()).toBe(false)
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain("未检测到本机离线语音引擎")
  })

  test("响应非 JSON（如网关错误页）：回落 HTTP 状态码文案", async () => {
    responder = () => new Response("<html>bad gateway</html>", { status: 502 })
    const out = await speak("朗读我")
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain("HTTP 502")
  })
})

describe("全局单实例与切换语义", () => {
  test("播放中朗读另一条：先停旧的（pause + 释放 URL），只留新的在播", async () => {
    const btnA = makeBtn()
    const btnB = makeBtn()
    await speak("第一条", btnA)
    await speak("第二条", btnB)
    expect(AudioStub.instances.length).toBe(2)
    expect(AudioStub.instances[0].paused).toBe(true)
    expect(AudioStub.instances[1].paused).toBe(false)
    expect(revoked).toEqual([created[0]])
    expect(btnA.classes.size).toBe(0)
    expect(btnB.classes.has(VOICE_PLAYING_CLASS)).toBe(true)
  })

  test("再点同一条（播放中）= 停止", async () => {
    const btn = makeBtn()
    await speak("朗读我", btn)
    await speak("朗读我", btn)
    expect(AudioStub.instances[0].paused).toBe(true)
    expect(isSpeaking()).toBe(false)
    expect(btn.classes.size).toBe(0)
    expect(calls.length).toBe(1) // 第二次是停止，不重复合成
  })

  test("stopSpeaking 幂等：空闲时调用无副作用", () => {
    stopSpeaking()
    stopSpeaking()
    expect(isSpeaking()).toBe(false)
    expect(revoked).toEqual([])
  })
})

describe("请求代际（合成在途时被取代）", () => {
  test("旧请求迟到：不播放、不污染新会话的按钮状态", async () => {
    // 用容器存门闩：闭包赋值不被控制流分析识别，读回时用非空断言；首个请求挂起、后续正常返回
    let first = true
    const gate: { release: (() => void) | null } = { release: null }
    responder = () => {
      if (!first) return wavResponse()
      first = false
      return new Promise<Response>((resolve) => {
        gate.release = () => resolve(wavResponse())
      })
    }
    const btnA = makeBtn()
    const btnB = makeBtn()
    const pendingA = speak("第一条", btnA)
    await speak("第二条", btnB)
    gate.release!()
    await pendingA
    // 第一条从未播放，其按钮状态已由取代方复位；第二条照常播放
    expect(AudioStub.instances.length).toBe(1)
    expect(AudioStub.instances[0].played).toBe(1)
    expect(btnA.classes.size).toBe(0)
    expect(btnB.classes.has(VOICE_PLAYING_CLASS)).toBe(true)
  })

  test("合成在途时停止（同一条再点）：中止请求、结果丢弃、按钮复位、无音频实例", async () => {
    const gate: { release: (() => void) | null } = { release: null }
    let signal: AbortSignal | undefined
    responder = () =>
      new Promise<Response>((resolve) => {
        gate.release = () => resolve(wavResponse())
      })
    const btn = makeBtn()
    const pending = speak("第一条", btn)
    signal = calls[0]?.init?.signal as AbortSignal | undefined
    expect(btn.classes.has(VOICE_LOADING_CLASS)).toBe(true)
    expect(signal?.aborted).toBe(false)
    await speak("第一条", btn) // 合成中再点 = 停止：中止在途请求
    expect(signal?.aborted).toBe(true)
    gate.release!()
    await pending
    expect(AudioStub.instances.length).toBe(0)
    expect(btn.classes.size).toBe(0)
    expect(isSpeaking()).toBe(false)
  })

  test("请求被中止（超时/取消）且仍属当前会话：报合成超时而非原始 AbortError", async () => {
    const abortErr = new Error("The operation was aborted")
    abortErr.name = "AbortError"
    responder = () => Promise.reject(abortErr)
    const btn = makeBtn()
    const out = await speak("朗读我", btn)
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain("合成超时")
    expect(btn.classes.size).toBe(0)
  })
})
