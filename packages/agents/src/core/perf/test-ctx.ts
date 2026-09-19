/**
 * nsight 测试用 ToolContext 桩：真实文件系统（临时目录）+ 记录式 runCommand/listFiles。
 * 不依赖 GPU、nsys/ncu 安装与网络——分析层与解析层的正确性必须能在任意机器上验证。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ToolContext } from "@gebai/sdk"

export interface StubCtxOptions {
  /** 工作目录（默认临时根下的 tmp 子目录）。 */
  workdir?: string
  /** 环境变量（NSIGHT_* 等）。 */
  env?: Record<string, string>
  /** listFiles 返回的条目（相对工作目录）——缺省按目录树自动生成。 */
  files?: Array<{ path: string; size: number; modifiedAt?: number; isDir?: boolean }>
  /** runCommand 桩：返回固定结果或按命令前缀分派。 */
  runCommand?: (cmd: string, opts?: { workdir?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code: number }>
}

export interface StubCtx {
  ctx: ToolContext
  /** 记录到的命令。 */
  commands: string[]
}

export function makeStubCtx(root: string, opts: StubCtxOptions = {}): StubCtx {
  const workdir = opts.workdir ?? root
  mkdirSync(workdir, { recursive: true })
  const commands: string[] = []
  const files = opts.files ?? []
  const ctx = {
    user: "tester",
    sessionId: "s-test",
    workdir,
    sessionWorkdir: workdir,
    home: root,
    env: opts.env ?? {},
    sandboxed: false,
    resolvePath: (p: string) => (p.match(/^[A-Za-z]:|^\//) ? p : resolve(workdir, p)),
    readFile: async (p: string) => await Bun.file(p).text(),
    readBinaryFile: async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer()),
    writeFile: async (p: string, content: string) => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, content)
    },
    writeBinaryFile: async (p: string, data: Uint8Array) => {
      const { mkdir, writeFile } = await import("node:fs/promises")
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, data)
    },
    listFiles: async () => files.map((f) => ({ path: f.path, size: f.size, modifiedAt: f.modifiedAt ?? 0, isDir: f.isDir ?? false })),
    listDir: async () => [],
    deleteFile: async () => {},
    moveFile: async () => {},
    runCommand: async (cmd: string, o?: { workdir?: string; timeoutMs?: number }) => {
      commands.push(cmd)
      if (opts.runCommand) return await opts.runCommand(cmd, o)
      return { stdout: "", stderr: "", code: 0 }
    },
    uploadAttachment: async (r: { path: string }) => r.path,
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
  } as unknown as ToolContext
  return { ctx, commands }
}

/** 在工作目录写一个源码文件（用于定位测试）。 */
export function writeSourceFile(root: string, relPath: string, content: string): string {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}
