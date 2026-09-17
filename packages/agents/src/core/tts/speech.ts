/**
 * 本机离线语音合成引擎（平台内置语音；零网络、零第三方依赖、零安装）。
 *
 * Windows 有两个系统语音栈：WinRT OneCore（Windows.Media.SpeechSynthesis，Windows 10+ 的标准，
 * 音质优于 SAPI5）优先，SAPI5（System.Speech）回退。两者都是系统组件、Bun 无绑定，故经 Windows
 * 自带的 PowerShell 5.1 调用。非 Windows 平台当前没有等价的内置离线引擎，如实报错而非改用联网服务。
 *
 * 三处工程细节（均由实机验证得出）：
 * - 脚本经 `-EncodedCommand`（UTF-16LE base64）传入：PowerShell 5.1 按系统 ANSI 代码页解码 `.ps1`
 *   文件，无 BOM 的中文脚本会解析失败——编码进命令行彻底规避，且不落脚本文件。
 * - 待合成文本与运行结果都走 UTF-8 文件：命令行与单个环境变量都有长度上限、且要处理引号转义；
 *   PowerShell 的 stderr 是 CLIXML、stdout 编码随宿主漂移——文件是唯一稳定的接口。
 * - 文本在 TS 侧完成 XML 转义：SSML 是 XML，`& < >` 与换行必须转义（脚本侧只做拼接）。
 * - SSML 必须带 `xml:lang`（缺失时 WinRT 直接报错），故语言随所选音色在脚本内确定。
 *
 * 本模块为**基建**（`core/tts/`）：执行通道经 TtsDeps 注入，故子Agent 工具（ToolContext）与
 * 服务端 REST 路由（朗读接口）共用同一份实现，不复制脚本与解析逻辑。
 */
import { join } from "node:path"

/** 子Agent 单次合成文本上限（字符）：音频体积与文本量成正比（约 32KB/秒 的 16kHz 16bit 单声道 WAV）。 */
export const TTS_MAX_TEXT = 4000
/** 长文本分片阈值：超过则分片合成后拼接 WAV（REST 朗读可读完整回复，不被单次上限截断）。 */
export const TTS_CHUNK_CHARS = 1500
/** 单次 REST 请求可接受的文本上限（字符）：再长请由调用方自行分段。 */
export const TTS_REQUEST_MAX_TEXT = 20000
/** 语速百分比范围（负慢正快）。 */
export const TTS_RATE = { min: -100, max: 200 } as const
/** 音调百分比范围（负低正高）。 */
export const TTS_PITCH = { min: -50, max: 50 } as const
/** 音量百分比范围。 */
export const TTS_VOLUME = { min: -100, max: 100 } as const
/** 单次脚本调用超时（毫秒）：4000 字实机约 2 秒，余量给慢机与首次 .NET 模块加载。 */
export const TTS_TIMEOUT_MS = 120_000
/** 子Agent 产物目录（会话工作区内相对路径）。 */
export const TTS_OUT_DIR = "tmp/tts"
/** 引擎名（auto=WinRT 优先 SAPI 回退）。 */
export const TTS_ENGINES = ["auto", "winrt", "sapi"] as const
export type TtsEngine = (typeof TTS_ENGINES)[number]

/** 非 Windows 平台（无内置离线引擎）的支持判定：平台可注入（用例不随宿主平台漂移）。 */
let platformOverride: string | undefined
/** 覆盖平台判定（测试注入；传 undefined 还原）。 */
export function setTtsPlatform(platform?: string): void {
  platformOverride = platform
}

export function isSupportedPlatform(platform?: string): boolean {
  return (platform ?? platformOverride ?? process.platform) === "win32"
}

export const UNSUPPORTED_PLATFORM_NOTE =
  "语音合成不可用：本机内置离线语音引擎仅 Windows 提供（WinRT OneCore / SAPI5 系统语音）。当前平台没有等价的内置引擎，本能力不做联网合成——如需可改用系统已安装的离线 TTS 命令行工具自行合成。"

