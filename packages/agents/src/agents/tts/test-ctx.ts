import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ToolContext } from "@gebai/sdk"

/** 脚本执行记录（用例据此断言下发给 PowerShell 的环境变量）。 */
export interface TtsRunRecord {
  cmd: string
  env: Record<string, string>
}

/**
 * tts 测试用 ToolContext：真实文件系统（mkdtemp 临时 home），`runCommand` 由用例提供假实现
 * （模拟 PowerShell 写结果 JSON / 产物 WAV，不真起进程、不联网、不依赖本机语音引擎）。
 */
export function makeCtx(
  home: string,
  handler: (env: Record<string, string>) => { stdout?: string; stderr?: string; code?: number } | Promise<{ stdout?: string; stderr?: string; code?: number }> = () => ({}),
  env: Record<string, string> = {},
): { ctx: ToolContext; runs: TtsRunRecord[] } {
  const tmp = join(home, "users", "default", "sessions", "s1", "tmp")
  mkdirSync(tmp, { recursive: true })
  const runs: TtsRunRecord[] = []
  const readSet = new Set<string>()
  const ctx: ToolContext = {
    user: "default",
    sessionId: "s1",
    workdir: tmp,
    sessionWorkdir: tmp,
    home,
    env,
    sandboxed: false,
    // 与真实引擎一致：逻辑路径的 `tmp/` 前缀剥离后落到会话工作目录
    resolvePath: (p) => join(tmp, p.replace(/^tmp\//, "")),
    readFile: async (p) => await Bun.file(p).text(),
    readBinaryFile: async (p) => new Uint8Array(await Bun.file(p).arrayBuffer()),
    writeFile: async (p, content) => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, content)
    },
    writeBinaryFile: async (p, data) => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, data)
    },
    listFiles: async () => [],
    listDir: async () => [],
    deleteFile: async (p) => {
      const { rm } = await import("node:fs/promises")
      await rm(p, { recursive: true, force: true })
    },
    moveFile: async () => {},
    runCommand: async (cmd, opts) => {
      const runEnv = (opts?.env ?? {}) as Record<string, string>
      runs.push({ cmd, env: runEnv })
      const r = await handler(runEnv)
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 }
    },
    uploadAttachment: (r) => Promise.resolve(r.path),
    publish: () => {},
    projects: [],
    resolveProjectPath: () => {
      throw new Error("无预置项目")
    },
    getTodos: async () => [],
    setTodos: async () => {},
    registry: { schemas: () => [], resolve: () => undefined, getAgentNames: () => [] },
    listSubAgentDefs: () => [],
    loadSubAgent: async () => {},
    waitForChoice: async () => null,
    waitForEnv: async () => false,
    waitForDraw: async () => ({ ok: true }),
    fileGuard: { markRead: (p) => readSet.add(p), hasRead: (p) => readSet.has(p), staleSinceRead: () => false },
  }
  return { ctx, runs }
}

/** 假脚本：按 payload 写结果 JSON（合成模式同时写产物文件），返回退出码。 */
export function scriptStub(payload: Record<string, unknown>, code = 0, stderr = "") {
  return async (env: Record<string, string>) => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    if (env.GEBAI_TTS_RESULT) {
      await mkdir(dirname(env.GEBAI_TTS_RESULT), { recursive: true })
      await writeFile(env.GEBAI_TTS_RESULT, JSON.stringify(payload), "utf8")
    }
    if (payload.ok === true && env.GEBAI_TTS_OUT) {
      await mkdir(dirname(env.GEBAI_TTS_OUT), { recursive: true })
      await writeFile(env.GEBAI_TTS_OUT, Buffer.alloc(2048, 1))
    }
    return { code, stderr }
  }
}
