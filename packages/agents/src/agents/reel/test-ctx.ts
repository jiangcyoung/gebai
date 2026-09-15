/**
 * reel 测试用 ToolContext：真实文件系统（mkdtemp 临时 home）+ 会话已读追踪桩。
 * 不注入预置项目、不联网；进程 env 中的 REEL_* 变量由用例显式清理，避免宿主配置影响断言。
 */
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ToolContext } from "@gebai/sdk"

export function makeCtx(home: string, env: Record<string, string> = {}): { ctx: ToolContext; readSet: Set<string> } {
  const tmp = join(home, "users", "default", "sessions", "s1", "tmp")
  mkdirSync(tmp, { recursive: true })
  const readSet = new Set<string>()
  const ctx: ToolContext = {
    user: "default",
    sessionId: "s1",
    workdir: tmp,
    sessionWorkdir: tmp,
    home,
    env,
    sandboxed: false,
    resolvePath: (p) => join(tmp, p),
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
    deleteFile: async () => {},
    moveFile: async () => {},
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
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
  return { ctx, readSet }
}

/** 清理宿主进程可能存在的 REEL_* 环境变量，保证用例不依赖开发机配置。 */
export function clearReelEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("REEL_")) delete process.env[key]
  }
}