/** 百分比参数归一：非数字回落 fallback，超范围钳制到边界（保证下发给引擎的值一定合法）。 */
export function clampPercent(value: unknown, range: { min: number; max: number }, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim())
  if (!Number.isFinite(n)) return fallback
  return Math.max(range.min, Math.min(range.max, Math.round(n)))
}

/** 百分比 → SSML prosody 取值（"+80%" / "-50%" / "+0%"）。 */
export function formatPercent(n: number): string {
  return `${n >= 0 ? "+" : "-"}${Math.abs(n)}%`
}

/** 引擎参数归一：未识别值回落 fallback（缺省 auto）。 */
export function normalizeEngine(value: unknown, fallback: TtsEngine = "auto"): TtsEngine {
  const v = String(value ?? "").trim().toLowerCase()
  return (TTS_ENGINES as readonly string[]).includes(v) ? (v as TtsEngine) : fallback
}

/** XML 文本转义（SSML 内容位）：& < > 与行分隔符——换行按字符引用写出，避免不同引擎对裸换行的处理差异。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "&#10;")
}

/** 文本可用性校验：返回错误说明或 null。 */
export function validateText(text: unknown, limit = TTS_MAX_TEXT): string | null {
  const s = typeof text === "string" ? text : ""
  if (!s.trim()) return "待合成文本为空（text 参数）。"
  if (s.length > limit) {
    return `文本过长（${s.length} 字符，上限 ${limit}）：请拆成多段分别合成（用 out 指定各自的产物文件），不要截断内容。`
  }
  return null
}

/** 子Agent 缺省产物路径（会话工作区内逻辑相对路径）。 */
export function defaultOutPath(ts: number): string {
  return `${TTS_OUT_DIR}/voice-${ts}.wav`
}

/** 时长展示（秒 → "1 分 23 秒" / "12 秒"）。 */
export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec))
  const min = Math.floor(total / 60)
  const rest = total % 60
  if (min <= 0) return `${rest} 秒`
  return rest === 0 ? `${min} 分` : `${min} 分 ${rest} 秒`
}

/** 字节数展示（1024 进制）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 按句子边界分片（长文本合成用）：优先在句末标点处断开，无标点长句退化为按空格、再退化为硬切；
 * 片内不切断 UTF-8 多字节字符（按码元切分即可——JS 字符串按码元索引，孤立的代理对不会产生非法 UTF-8，
 * 但为可读性仍在标点/空白处断开）。
 */
export function splitText(text: string, maxChars = TTS_CHUNK_CHARS): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]
  const boundary = /[。！？!?；;\n]/
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = -1
    for (let i = window.length - 1; i >= 0; i--) {
      if (boundary.test(window[i])) {
        cut = i + 1
        break
      }
    }
    if (cut <= 0) {
      const space = window.lastIndexOf(" ")
      cut = space > 0 ? space + 1 : window.length
    }
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest)
  return chunks.filter(Boolean)
}

interface WavLayout {
  /** data 块数据起始偏移。 */
  dataOffset: number
  dataSize: number
  /** RIFF 总长字段偏移（恒为 4）。 */
  riffSizeAt: number
  /** data 块长度字段偏移。 */
  dataSizeAt: number
  /** 格式签名（fmt 块原文，用于校验拼接兼容性）。 */
  fmt: string
}

function parseWavLayout(buf: Uint8Array): WavLayout | null {
  if (buf.byteLength < 44) return null
  const u32 = (at: number) => buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "RIFF") return null
  let pos = 12
  let fmt = ""
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3])
    const size = u32(pos + 4)
    if (id === "fmt ") fmt = Array.from(buf.slice(pos + 8, pos + 8 + Math.min(size, 16))).join(",")
    if (id === "data") {
      if (size <= 0 || pos + 8 + size > buf.byteLength) return null
      return { dataOffset: pos + 8, dataSize: size, riffSizeAt: 4, dataSizeAt: pos + 4, fmt }
    }
    pos += 8 + size + (size % 2)
  }
  return null
}

