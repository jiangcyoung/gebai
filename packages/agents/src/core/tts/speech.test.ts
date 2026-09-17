/**
 * 语音合成基建（core/tts）用例：分片与 WAV 拼接的纯函数覆盖，以及脚本执行通道的临时目录保证
 * （零网络、零外部依赖）。子Agent 工具契约与失败文案的用例在 agents/tts/tts.test.ts（同一实现的工具侧）。
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { TTS_CHUNK_CHARS, concatWav, plainTextForSpeech, runTtsScript, splitText, type TtsDeps } from "./speech"

/** 构造最小合法 PCM WAV（16bit 单声道）。 */
function makeWav(samples: number, sampleRate = 16000): Uint8Array {
  const dataSize = samples * 2
  const buf = new Uint8Array(44 + dataSize)
  const dv = new DataView(buf.buffer)
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i)
  }
  str(0, "RIFF")
  dv.setUint32(4, 36 + dataSize, true)
  str(8, "WAVE")
  str(12, "fmt ")
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  str(36, "data")
  dv.setUint32(40, dataSize, true)
  for (let i = 0; i < samples; i++) dv.setInt16(44 + i * 2, (i % 200) - 100, true)
  return buf
}

const u32 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)

describe("splitText（长文本分片）", () => {
  test("短文本与空白：单片段 / 空结果", () => {
    expect(splitText("你好")).toEqual(["你好"])
    expect(splitText("")).toEqual([])
    expect(splitText("   \n ")).toEqual([])
    expect(splitText("x".repeat(TTS_CHUNK_CHARS))).toEqual(["x".repeat(TTS_CHUNK_CHARS)])
  })

  test("按句末标点断开，每片不超过上限且内容不丢", () => {
    const sentence = "这是一句话。"
    const text = sentence.repeat(600) // 3600 字 > 1500
    const chunks = splitText(text, 1500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500)
    expect(chunks.join("")).toBe(text)
    // 片尾落在句末标点上（可读性：不在句中截断）
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("。")).toBe(true)
  })

  test("无标点长句：退化为按空格，再退化为硬切", () => {
    const words = Array.from({ length: 200 }, () => "word").join(" ") // 999 字
    const bySpace = splitText(words, 100)
    expect(bySpace.length).toBeGreaterThan(1)
    expect(bySpace.join(" ").replace(/\s+/g, " ").trim()).toBe(words.replace(/\s+/g, " ").trim())

    const hard = splitText("啊".repeat(250), 100)
    expect(hard).toEqual(["啊".repeat(100), "啊".repeat(100), "啊".repeat(50)])
  })

  test("分片后各片首尾无冗余空白", () => {
    const text = "第一句。" + " ".repeat(50) + "第二句。" + " ".repeat(50) + "第三句。"
    for (const c of splitText(text, 10)) expect(c).toBe(c.trim())
  })
})

describe("plainTextForSpeech（markdown → 朗读文本）", () => {
  test("强调/标题/列表/引用标记不发音", () => {
    expect(plainTextForSpeech("**加粗**与*斜体*")) .toBe("加粗与斜体")
    expect(plainTextForSpeech("## 小节标题")).toBe("小节标题")
    expect(plainTextForSpeech("- 第一项\n- 第二项")).toBe("第一项\n第二项")
    expect(plainTextForSpeech("> 引用内容")).toBe("引用内容")
    expect(plainTextForSpeech("~~删除线~~")).toBe("删除线")
    expect(plainTextForSpeech("1. 有序项")).toBe("有序项")
  })

  test("代码块整体丢弃、行内代码保留内容", () => {
    expect(plainTextForSpeech("前文\n```ts\nconst a = 1\n```\n后文")).toBe("前文\n后文")
    expect(plainTextForSpeech("运行 `bun test` 即可")).toBe("运行 bun test 即可")
  })

  test("链接读文字、图片读替代文本", () => {
    expect(plainTextForSpeech("见 [文档](https://example.com/a.md) 说明")).toBe("见 文档 说明")
    expect(plainTextForSpeech("![架构图](https://example.com/a.png)")).toBe("架构图")
  })

  test("表格拆为顿号分隔、分隔行丢弃", () => {
    const md = "| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |"
    expect(plainTextForSpeech(md)).toBe("名称、值\n甲、1")
  })

  test("HTML 标签丢弃；转义星号不当强调分隔符（还原后标记不入正文）", () => {
    expect(plainTextForSpeech("<br>文本")).toBe("文本")
    expect(plainTextForSpeech("\\*不是斜体\\*")).toBe("不是斜体")
    expect(plainTextForSpeech("---")).toBe("")
  })

  test("纯文本与空白输入原样/归一", () => {
    expect(plainTextForSpeech("普通的一段话。")).toBe("普通的一段话。")
    expect(plainTextForSpeech("")).toBe("")
    expect(plainTextForSpeech("a\n\n\n\nb")).toBe("a\nb")
  })
})

