/**
 * 浏览器内渲染通道：把「逐帧 seek → 捕获 → 编码」全部搬进浏览器自己驱动，
 * 绕开 Remotion 的 CDP 截帧通道（实测 1080p 单帧 66ms，是默认路径的主要成本）。
 *
 * ## 为什么自己启浏览器、直连 CDP
 * 两条现成通道都走不通：Remotion 的浏览器参数是**固定列表**（没有自定义 args 的入口，拿不到
 * `--enable-blink-features=CanvasDrawElement`），而 playwright/puppeteer 无法进入 server 包
 *（`chromium-bidi` 解析不到，本仓库本就把 playwright-core 当内嵌资产用）。
 * 于是这里只依赖 Bun 自带的 `Bun.spawn` + 内置 `WebSocket` 直连 CDP——零第三方依赖，参数任意给。
 *
 * ## 两条通道
 * - `dom-canvas`：**保留 DOM/CSS/React**（镜头原语一行不改）——`drawElementImage` 把舞台抓进 canvas
 *   （实测 3.2ms/帧），`WebCodecs` 编 H.264（实测 22.8ms/帧），码流边产边回流宿主，最后由 ffmpeg 封 mp4。
 *   **该通道下贵 CSS 直接决定吞吐**（实测同一 DOM：`backdrop-filter` + 大 blur 105ms/帧、去掉 backdrop-filter
 *   68ms、全部去掉 42ms）——与 CDP 通道的结论相反（那条通道里内容只占 4ms，因为截帧 66ms 主导）。
 * - `record`：`canvas.captureStream()` + `MediaRecorder` 实时录制，自带容器直出 mp4（用于交互/实时内容）。
 *   **纪律（实测，勿放宽）**：不可能快于实时（90 帧实测 3015ms）；推帧快于合成即**全部丢帧**（实测产物仅 110 字节）；
 *   时序跟墙钟且不可复现（60 帧本应 2.0s，实测 3.03s，帧率元数据失真）。交付成片不要用它。
 *
 * ## 帧驱动契约（Rebotion 页面向 bundle 暴露的全局；实测 4.0.484）
 * `remotion_setBundleMode({type:'composition', …})` → `remotion_renderReady === true` →
 * `remotion_setFrame(frame, 合成ID, 0)` → 再等 ready → `document.fonts.ready`。
 * 实测该握手产物与官方渲染器**逐像素一致**（0 差异）；契约缺失即抛可操作错误并建议回退 remotion。
 *
 * ## 陷阱（实测踩过，勿删）
 * - `serializedResolvedPropsWithSchema` 必须是 **JSON 字符串**（bundle 侧 `JSON.parse`），传对象报
 *   `"[object Object]" is not valid JSON`。
 * - **不先切渲染模式，`setFrame` 会静默失效**（页面停在初始画面，seek 前后几乎无差异）——最隐蔽的一条。
 * - `drawElementImage` 要求目标元素是 canvas 的**直接子节点**，且 canvas 需开 `layoutsubtree`；
 *   该 API 还需浏览器以 `--enable-blink-features=CanvasDrawElement` 启动。
 * - 内置 compositor 的 ffmpeg 是精简构建（无 psnr/ssim 滤镜、无 rawvideo 封装）——像素比对只能走浏览器侧。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolContext } from "@gebai/sdk"
import { runtimeDir, stateDir } from "./paths"
import { resolveShardFfmpeg } from "./shards"
import type { VideoConfig } from "./runtime"

/** 浏览器内渲染通道（不含 remotion：那是默认路径）。 */
export const BROWSER_BACKENDS = ["dom-canvas", "record"] as const
export type BrowserBackend = (typeof BROWSER_BACKENDS)[number]
export const isBrowserBackend = (value: string): value is BrowserBackend => (BROWSER_BACKENDS as readonly string[]).includes(value)