/**
 * WAV 拼接（长文本分片合成的收口）：同格式 PCM 直接串接 data 段并修正长度字段。
 * 分片格式不一致（采样率/位深/声道不同，理论上同引擎同参数不会发生）时返回 null，
 * 由调用方降级处理——不能默默拼出一条失真音频。
 */
export function concatWav(chunks: Uint8Array[]): Uint8Array | null {
  if (!chunks.length) return null
  if (chunks.length === 1) return chunks[0]
  const layouts = chunks.map(parseWavLayout)
  const first = layouts[0]
  if (!first || layouts.some((l) => !l)) return null
  if (layouts.some((l) => l!.fmt !== first.fmt)) return null
  const head = chunks[0].slice(0, first.dataOffset)
  const total = layouts.reduce((n, l) => n + l!.dataSize, 0)
  const out = new Uint8Array(head.byteLength + total)
  out.set(head, 0)
  let at = head.byteLength
  for (let i = 0; i < chunks.length; i++) {
    const l = layouts[i]!
    out.set(chunks[i].slice(l.dataOffset, l.dataOffset + l.dataSize), at)
    at += l.dataSize
  }
  const u32 = (v: number, arr: Uint8Array, offset: number) => {
    arr[offset] = v & 0xff
    arr[offset + 1] = (v >>> 8) & 0xff
    arr[offset + 2] = (v >>> 16) & 0xff
    arr[offset + 3] = (v >>> 24) & 0xff
  }
  u32(out.byteLength - 8, out, first.riffSizeAt)
  u32(total, out, first.dataSizeAt)
  return out
}

/** 脚本回传的音色条目。 */
export interface TtsVoice {
  name: string
  lang: string
  gender: string
  engine: string
}

/** 脚本回传结果（合成与音色枚举共用一个结果文件）。 */
export interface TtsScriptResult {
  ok: boolean
  error?: string
  engine?: string
  voice?: string
  lang?: string
  requested?: string
  bytes?: number
  sampleRate?: number
  durationSec?: number
  /** play 模式：派生出的播放进程 PID（播报在后台继续）。 */
  pid?: number
  voices?: TtsVoice[]
}

/** 结果 JSON 解析：字段缺失/类型不符按缺省处理，解析失败返回 null（调用方据此报脚本级失败）。 */
export function parseScriptResult(raw: string): TtsScriptResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const o = parsed as Record<string, unknown>
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)
  const voices = Array.isArray(o.voices)
    ? o.voices
        .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
        .map((v) => ({
          name: String(v.name ?? ""),
          lang: String(v.lang ?? ""),
          gender: String(v.gender ?? ""),
          engine: String(v.engine ?? ""),
        }))
        .filter((v) => v.name)
    : undefined
  return {
    ok: o.ok === true,
    error: str(o.error),
    engine: str(o.engine),
    voice: str(o.voice),
    lang: str(o.lang),
    requested: str(o.requested),
    bytes: num(o.bytes),
    sampleRate: num(o.sampleRate),
    durationSec: num(o.durationSec),
    pid: num(o.pid),
    voices,
  }
}

/** 音色关键词过滤（名称或语言，大小写不敏感）。 */
export function filterVoices(voices: TtsVoice[], find?: string): TtsVoice[] {
  const q = String(find ?? "").trim().toLowerCase()
  if (!q) return voices
  return voices.filter((v) => v.name.toLowerCase().includes(q) || v.lang.toLowerCase().includes(q))
}

/** 音色清单文本（每行一条，供模型挑选）。 */
export function formatVoiceList(voices: TtsVoice[]): string {
  return voices.map((v) => `- ${v.name}（${v.lang}${v.gender ? `，${v.gender}` : ""}）`).join("\n")
}

/** 请求音色与实际用到的音色不一致时的说明：引擎按精确/包含匹配选音色，两者都不命中才回落默认——
 *  包含命中（如「Kangkang」→「Microsoft Kangkang」）不算回落，无需提示。 */