describe("concatWav（分片音频拼接）", () => {
  test("单块原样返回（不复制、不改写）", () => {
    const a = makeWav(100)
    expect(concatWav([a])).toBe(a)
  })

  test("两块拼接：数据串接、RIFF 与 data 长度字段修正", () => {
    const a = makeWav(100)
    const b = makeWav(50)
    const out = concatWav([a, b])
    expect(out).not.toBeNull()
    const o = out as Uint8Array
    expect(o.byteLength).toBe(44 + 100 * 2 + 50 * 2)
    expect(u32(o, 4)).toBe(o.byteLength - 8)
    expect(u32(o, 40)).toBe(100 * 2 + 50 * 2)
    // 头部保留第一块（含 fmt），仅两个长度字段被修正
    const headA = Array.from(a.slice(0, 44))
    const headOut = Array.from(o.slice(0, 44))
    expect(headOut[4]).not.toBe(headA[4])
    expect(headOut[40]).not.toBe(headA[40])
    expect(headOut.map((v, i) => (i === 4 || i === 40 || i === 41 || i === 42 || i === 43 || i === 5 || i === 6 || i === 7 ? null : v))).toEqual(
      headA.map((v, i) => (i === 4 || i === 40 || i === 41 || i === 42 || i === 43 || i === 5 || i === 6 || i === 7 ? null : v)),
    )
    expect(Array.from(o.slice(44, 44 + 200))).toEqual(Array.from(a.slice(44)))
    expect(Array.from(o.slice(44 + 200))).toEqual(Array.from(b.slice(44)))
  })

  test("三块拼接长度与顺序正确", () => {
    const parts = [makeWav(10), makeWav(20), makeWav(30)]
    const o = concatWav(parts) as Uint8Array
    expect(o.byteLength).toBe(44 + (10 + 20 + 30) * 2)
    expect(u32(o, 40)).toBe((10 + 20 + 30) * 2)
  })

  test("格式不一致拒绝拼接（不产出一条失真音频）", () => {
    expect(concatWav([makeWav(10, 16000), makeWav(10, 22050)])).toBeNull()
  })

  test("非法/损坏输入返回 null", () => {
    expect(concatWav([])).toBeNull()
    // 单块走短路（原样返回，不解析）
    const plain = new Uint8Array(10)
    expect(concatWav([plain])).toBe(plain)
    // 多块中含损坏块：拒绝拼接
    const broken = makeWav(10)
    broken[40] = 0xff
    broken[41] = 0xff // data 长度远超实际
    expect(concatWav([makeWav(10), broken])).toBeNull()
    expect(concatWav([makeWav(10), new Uint8Array(10)])).toBeNull()
  })
})

describe("runTtsScript：临时目录保证存在", () => {
  /**
   * 回归背景：结果 JSON 是 **PowerShell 脚本直接写盘**的（不经 deps.writeFile 的父目录补齐），
   * 而 voices/play 模式不写文本文件——tmpDir 缺失时脚本侧只报 “Could not find a part of the path”，
   * 报错本身又经 CLIXML 传递，根因极难倒推。故目录创建是执行通道自己的职责。
   */
  const stubDeps = (tmpDir: string, seen: Array<Record<string, string>>): TtsDeps => ({
    runCommand: async (_cmd, opts) => {
      const env = (opts?.env ?? {}) as Record<string, string>
      seen.push(env)
      // 脚本侧行为：把结果 JSON 直接写进 tmpDir（不建目录——建目录是 runTtsScript 的职责）
      writeFileSync(env.GEBAI_TTS_RESULT!, JSON.stringify({ ok: true, engine: "winrt", voices: [{ name: "Stub", lang: "zh-CN", gender: "Female", engine: "winrt" }] }))
      return { stdout: "", stderr: "", code: 0 }
    },
    readFile: async (p) => readFileSync(p, "utf8"),
    writeFile: async (p, content) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, content)
    },
    deleteFile: async (p) => {
      rmSync(p, { force: true })
    },
    tmpDir,
  })

  test("tmpDir 尚不存在时自动创建（voices 模式不写文本文件，目录没人建）", async () => {
    const root = mkdtempSync(join(tmpdir(), "tts-tmpdir-"))
    const tmpDir = join(root, "nested", "tts")
    try {
      const seen: Array<Record<string, string>> = []
      const res = await runTtsScript(stubDeps(tmpDir, seen), { mode: "voices", engine: "auto" })
      expect(res.result?.ok).toBe(true)
      expect(res.result?.voices?.[0]?.name).toBe("Stub")
      expect(seen[0]!.GEBAI_TTS_RESULT!.startsWith(tmpDir)).toBe(true)
      expect(existsSync(tmpDir)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("临时文件用后即删（只留产物）", async () => {
    const root = mkdtempSync(join(tmpdir(), "tts-cleanup-"))
    const tmpDir = join(root, "tts")
    try {
      const seen: Array<Record<string, string>> = []
      await runTtsScript(stubDeps(tmpDir, seen), { mode: "synth", engine: "auto", text: "你好", out: join(root, "out.wav") })
      expect(existsSync(seen[0]!.GEBAI_TTS_RESULT!)).toBe(false)
      expect(existsSync(seen[0]!.GEBAI_TTS_TEXT!)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