/** dom-canvas 与 record 都要用 drawElementImage 抓帧，故两者都需 Blink 开关（默认关闭）。 */
export const CANVAS_DRAW_ELEMENT_FLAG = "--enable-blink-features=CanvasDrawElement"
/** 默认渲染通道（未传 backend 参数时生效；参数优先于它）。 */
export const BACKEND_ENV = "GEBAI_REEL_BACKEND"

export interface BrowserRenderArgs {
  ctx: ToolContext
  backend: BrowserBackend
  /** 工程 bundle 目录（即 Remotion 的 serveUrl）。 */
  serveUrl: string
  composition: VideoConfig
  /** 输出像素尺寸（已取偶）。 */
  width: number
  height: number
  fps: number
  /** 帧段（含端点）；null = 整片。 */
  frameRange?: [number, number | null] | null
  output: string
  /** 浏览器可执行文件绝对路径。 */
  browserExecutable: string | null
  shouldStop?: () => boolean
  onProgress?: (rendered: number, total: number) => void
  log: (line: string) => void
}

export interface BrowserRenderResult {
  frames: number
  streamBytes: number
  captureMsPerFrame: number
  container: string
}

// ───────────────────────────── CDP 最小客户端 ─────────────────────────────

interface CdpMessage {
  id?: number
  result?: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
}