export function voiceMismatchNote(requested?: string, actual?: string): string | null {
  if (!requested || !actual) return null
  const req = requested.trim().toLowerCase()
  if (!req) return null
  const act = actual.toLowerCase()
  if (act === req || act.includes(req)) return null
  return `未找到音色「${requested}」，已回落到本机默认音色「${actual}」——可用 tts_voices 查看可选音色。`
}

/** 播报可用性判定：播报作用于**运行 GEBAI 这台机器**的音频设备——服务端部署下那是服务器，
 *  会给同机其他人造成无人意料的噪音，故仅在本地模式提供（浏览器/桌面形态）。返回拒绝原因或 null。 */
export function playbackBlockedReason(ctx: { authMode?: string; sandboxed?: boolean }): string | null {
  if (ctx.authMode === "server" || ctx.sandboxed === true) {
    return "未在本机扬声器播报：该能力仅本地模式可用（服务端部署下播报的是服务器机器的音频设备，会干扰同机其他用户）——产物已落盘，可下载后自行播放。"
  }
  return null
}

/**
 * 合成/枚举脚本（PowerShell 5.1，经 -EncodedCommand 执行）。
 * 入参全走环境变量（GEBAI_TTS_*），文本与结果走文件；不使用 `${}` 语法与反引号（避免与宿主模板串冲突）。
 */
export const TTS_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$mode = $env:GEBAI_TTS_MODE
$enginePref = $env:GEBAI_TTS_ENGINE
$resultPath = $env:GEBAI_TTS_RESULT

function Write-Result($data) {
  $json = $data | ConvertTo-Json -Depth 6 -Compress
  [IO.File]::WriteAllText($resultPath, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-WinRtVoices {
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
    $list = @()
    foreach ($v in [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices) {
      $list += @{ name = [string]$v.DisplayName; lang = [string]$v.Language; gender = [string]$v.Gender; engine = 'winrt' }
    }
    return ,$list
  } catch {
    return ,@()
  }
}

function Get-SapiVoices {
  try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $list = @()
    foreach ($v in $synth.GetInstalledVoices()) {
      if (-not $v.Enabled) { continue }
      $list += @{ name = [string]$v.VoiceInfo.Name; lang = [string]$v.VoiceInfo.Culture.Name; gender = [string]$v.VoiceInfo.Gender; engine = 'sapi' }
    }
    $synth.Dispose()
    return ,$list
  } catch {
    return ,@()
  }
}

function Select-Voice($voices, $want) {
  if ($want) {
    $exact = @($voices | Where-Object { $_.name -eq $want })
    if ($exact.Count -gt 0) { return $exact[0] }
    $loose = @($voices | Where-Object { $_.name.ToLower().Contains($want.ToLower()) })
    if ($loose.Count -gt 0) { return $loose[0] }
  }
  $preferred = @($voices | Where-Object { $_.lang -like 'zh*' })
  if ($preferred.Count -gt 0) { return $preferred[0] }
  if ($voices.Count -gt 0) { return $voices[0] }
  return $null
}

function Read-WavInfo($path) {
  $fs = [IO.File]::OpenRead($path)
  try {
    $len = $fs.Length
    $br = New-Object IO.BinaryReader($fs)
    $null = $br.ReadBytes(4)
    $null = $br.ReadInt32()
    $null = $br.ReadBytes(4)
    $sampleRate = 0; $channels = 0; $bits = 0; $dataSize = 0
    while ($fs.Position + 8 -le $len) {
      $id = [Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
      $size = $br.ReadInt32()
      if ($id -eq 'fmt ') {
        $null = $br.ReadInt16()
        $channels = $br.ReadInt16()
        $sampleRate = $br.ReadInt32()
        $null = $br.ReadInt32()
        $null = $br.ReadInt16()
        $bits = $br.ReadInt16()
        $rest = $size - 16
        if ($rest -gt 0) { $null = $br.ReadBytes($rest) }
      } elseif ($id -eq 'data') {
        $dataSize = $size
        break
      } else {
        $null = $br.ReadBytes($size)
      }
      if ($size % 2 -ne 0) { $null = $br.ReadByte() }
    }
    $dur = 0.0
    if ($sampleRate -gt 0 -and $channels -gt 0 -and $bits -gt 0 -and $dataSize -gt 0) {
      $dur = [Math]::Round($dataSize / ($sampleRate * $channels * ($bits / 8.0)), 2)
    }
    return @{ sampleRate = $sampleRate; durationSec = $dur }
  } finally {
    $fs.Close()
  }
}

try {
  $winrtVoices = @()
  $sapiVoices = @()
  if ($enginePref -ne 'sapi') { $winrtVoices = Get-WinRtVoices }
  if ($winrtVoices.Count -gt 0) {
    $active = 'winrt'
  } elseif ($enginePref -ne 'winrt') {
    $sapiVoices = Get-SapiVoices
    $active = ''
    if ($sapiVoices.Count -gt 0) { $active = 'sapi' }
  } else {
    $active = ''
  }

  if ($active -eq '') {
    Write-Result @{ ok = $false; error = 'no-engine' }
    exit 0
  }

  if ($mode -eq 'voices') {
    $voices = $winrtVoices
    if ($active -eq 'sapi') { $voices = $sapiVoices }
    Write-Result @{ ok = $true; engine = $active; voices = @($voices) }
    exit 0
  }

  $voices = $winrtVoices
  if ($active -eq 'sapi') { $voices = $sapiVoices }
  $voice = Select-Voice $voices $env:GEBAI_TTS_VOICE
  if ($null -eq $voice) {
    Write-Result @{ ok = $false; error = 'no-voice' }
    exit 0
  }

  $text = [IO.File]::ReadAllText($env:GEBAI_TTS_TEXT, [Text.Encoding]::UTF8)
  $out = $env:GEBAI_TTS_OUT
  $prosody = " rate='" + $env:GEBAI_TTS_RATE + "' pitch='" + $env:GEBAI_TTS_PITCH + "' volume='" + $env:GEBAI_TTS_VOLUME + "'"
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + $voice.lang + "'>"

  if ($active -eq 'winrt') {
    $ssml += "<voice name='" + $voice.name + "'><prosody" + $prosody + ">" + $text + "</prosody></voice></speak>"
    $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
    $target = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $voice.name })
    if ($target.Count -gt 0) { $synth.Voice = $target[0] }
    $gen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
    $asTask = $gen.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $task = $asTask.Invoke($null, @($synth.SynthesizeSsmlToStreamAsync($ssml)))
    $task.Wait(-1) | Out-Null
    $stream = $task.Result
    $size = [int]$stream.Size
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $asTaskU32 = $gen.MakeGenericMethod([uint32])
    $loadTask = $asTaskU32.Invoke($null, @($reader.LoadAsync([uint32]$size)))
    $loadTask.Wait(-1) | Out-Null
    $buf = New-Object byte[] $size
    $reader.ReadBytes($buf)
    [IO.File]::WriteAllBytes($out, $buf)
  } else {
    $ssml += "<prosody" + $prosody + ">" + $text + "</prosody></speak>"
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.SelectVoice($voice.name)
    $synth.SetOutputToWaveFile($out)
    $synth.SpeakSsml($ssml)
    $synth.Dispose()
  }

  $info = Read-WavInfo $out
  Write-Result @{
    ok = $true
    engine = $active
    voice = $voice.name
    lang = $voice.lang
    requested = $env:GEBAI_TTS_VOICE
    bytes = (Get-Item $out).Length
    sampleRate = $info.sampleRate
    durationSec = $info.durationSec
  }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
}
`

/**
 * 播报脚本（`play` 参数）：把已合成的 WAV 送到**运行 GEBAI 这台机器**的默认音频设备（离线、不联网）。
 *  经 Start-Process 派生独立的隐藏播放进程后立即返回——播报不阻塞工具返回（长文本可播十几分钟），
 *  也避免父进程退出时打断声音。
 */
export const TTS_PLAY_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$wav = $env:GEBAI_TTS_WAV
$resultPath = $env:GEBAI_TTS_RESULT

function Write-Result($data) {
  $json = $data | ConvertTo-Json -Depth 6 -Compress
  [IO.File]::WriteAllText($resultPath, $json, (New-Object Text.UTF8Encoding($false)))
}

try {
  if (-not (Test-Path $wav)) {
    Write-Result @{ ok = $false; error = 'no-audio' }
    exit 0
  }
  $quoted = $wav.Replace("'", "''")
  $inner = "Add-Type -AssemblyName System; (New-Object System.Media.SoundPlayer '" + $quoted + "').PlaySync()"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
  $proc = Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $b64 -WindowStyle Hidden -PassThru
  Write-Result @{ ok = $true; pid = $proc.Id }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
}
`