/** 一个 page 目标上的 CDP 连接：只需要 `Runtime.evaluate` 与轮询等待。 */
class CdpPage {
  private constructor(
    private readonly proc: Bun.Subprocess,
    private readonly ws: WebSocket,
    private readonly userDataDir: string,
  ) {}

  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  /** 启动浏览器（首屏即目标 URL）并连上它的 page 目标。 */
  static async launch(opts: {
    executable: string
    args: string[]
    url: string
    width: number
    height: number
    /** 浏览器 profile 目录（调用方给，收尾时删除）。 */
    userDataDir: string
  }): Promise<CdpPage> {
    const userDataDir = opts.userDataDir
    mkdirSync(userDataDir, { recursive: true })
    // 先占一个空闲端口再释放：remote-debugging-port=0 拿不到端口号
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    const port = probe.port ?? 0
    probe.stop(true)

    const proc = Bun.spawn(
      [
        opts.executable,
        ...opts.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--hide-scrollbars",
        "--mute-audio",
        // 像素一致性：Remotion 也带这两个开关，缺了会出现系统性色彩/字重偏移
        "--force-color-profile=srgb",
        "--font-render-hinting=none",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-component-update",
        `--user-data-dir=${userDataDir}`,
        `--window-size=${opts.width},${opts.height}`,
        `--remote-debugging-port=${port}`,
        opts.url,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )

    const deadline = Date.now() + 60_000
    let wsUrl: string | null = null
    while (Date.now() < deadline && !wsUrl) {
      await Bun.sleep(200)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        const targets = (await res.json()) as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>
        wsUrl = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? null
      } catch {
        /* 浏览器尚未就绪 */
      }
    }
    if (!wsUrl) {
      proc.kill()
      rmSync(userDataDir, { recursive: true, force: true })
      throw new Error("浏览器未在 60s 内暴露调试端口（可执行文件是否可用？）")
    }
    const ws = new WebSocket(wsUrl)
    const page = new CdpPage(proc, ws, userDataDir)
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage
      if (msg.id === undefined) return
      const entry = page.pending.get(msg.id)
      if (!entry) return
      page.pending.delete(msg.id)
      const ex = msg.result?.exceptionDetails
      if (ex) entry.reject(new Error(ex.exception?.description ?? ex.text ?? "页面执行出错"))
      else entry.resolve(msg.result?.result?.value)
    })
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve())
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")))
    })
    return page
  }

  /** 在页面里求值（默认等待 Promise 并回传值）。 */
  async evaluate<T>(expression: string, timeoutMs = 180_000): Promise<T> {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`页面求值超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })
    this.ws.send(payload)
    return result
  }

  /** 轮询等待条件成立（等价于 waitForFunction）。 */
  async waitFor(expression: string, timeoutMs: number, intervalMs = 50): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.evaluate<boolean>(`!!(${expression})`, timeoutMs)) return
      if (Date.now() > deadline) throw new Error(`等待条件超时（${timeoutMs}ms）：${expression.slice(0, 80)}`)
      await Bun.sleep(intervalMs)
    }
  }

  async close(): Promise<void> {
    try {
      this.ws.close()
    } catch {
      /* 已断开 */
    }
    this.proc.kill()
    await Bun.sleep(100)
    rmSync(this.userDataDir, { recursive: true, force: true })
  }
}

/** CDP 临时目录（浏览器 profile）：落在 state 下的独立子目录，调用方收尾删除。 */
export async function closeBrowserPool(): Promise<void> {
  // 浏览器按次启动、渲染结束即关闭（见 runBrowserRender 的 finally）——保留此钩子供测试与收尾调用。
  await Promise.resolve()
}

// ───────────────────────────── 静态服务与帧封装 ─────────────────────────────

const MIME_TYPES: Array<[RegExp, string]> = [
  [/\.html?$/, "text/html"],
  [/\.m?js$/, "text/javascript"],
  [/\.css$/, "text/css"],
  [/\.json$/, "application/json"],
  [/\.png$/, "image/png"],
  [/\.jpe?g$/, "image/jpeg"],
  [/\.woff2?$/, "font/woff2"],
  [/\.(mp3|m4a|aac|wav|ogg)$/, "audio/mpeg"],
  [/\.mp4$/, "video/mp4"],
]
const mimeFor = (path: string): string => MIME_TYPES.find(([re]) => re.test(path))?.[1] ?? "application/octet-stream"

/** 只读静态服务把 bundle 喂给浏览器；`POST /__gebai/chunk` 接编码帧（边产边推，不在页面里堆积）。 */
function serveBundle(serveUrl: string, onChunk: (buf: Buffer) => void): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const pathname = new URL(req.url).pathname
      if (req.method === "POST" && pathname === "/__gebai/chunk") {
        onChunk(Buffer.from(await req.arrayBuffer()))
        return new Response("ok")
      }
      const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1))
      if (rel.includes("..")) return new Response("bad request", { status: 400 })
      const file = Bun.file(join(serveUrl, rel))
      if (!(await file.exists())) return new Response("not found", { status: 404 })
      return new Response(file, { headers: { "content-type": mimeFor(rel) } })
    },
  })
  return { port: server.port ?? 0, stop: () => server.stop(true) }
}

/** 帧段（含端点、可到片尾）——与 Remotion 同口径。 */
export function resolveFrameSpan(comp: VideoConfig, range?: [number, number | null] | null): [number, number] {
  const start = range ? Math.max(0, range[0]) : 0
  const end = !range || range[1] === null ? comp.durationInFrames - 1 : Math.min(range[1], comp.durationInFrames - 1)
  return [start, Math.max(start, end)]
}

// ───────────────────────────── 主流程 ─────────────────────────────

export async function runBrowserRender(args: BrowserRenderArgs): Promise<BrowserRenderResult> {
  if (!args.browserExecutable) {
    throw new Error("浏览器通道需要明确的可执行文件路径（先 reel_setup 确认浏览器就绪，或传 chrome_executable）")
  }
  // 空合成先报清楚：帧段钳制会把 durationInFrames=0 掩盖成 1 帧，那样会静默产出空片
  if (args.composition.durationInFrames <= 0) {
    throw new Error(
      `合成 ${args.composition.id} 没有任何帧（durationInFrames=${args.composition.durationInFrames}）——检查工程的 timeline 与 Composition 定义`,
    )
  }
  const [start, end] = resolveFrameSpan(args.composition, args.frameRange)
  const total = end - start + 1
  if (total <= 0) throw new Error("帧段为空")

  const chunks: Buffer[] = []
  const server = serveBundle(args.serveUrl, (buf) => chunks.push(buf))
  const workDir = join(stateDir(args.ctx), "browser-render", `${args.backend}-${Date.now().toString(36)}`)
  const userDataDir = join(workDir, "profile")
  mkdirSync(workDir, { recursive: true })
  const rawPath = join(workDir, args.backend === "record" ? "recorded.bin" : "stream.h264")
  const ffmpeg = resolveShardFfmpeg({ roots: [runtimeDir(args.ctx)] })
  if (!ffmpeg) throw new Error("浏览器通道封容器需要 ffmpeg：未在运行时依赖里找到（先 reel_project action=install）")

  const comp = args.composition
  let page: CdpPage | null = null
  try {
    page = await CdpPage.launch({
      executable: args.browserExecutable,
      args: [CANVAS_DRAW_ELEMENT_FLAG],
      url: `http://127.0.0.1:${server.port}/`,
      width: args.width,
      height: args.height,
      userDataDir,
    })
    args.log(`浏览器通道就绪：${args.backend} · ${args.width}×${args.height} · ${total} 帧`)

    await page.waitFor("document.readyState === 'complete'", 120_000)
    const contract = await page.evaluate<{ mode: string; frame: string }>(
      "({ mode: typeof window.remotion_setBundleMode, frame: typeof window.remotion_setFrame })",
    )
    if (contract.mode !== "function" || contract.frame !== "function") {
      throw new Error(
        `bundle 未暴露自驱帧契约（remotion_setBundleMode=${contract.mode} / remotion_setFrame=${contract.frame}）——请改用 backend=remotion`,
      )
    }

    // 切渲染模式：省掉这一步 setFrame 会静默失效（页面停在初始画面）
    await page.evaluate(
      `window.remotion_setBundleMode({ type: "composition", compositionName: ${JSON.stringify(comp.id)}, ` +
        `serializedResolvedPropsWithSchema: "{}", compositionDurationInFrames: ${comp.durationInFrames}, ` +
        `compositionFps: ${comp.fps}, compositionHeight: ${comp.height}, compositionWidth: ${comp.width}, compositionDefaultCodec: "h264" })`,
    )
    await page.waitFor("window.remotion_renderReady === true", 120_000)

    // —— 捕获/编码准备（页面内） ——
    const setup = await page.evaluate<{ ok: boolean; reason?: string }>(
      `(async () => {
        const W = ${args.width}, H = ${args.height}, backend = ${JSON.stringify(args.backend)}
        document.body.style.margin = "0"
        document.body.style.background = "#000"
        document.body.style.overflow = "hidden"
        const canvas = document.createElement("canvas")
        canvas.width = W; canvas.height = H
        canvas.style.position = "fixed"; canvas.style.left = "0"; canvas.style.top = "0"
        canvas.style.width = W + "px"; canvas.style.height = H + "px"
        const state = { canvas, pendingFetches: 0, bytes: 0 }
        window.__gebai = state
        {
          const ctx = canvas.getContext("2d")
          if (!ctx || typeof ctx.drawElementImage !== "function") {
            return { ok: false, reason: "drawElementImage 不可用（浏览器需以 ${CANVAS_DRAW_ELEMENT_FLAG} 启动）" }
          }
          if (!("layoutSubtree" in canvas)) return { ok: false, reason: "该浏览器不支持 canvas layoutsubtree（需较新 Chrome）" }
          if (typeof canvas.requestPaint !== "function") return { ok: false, reason: "该浏览器不支持 canvas.requestPaint（layoutsubtree 未生效）" }
          // 找舞台容器：bundle 页面里没有 #root（body 前几个子节点是 script），
          // 合成渲染在 #video-container 里——抓错元素会报 "No cached paint record for element"。
          const candidates = [
            document.getElementById("video-container"),
            document.getElementById("root"),
            ...Array.from(document.body.children),
          ]
          const root = candidates.find((el) => {
            if (!el || el === canvas) return false
            const tag = el.tagName
            if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "META") return false
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          }) || undefined
          if (!root) return { ok: false, reason: "未找到可捕获的舞台容器（bundle 页面结构异常）" }
          // 顺序与 @remotion/web-renderer 的 setupHtmlInCanvas 一致：建 canvas → 开 layoutSubtree →
          // 把舞台移进去 → **最后**才把 canvas 插入文档。反过来（先插空 canvas 再移元素）不会建立
          // layout 绘制记录，drawElementImage 会报 "No cached paint record for element"。
          canvas.layoutSubtree = true
          const parent = root.parentElement ?? document.body
          parent.removeChild(root)
          canvas.appendChild(root)
          root.style.position = "absolute"; root.style.left = "0"; root.style.top = "0"
          parent.appendChild(canvas)
          // 主动触发一次绘制并等 paint 事件，把 layout 子树的首个绘制记录建立起来
          await new Promise((resolve) => {
            let done = false
            const finish = () => { if (!done) { done = true; resolve() } }
            canvas.addEventListener("paint", finish, { once: true })
            canvas.requestPaint()
            setTimeout(finish, 1000)
          })
          // 两种通道都走 DOM 直捕（抓帧方式相同，只差编码）：record 也必须先把画面画进 canvas——
          // **从未绘制过的 canvas 不产帧**（MediaRecorder 会拿到空产物，实测踩过）。
          if (backend === "dom-canvas") {
            const enc = new VideoEncoder({
              output: (chunk) => {
                const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf)
                state.pendingFetches++; state.bytes += buf.byteLength
                fetch("/__gebai/chunk", { method: "POST", body: buf }).finally(() => { state.pendingFetches-- })
              },
              error: (e) => { state.error = String(e) },
            })
            enc.configure({ codec: "avc1.640028", width: W, height: H, bitrate: 8000000, framerate: 30, avc: { format: "annexb" } })
            state.enc = enc
          } else {
            const stream = canvas.captureStream(0)
            const track = stream.getVideoTracks()[0]
            const mime = "video/mp4;codecs=avc1.640028"
            const useMime = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mime)
            const rec = new MediaRecorder(stream, useMime ? { mimeType: mime, videoBitsPerSecond: 8000000 } : { videoBitsPerSecond: 8000000 })
            const parts = []
            rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
            state.rec = rec; state.parts = parts; state.track = track
          }
          state.ctx = ctx; state.root = root
          return { ok: true }
        }
      })()`,
    )
    if (!setup.ok) throw new Error(setup.reason ?? "捕获准备失败")

    if (args.backend === "record") {
      await page.evaluate("(window.__gebai.rec.start(), true)")
      args.log("实时录制开始：耗时≈片长（录制不可能快于实时），时序跟墙钟且不可复现")
    }

    const frameMs = 1000 / args.fps
    let captureMs = 0
    const t0 = Date.now()
    for (let f = start; f <= end; f++) {
      if (args.shouldStop?.()) throw new Error("渲染已取消")
      await page.evaluate(`(window.remotion_setFrame(${f}, ${JSON.stringify(comp.id)}, 0), true)`)
      await page.waitFor("window.remotion_renderReady === true", 120_000)
      await page.evaluate("document.fonts.ready.then(() => true)")
      const frameStarted = Date.now()
      const cap = await page.evaluate<{ ms: number }>(
        `(async () => {
          const st = window.__gebai, t = performance.now()
          // 两种通道都先抓帧（record 必须把画面画进 canvas 才有帧可录），只差编码那一步
          await new Promise((resolve) => {
            let done = false
            const finish = () => { if (!done) { done = true; resolve() } }
            st.canvas.addEventListener("paint", finish, { once: true })
            st.canvas.requestPaint && st.canvas.requestPaint()
            setTimeout(finish, 300)
          })
          st.ctx.drawElementImage(st.root, 0, 0, st.canvas.width, st.canvas.height)
          if (${JSON.stringify(args.backend)} === "record") {
            st.track.requestFrame()
            return { ms: performance.now() - t }
          }
          const vf = new VideoFrame(st.canvas, { timestamp: Math.round(${f} * 1000000 / ${args.fps}), duration: Math.round(1000000 / ${args.fps}) })
          st.enc.encode(vf, { keyFrame: ${f} % ${args.fps} === 0 })
          vf.close()
          return { ms: performance.now() - t }
        })()`,
      )
      captureMs += cap.ms
      if (args.backend === "record") {
        const elapsed = Date.now() - frameStarted
        if (elapsed < frameMs) await Bun.sleep(frameMs - elapsed)
      }
      args.onProgress?.(f - start + 1, total)
    }

    // —— 收尾：取回码流 ——
    if (args.backend === "record") {
      await page.evaluate(
        `(async () => {
          const st = window.__gebai
          await new Promise((resolve) => { st.rec.onstop = () => resolve(); setTimeout(() => st.rec.stop(), 300) })
          const blob = new Blob(st.parts, { type: st.rec.mimeType || "video/webm" })
          await fetch("/__gebai/chunk", { method: "POST", body: blob })
          st.parts = []
          return true
        })()`,
      )
    } else {
      const flushed = await page.evaluate<{ error: string | null; pending: number; bytes: number }>(
        `(async () => {
          const st = window.__gebai
          await st.enc.flush(); st.enc.close()
          for (let i = 0; i < 600 && st.pendingFetches > 0; i++) await new Promise((r) => setTimeout(r, 25))
          return { error: st.error || null, pending: st.pendingFetches, bytes: st.bytes }
        })()`,
      )
      if (flushed.error) throw new Error(`浏览器编码失败：${flushed.error}`)
      if (flushed.pending > 0) args.log(`⚠ 仍有 ${flushed.pending} 帧未回传完成，产物可能不完整`)
    }

    const stream = Buffer.concat(chunks)
    if (!stream.length) throw new Error("浏览器未产出任何码流（编码器可能未启动）")
    writeFileSync(rawPath, stream)

    // Annex-B 裸流 vs 自带容器：靠 ISO BMFF 的 ftyp 盒判定
    const isIso = stream.subarray(4, 8).toString("latin1") === "ftyp"
    const container = args.backend === "record" ? (isIso ? "mp4" : "webm") : "mp4"
    const muxArgs = isIso
      ? ["-y", "-i", rawPath, "-c", "copy", "-movflags", "+faststart", args.output]
      : ["-y", "-f", "h264", "-r", String(args.fps), "-i", rawPath, "-c", "copy", "-movflags", "+faststart", args.output]
    const mux = Bun.spawnSync([ffmpeg, "-hide_banner", "-loglevel", "error", ...muxArgs])
    if (mux.exitCode !== 0) throw new Error(`封装失败（ffmpeg exit ${mux.exitCode}）：${mux.stderr.toString().slice(0, 300)}`)

    args.log(
      `浏览器通道完成：${total} 帧 / ${((Date.now() - t0) / 1000).toFixed(1)}s · 抓帧均 ${(captureMs / total).toFixed(1)}ms · 码流 ${stream.length} 字节 → ${args.output}（${container}）`,
    )
    if (args.backend === "record") {
      // 录制只能拿到「抓帧循环实际跑多快」的帧率，拿不到也不假装：低于合成 fps 时产物会变成慢放
      const effectiveFps = total / ((Date.now() - t0) / 1000)
      args.log(
        effectiveFps < args.fps * 0.9
          ? `⚠ 实时录制有效帧率 ${effectiveFps.toFixed(1)} fps < 合成 ${args.fps} fps：产物时长会拉长（≈${(args.fps / effectiveFps).toFixed(2)}× 慢放）——录制不适合交付，请用 backend=dom-canvas 或 remotion`
          : `实时录制有效帧率 ${effectiveFps.toFixed(1)} fps（接近合成 ${args.fps} fps）`,
      )
    }
    return { frames: total, streamBytes: stream.length, captureMsPerFrame: captureMs / total, container }
  } finally {
    if (page) await page.close().catch(() => undefined)
    server.stop()
    rmSync(workDir, { recursive: true, force: true })
  }
}