/** 脚本 → PowerShell `-EncodedCommand` 参数（UTF-16LE base64）。 */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

/**
 * 引擎执行通道（注入）：子Agent 工具传 ToolContext 的对应方法，服务端 REST 路由传进程级实现——
 * 同一份脚本与解析逻辑因此被两条链路共用。
 */
export interface TtsDeps {
  runCommand: (
    cmd: string,
    opts?: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<{ stdout: string; stderr: string; code: number }>
  readFile: (p: string) => Promise<string>
  /** 写文件（父目录不存在时须自动创建）。 */
  writeFile: (p: string, content: string) => Promise<void>
  /** 删除文件（不存在时不抛错）。 */
  deleteFile: (p: string) => Promise<void>
  /** 临时文件目录（绝对路径）：已转义文本与结果 JSON 在此进、用后即删。 */
  tmpDir: string
  signal?: AbortSignal
}

/** 脚本执行的入参（synth 模式的文本须已 XML 转义、百分比已格式化）。 */
export interface TtsRunInput {
  mode: "voices" | "synth" | "play"
  engine: TtsEngine
  /** synth 模式：已 XML 转义的文本。 */
  text?: string
  voice?: string
  rate?: number
  pitch?: number
  volume?: number
  /** synth 模式：产物绝对路径。 */
  out?: string
  /** play 模式：待播报的 WAV 绝对路径。 */
  wav?: string
}

/** 脚本执行结果（结果文件缺失/损坏时 result 为 null，调用方按脚本级失败处理）。 */
export interface TtsRunOutput {
  result: TtsScriptResult | null
  stderr: string
  code: number
}

/**
 * 运行脚本：临时文件（已转义文本、结果 JSON）写 deps.tmpDir，无论成败都在 finally 清理，
 * 只留产物音频。取消/超时由 runCommand 的 signal/timeoutMs 承担（返回码 124）。
 */
export async function runTtsScript(deps: TtsDeps, input: TtsRunInput): Promise<TtsRunOutput> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const textPath = join(deps.tmpDir, `.text-${stamp}.txt`)
  const resultPath = join(deps.tmpDir, `.result-${stamp}.json`)
  if (input.mode === "synth") await deps.writeFile(textPath, input.text ?? "")
  try {
    const script = input.mode === "play" ? TTS_PLAY_SCRIPT : TTS_SCRIPT
    const res = await deps.runCommand(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`, {
      env: {
        GEBAI_TTS_MODE: input.mode,
        GEBAI_TTS_ENGINE: input.engine,
        GEBAI_TTS_RESULT: resultPath,
        GEBAI_TTS_TEXT: input.mode === "synth" ? textPath : "",
        GEBAI_TTS_VOICE: input.voice ?? "",
        GEBAI_TTS_OUT: input.out ?? "",
        GEBAI_TTS_WAV: input.wav ?? "",
        GEBAI_TTS_RATE: formatPercent(input.rate ?? 0),
        GEBAI_TTS_PITCH: formatPercent(input.pitch ?? 0),
        GEBAI_TTS_VOLUME: formatPercent(input.volume ?? 0),
      },
      timeoutMs: TTS_TIMEOUT_MS,
      signal: deps.signal,
    })
    let result: TtsScriptResult | null = null
    try {
      result = parseScriptResult(await deps.readFile(resultPath))
    } catch {
      result = null
    }
    return { result, stderr: res.stderr, code: res.code }
  } finally {
    await deps.deleteFile(textPath).catch(() => {})
    await deps.deleteFile(resultPath).catch(() => {})
  }
}

/** 脚本级失败的说明文案（结果文件缺失/损坏、超时取消、引擎缺失分别给出可执行指引）。 */
export function scriptFailureNote(run: TtsRunOutput, engine: TtsEngine): string {
  const err = run.result?.error
  if (err === "no-engine") {
    return engine === "winrt"
      ? "语音合成不可用：本机 WinRT 系统语音不可用（指定 engine=winrt 时不回退 SAPI）。可改用 engine=auto 或 engine=sapi 复用 SAPI5 语音。"
      : "语音合成不可用：未检测到本机离线语音引擎（WinRT OneCore 与 SAPI5 均不可用）。"
  }
  if (err === "no-audio") return "播报失败：产物音频不存在（合成与播报之间文件被移走或删除）。"
  if (err === "no-voice") return "语音合成失败：本机没有可用音色。"
  if (err) return `语音合成失败（系统语音引擎报错）: ${err}`
  if (run.code === 124) {
    return run.stderr.includes("[interrupted by user]")
      ? "语音合成已取消（任务被中止）。"
      : `语音合成超时（${Math.round(TTS_TIMEOUT_MS / 1000)} 秒）：文本过长或系统语音引擎无响应，可缩短文本后重试。`
  }
  if (run.code !== 0) {
    const detail = run.stderr.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
    return `语音合成失败（脚本退出码 ${run.code}）${detail ? `: ${detail}` : ""}`
  }
  return "语音合成失败：系统语音引擎未返回结果（未产出音频）。"
}

/**
 * 朗读文本净化：助手回复是 markdown 原文，直接送合成会把标记逐字读出来（「星号星号加粗星号星号」）。
 * 本函数把 markdown 转成「读出来的样子」——与 tts 子Agent 提示词里要求模型做的口语化整理同口径，
 * 但这里由代码保证（自动朗读路径的文本由消息正文直接给出，没有模型介入整理的机会）。
 *
 * 取舍：代码块整体丢弃（朗读代码是噪音，用户看得到原文）；行内代码保留内容（`bun test` 这类短语有信息量）；
 * 表格按单元格以顿号分隔（表格结构无法用语音表达）；链接只读文字、图片只读替代文本。
 */
export function plainTextForSpeech(markdown: string): string {
  let text = String(markdown ?? "")
  // 转义字符先还原（\* 不是强调分隔符），再处理强调标记——顺序反了会把转义星号当分隔符吞掉
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
  // 代码块（含缩进式）：整体丢弃
  text = text.replace(/```[\s\S]*?```/g, " ")
  text = text.replace(/^(?: {4}|\t)[^\n]*$/gm, " ")
  // 图片 → 替代文本；链接 → 链接文字
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  // 行内代码：保留内容
  text = text.replace(/`([^`]+)`/g, "$1")
  // 强调 / 删除线标记
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2")
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, "$2")
  text = text.replace(/~~(.*?)~~/g, "$1")
  // 水平线整行丢弃
  text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
  // 标题 / 引用 / 列表标记
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "")
  text = text.replace(/^\s{0,3}>\s?/gm, "")
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/gm, "")
  // 表格：只留单元格文字，按顿号连接
  text = text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed.includes("|")) return line
      if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed)) return " " // 分隔行
      return trimmed
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join("、")
    })
    .join("\n")
  // HTML 标签与残留转义
  text = text.replace(/<[^>]+>/g, " ")
  // 空白归一：先清行首尾空白（含只剩空格的占位行，如被丢弃的代码块/表格分隔行留下的），再用单换行分段
  text = text.replace(/[ \t]+/g, " ")
  text = text.replace(/ *\n */g, "\n")
  text = text.replace(/\n{2,}/g, "\n").trim()
  return text
}
