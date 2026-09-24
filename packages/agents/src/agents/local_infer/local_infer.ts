import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, resolve, win32 } from "node:path"
import type { SubAgentDef, Tool, ToolSchema } from "@gebai/sdk"

export const name = "local_infer"
export const description =
  "本地推理引擎（Qwen-AgentWorld-35B-A3B 在消费级 GPU 上的极速推理）的状态查看、服务启停、基准测试与模型结构解析。需要跑本地大模型、查推理服务状态/显存占用/吞吐、切档位、做基准对比、或解析 GGUF 结构时装载本子Agent。输入：操作意图（启动/停止/查看状态/压测/解析模型）；输出：服务状态、实测吞吐、显存占用与档位信息。"

export const systemPrompt =
  "你负责运维 GEBAI 的本地推理引擎（子项目 infer/）：在单张 16GB 消费级 GPU 上跑 Qwen-AgentWorld-35B-A3B（35B 总参 / 3B 激活的混合线性注意力 MoE）。\n" +
  "工具经本子Agent 命名空间暴露：local_infer_status 查看服务/显存/进程状态；local_infer_models 列出可用模型与运行档位；local_infer_start 按档位启动 OpenAI 兼容服务（需审批）；local_infer_stop 停止服务（需审批）；local_infer_bench 跑基准测试（需审批）；local_infer_inspect 解析 GGUF 结构与张量布局。\n" +
  "**关键事实（实测得出，勿凭直觉推翻）**：\n" +
  "1) 后端必须是 CUDA。同配置下 CUDA 解码比 Vulkan 快 2.6 倍（143 vs 54 t/s）——本模型每 token 触发 320 次小 GEMM，CUDA 的 MoE 内核效率远超 Vulkan。Vulkan 仅作无 CUDA 时的回退。\n" +
  "2) 专家权重必须全部驻显存（-ncmoe 0）。CUDA 下只要几层专家落在 CPU 就损失三成吞吐（6 层 → 143 掉到 97 t/s）。因此正确策略是「选能整体装进显存的量化」，而不是「高量化 + 部分卸载」。\n" +
  "3) 档位由 infer/config/profiles.json 定义，数值均为实测结论：fast（IQ3_XXS 全 GPU，解码 143 t/s）为默认推荐；quality（IQ4_XS、8 层专家在 CPU，解码 82 t/s）质量优先时用。\n" +
  "4) 投机解码在本场景无收益（已实测 ngram-mod/ngram-cache 均低于无投机基线），MTP 头也不在该 GGUF 内——不要开启投机相关参数。\n" +
  "5) 并发不提升吞吐：4 slot 聚合（53 t/s）反而低于单流（143 t/s）。多路调用时优先串行排队，不要靠加大 -np 提速。\n" +
  "6) 该模型是**推理型**（带思维链）：输出正文在 content，思考过程在 reasoning_content。判断模型是否正常工作时必须看 reasoning_content，只看 content 会把正常的思维链输出误判为空响应。\n" +
  "**工作要点**：\n" +
  "1) 启动前先 local_infer_status 确认显存与端口占用（模型约 13GB 显存，冲突会导致预填充性能崩塌甚至加载失败）；\n" +
  "2) 换档位或换模型用 local_infer_start 的 profile/model 参数，服务会以新配置重启；\n" +
  "3) 性能结论一律以 local_infer_bench 实测为准，不引用文档中的历史数字当现状；\n" +
  "4) 模型来源与完整性：权重取自 ModelScope（unsloth UD 量化），服务不会自动下载，缺模型时先补齐再启动；\n" +
  "5) 详细设计、实测数据与约束见子项目文档 infer/README.md（含后端对比、显存规划、无效优化的负结果）。\n" +
  "启动/停止/压测会占用整张 GPU（数十秒到数分钟），执行前确认用户没有其他 GPU 任务在跑。"

function schema(properties: Record<string, unknown>, required: string[] = []): ToolSchema {
  return { type: "object", properties, required }
}

// ── 路径解析 ──────────────────────────────────────────────────────────────

/** 绝对路径判定（跨平台）：POSIX 绝对路径与 Windows 盘符/UNC 形态都算绝对——环境变量配置的路径
 *  常在 Windows 与 WSL/容器之间共享，只在当前平台判定会把 `C:\x` 拼成 `<cwd>/C:\x` 这样的无意义路径
 *  （后续访问必失败，且错误信息指向一个并不存在的怪路径）。 */
function isAbsolutePath(p: string): boolean {
  return isAbsolute(p) || win32.isAbsolute(p)
}

/** 子项目根：LOCAL_INFER_HOME 优先；dev 模式按模块路径推导（src/agents/local_infer → 仓库根/infer）。 */
export function inferHome(env: Record<string, string>): string {
  const h = env.LOCAL_INFER_HOME
  if (h) return isAbsolutePath(h) ? h : resolve(process.cwd(), h)
  return resolve(import.meta.dirname, "..", "..", "..", "..", "..", "infer")
}

/** 运行档位定义文件。 */
export function profilesPath(home: string): string {
  return join(home, "config", "profiles.json")
}

/** 模型权重目录（{GEBAI_HOME}/resources/models/infer）。 */
export function modelsDir(home: string, env: Record<string, string>): string {
  const dir = env.LOCAL_INFER_MODELS_DIR
  if (dir) return isAbsolutePath(dir) ? dir : resolve(process.cwd(), dir)
  return resolve(home, "..", "resources", "models", "infer")
}

export interface InferProfile {
  model?: string
  ctx?: number
  n_cpu_moe?: number | null
  n_gpu_layers?: number
  parallel?: number
  spec_type?: string | null
}

export interface InferProfiles {
  engine_dir: string
  default_profile: string
  default_model?: string
  profiles: Record<string, InferProfile>
}

/** 读取档位定义（缺失或损坏时返回 null，由调用方给出可操作的提示）。 */
export function loadProfiles(home: string): InferProfiles | null {
  const p = profilesPath(home)
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as InferProfiles
    if (!raw || typeof raw !== "object" || !raw.profiles) return null
    return raw
  } catch {
    return null
  }
}

/** 列出模型目录下的 GGUF（含大小），按名称排序。 */
export function listModels(dir: string): Array<{ name: string; gb: number; incomplete: boolean }> {
  if (!existsSync(dir)) return []
  const out: Array<{ name: string; gb: number; incomplete: boolean }> = []
  for (const f of readdirSync(dir)) {
    if (!/\.gguf(\.incomplete)?$/i.test(f)) continue
    try {
      const st = statSync(join(dir, f))
      if (!st.isFile()) continue
      out.push({ name: f, gb: st.size / 1024 ** 3, incomplete: f.endsWith(".incomplete") })
    } catch {
      /* 忽略不可读条目 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 解析某档位实际会用的模型文件名（档位未指定时取全局默认）。 */
export function profileModel(p: InferProfiles, profile: string): string {
  return p.profiles[profile]?.model ?? p.default_model ?? ""
}

// ── 外部命令封装 ──────────────────────────────────────────────────────────

/** PowerShell 7 优先（脚本含中文，Windows PowerShell 5.1 按 GBK 读会乱码），回退 powershell。 */
function pwshCmd(): string {
  return process.platform === "win32" ? "pwsh -NoProfile" : "pwsh"
}

function scriptRun(home: string, script: string, args: string[]): string {
  const file = join(home, "scripts", script)
  return `${pwshCmd()} -ExecutionPolicy Bypass -File "${file}" ${args.join(" ")}`
}

// ── 工具 ──────────────────────────────────────────────────────────────────

const status: Tool = {
  name: "status",
  description:
    "查看本地推理引擎运行状态：服务进程（PID/内存）、端口监听、健康检查、GPU 显存与利用率、当前档位与模型、最近一次启动记录。只读，不改变任何状态。",
  parameters: schema({
    port: { type: "number", description: "服务端口（缺省 LOCAL_INFER_PORT 或 8080）" },
  }),
  async execute(args, ctx) {
    const home = inferHome(ctx.env)
    const port = Number(args.port ?? ctx.env.LOCAL_INFER_PORT ?? 8080)
    const lines: string[] = []

    if (!existsSync(home)) {
      return { output: `未找到本地推理子项目：${home}\n可通过 LOCAL_INFER_HOME 指定子项目根，或在仓库中初始化 infer/。` }
    }
    lines.push(`子项目根: ${home}`)

    const prof = loadProfiles(home)
    if (prof) {
      const active = ctx.env.LOCAL_INFER_PROFILE ?? prof.default_profile
      const model = profileModel(prof, active)
      lines.push(`档位: ${active}（可用: ${Object.keys(prof.profiles).join(", ")}）`)
      lines.push(`模型: ${model || "（档位未指定）"}`)
      const p = prof.profiles[active]
      if (p) {
        lines.push(
          `  参数: ctx=${p.ctx ?? "-"} n_gpu_layers=${p.n_gpu_layers ?? "-"} n_cpu_moe=${p.n_cpu_moe ?? "-"} parallel=${p.parallel ?? "-"} spec=${p.spec_type ?? "off"}`,
        )
      }
      lines.push(`引擎目录: ${join(home, prof.engine_dir)}`)
    } else {
      lines.push("档位定义缺失或损坏：config/profiles.json")
    }

    // 进程
    const ps = await ctx.runCommand(
      process.platform === "win32"
        ? `tasklist /FI "IMAGENAME eq llama-server.exe" /FO CSV /NH`
        : `pgrep -a llama-server || true`,
      { timeoutMs: 20000 },
    )
    const running = /llama-server/i.test(ps.stdout)
    lines.push("", "── 进程 ──")
    lines.push(running ? ps.stdout.trim().split("\n").slice(0, 3).join("\n") : "未运行 llama-server")

    // 端口
    const net = await ctx.runCommand(
      process.platform === "win32"
        ? `netstat -ano | findstr ":${port} "`
        : `ss -ltnp 2>/dev/null | grep ":${port} " || true`,
      { timeoutMs: 20000 },
    )
    const listening = net.stdout.includes("LISTENING") || /\blisten\b/i.test(net.stdout)
    lines.push("", "── 端口 ──")
    lines.push(`:${port} ${listening ? "监听中" : "未监听"}`)

    // 健康检查
    if (listening) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })
        lines.push(`/health → HTTP ${r.status}（服务可用，OpenAI 兼容端点为 /v1/chat/completions）`)
      } catch (e) {
        lines.push(`/health 请求失败：${(e as Error).message}`)
      }
    }

    // GPU
    const smi = await ctx.runCommand(
      `nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader`,
      { timeoutMs: 30000 },
    )
    lines.push("", "── GPU ──")
    lines.push(smi.code === 0 ? smi.stdout.trim() : `nvidia-smi 不可用：${smi.stderr.trim() || "未安装驱动"}`)

    // 最近启动记录
    const repDir = join(home, "bench", "reports")
    if (existsSync(repDir)) {
      const launches = readdirSync(repDir)
        .filter((f) => f.startsWith("launch-") && f.endsWith(".json"))
        .sort()
        .slice(-1)
      if (launches.length) {
        try {
          const j = JSON.parse(readFileSync(join(repDir, launches[0]), "utf-8")) as {
            started_at?: string
            profile?: string
            argv?: string[]
          }
          lines.push("", "── 最近启动 ──")
          lines.push(`${j.started_at ?? "?"}  档位 ${j.profile ?? "?"}`)
          if (j.argv) lines.push(`argv: ${j.argv.join(" ")}`)
        } catch {
          /* 记录损坏则跳过 */
        }
      }
    }
    return { output: lines.join("\n") }
  },
}

const models: Tool = {
  name: "models",
  description: "列出本地推理可用的模型文件（GGUF，含大小与是否下载完成）与全部运行档位（含推荐档位与各自实测吞吐）。只读。",
  parameters: schema({}),
  async execute(_args, ctx) {
    const home = inferHome(ctx.env)
    if (!existsSync(home)) return { output: `未找到本地推理子项目：${home}（可用 LOCAL_INFER_HOME 指定）` }
    const dir = modelsDir(home, ctx.env)
    const lines: string[] = [`模型目录: ${dir}`, ""]

    const list = listModels(dir)
    if (!list.length) {
      lines.push("（无 GGUF 文件）")
    } else {
      for (const m of list) {
        lines.push(`  ${m.name}  ${m.gb.toFixed(2)} GB${m.incomplete ? "  [未下载完成]" : ""}`)
      }
    }

    const prof = loadProfiles(home)
    lines.push("", "── 运行档位 ──")
    if (!prof) {
      lines.push("档位定义缺失或损坏：config/profiles.json")
    } else {
      lines.push(`默认档位: ${prof.default_profile}`)
      for (const [k, v] of Object.entries(prof.profiles)) {
        lines.push(
          `  ${k}${k === prof.default_profile ? "（默认）" : ""}: 模型=${v.model ?? prof.default_model ?? "-"} ctx=${v.ctx ?? "-"} n_cpu_moe=${v.n_cpu_moe ?? "-"} parallel=${v.parallel ?? "-"}`,
        )
      }
    }
    return { output: lines.join("\n") }
  },
}

const start: Tool = {
  name: "start",
  description:
    "按档位启动本地推理服务（OpenAI 兼容端点，默认 127.0.0.1:8080）。会占用整张 GPU（模型约 13GB 显存，加载约 10-20 秒），启动前请确认没有其他 GPU 任务。需审批。",
  requiresApproval: true,
  parameters: schema({
    profile: { type: "string", description: "运行档位名（缺省用配置的默认档，推荐 fast）" },
    model: { type: "string", description: "模型文件名（缺省用档位指定的模型）" },
    port: { type: "number", description: "服务端口（缺省 LOCAL_INFER_PORT 或 8080）" },
    n_cpu_moe: { type: "number", description: "留在 CPU 的专家层数（0=全部专家进显存，性能最优；缺省用档位值）" },
  }, []),
  async execute(args, ctx) {
    const home = inferHome(ctx.env)
    if (!existsSync(home)) return { output: `未找到本地推理子项目：${home}（可用 LOCAL_INFER_HOME 指定）` }
    const prof = loadProfiles(home)
    if (!prof) return { output: `档位定义缺失或损坏：${profilesPath(home)}` }

    const profile = args.profile != null ? String(args.profile) : (ctx.env.LOCAL_INFER_PROFILE ?? prof.default_profile)
    if (!prof.profiles[profile]) {
      return { output: `未知档位: ${profile}（可用: ${Object.keys(prof.profiles).join(", ")}）` }
    }
    const port = Number(args.port ?? ctx.env.LOCAL_INFER_PORT ?? 8080)

    const argv: string[] = [`-Profile "${profile}"`, `-Port ${port}`, "-Background", "-NoWait"]
    if (args.model != null) argv.push(`-Model "${args.model}"`)
    if (args.n_cpu_moe != null) argv.push(`-NCpuMoe ${Number(args.n_cpu_moe)}`)

    // 启动脚本完全脱离进程树并立即返回（否则工具会挂在长驻服务进程的句柄上）；就绪在这里轮询。
    const r = await ctx.runCommand(scriptRun(home, "run-server.ps1", argv), { timeoutMs: 60000, workdir: home })
    const out = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim()
    if (r.code !== 0) return { output: `启动失败（exit ${r.code}）：\n${out}` }

    const t0 = Date.now()
    const deadline = t0 + 180000
    let ready = false
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
        if (res.ok) {
          ready = true
          break
        }
      } catch {
        /* 尚未就绪，继续等待 */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    const secs = Math.round((Date.now() - t0) / 1000)
    const tail = ready
      ? `服务就绪 http://127.0.0.1:${port}（加载 ${secs}s，OpenAI 兼容端点 /v1/chat/completions）`
      : `等待 ${secs}s 仍未就绪——大模型首次加载可能更久，用 local_infer_status 复查进程与日志`
    return { output: `${out}\n\n${tail}\n\n提示：推理型模型的输出正文在 content、思维链在 reasoning_content，两者都要看。` }
  },
}

const stop: Tool = {
  name: "stop",
  description: "停止本地推理服务：按 PID、按端口占用者、或缺省停止全部 llama-server 进程，释放显存。需审批。",
  requiresApproval: true,
  parameters: schema({
    port: { type: "number", description: "按端口定位并停止其占用进程" },
    pid: { type: "number", description: "直接停止指定 PID" },
  }, []),
  async execute(args, ctx) {
    if (process.platform !== "win32") {
      const cmd = args.pid ? `kill -9 ${Number(args.pid)}` : `pkill -f llama-server || true`
      const r = await ctx.runCommand(cmd, { timeoutMs: 30000 })
      return { output: r.code === 0 ? `已停止（${cmd}）` : `停止失败：${r.stderr.trim()}` }
    }
    if (args.pid != null) {
      const r = await ctx.runCommand(`taskkill /PID ${Number(args.pid)} /T /F`, { timeoutMs: 30000 })
      return { output: r.stdout.trim() || r.stderr.trim() }
    }
    if (args.port != null) {
      const net = await ctx.runCommand(`netstat -ano | findstr ":${Number(args.port)} "`, { timeoutMs: 20000 })
      const m = net.stdout.match(/\s(\d+)\s*$/m)
      if (!m) return { output: `端口 ${Number(args.port)} 未被占用，无需停止。` }
      const r = await ctx.runCommand(`taskkill /PID ${m[1]} /T /F`, { timeoutMs: 30000 })
      return { output: `已停止端口 ${Number(args.port)} 上的进程（PID ${m[1]}）：${r.stdout.trim() || r.stderr.trim()}` }
    }
    const r = await ctx.runCommand(`taskkill /IM llama-server.exe /T /F`, { timeoutMs: 30000 })
    return { output: r.stdout.trim() || `未发现运行中的 llama-server（${r.stderr.trim()}）` }
  },
}

const bench: Tool = {
  name: "bench",
  description:
    "对本地推理引擎跑基准测试（llama-bench：预填充与解码吞吐），结果落 bench/reports/ 并返回控制台表。耗时较长（每次加载模型 10-20 秒，多上下文多轮更久）。需审批。",
  requiresApproval: true,
  parameters: schema({
    model: { type: "string", description: "模型文件名（缺省用默认档位的模型）" },
    n_cpu_moe: { type: "number", description: "留在 CPU 的专家层数（0=全 GPU）" },
    prompt_tokens: { type: "string", description: "预填充测试的 token 数，逗号分隔（缺省 512,4096）" },
    gen_tokens: { type: "number", description: "解码测试生成 token 数（缺省 128）" },
    reps: { type: "number", description: "每项重复次数（缺省 2，越大越稳）" },
  }, []),
  async execute(args, ctx) {
    const home = inferHome(ctx.env)
    if (!existsSync(home)) return { output: `未找到本地推理子项目：${home}（可用 LOCAL_INFER_HOME 指定）` }
    const argv: string[] = []
    if (args.model != null) argv.push(`-Model "${args.model}"`)
    if (args.n_cpu_moe != null) argv.push(`-NCpuMoe ${Number(args.n_cpu_moe)}`)
    if (args.prompt_tokens != null) argv.push(`-PromptTokens ${String(args.prompt_tokens)}`)
    if (args.gen_tokens != null) argv.push(`-GenTokens ${Number(args.gen_tokens)}`)
    if (args.reps != null) argv.push(`-Reps ${Number(args.reps)}`)

    const r = await ctx.runCommand(scriptRun(home, "bench.ps1", argv), { timeoutMs: 900000, workdir: home })
    const out = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim()
    return { output: `基准测试（exit ${r.code}）：\n${out}` }
  },
}

const inspect: Tool = {
  name: "inspect",
  description:
    "解析 GGUF 模型文件的结构：架构、层数/专家数等关键元数据、张量分类统计（专家/注意力/嵌入各占多少）、每层专家字节数（用于显存规划）、是否含 MTP 头。支持未下载完成的文件（只读文件头，无需下完）。只读。",
  parameters: schema({
    model: { type: "string", description: "模型文件名（缺省解析模型目录下第一个 GGUF）" },
    json_out: { type: "string", description: "可选：把完整结构导出为该路径的 JSON（相对子项目根）" },
  }, []),
  async execute(args, ctx) {
    const home = inferHome(ctx.env)
    if (!existsSync(home)) return { output: `未找到本地推理子项目：${home}（可用 LOCAL_INFER_HOME 指定）` }
    const dir = modelsDir(home, ctx.env)

    let target: string | undefined
    if (args.model != null) {
      const cand = join(dir, String(args.model))
      if (!existsSync(cand)) {
        const avail = listModels(dir).map((m) => m.name)
        return { output: `模型不存在: ${cand}\n可用: ${avail.length ? avail.join(", ") : "（无）"}` }
      }
      target = cand
    } else {
      const first = listModels(dir)[0]
      if (!first) return { output: `模型目录为空：${dir}` }
      target = join(dir, first.name)
    }

    const argv = [`"${target}"`]
    if (args.json_out != null) argv.push(`--json "${join(home, String(args.json_out))}"`)
    const r = await ctx.runCommand(`python "${join(home, "scripts", "inspect-gguf.py")}" ${argv.join(" ")}`, {
      timeoutMs: 300000,
      workdir: home,
      env: { PYTHONIOENCODING: "utf-8" },
    })
    const out = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim()
    return { output: out || `解析无输出（exit ${r.code}）` }
  },
}

export const tools: Record<string, Tool> = { status, models, start, stop, bench, inspect }
export const requiresApproval = { start: true, stop: true, bench: true }
export const preload = false

/** 可配置环境变量（`INFER_*` 前缀，汇总进前端环境变量面板白名单）。 */
export const envVars = [
  { name: "LOCAL_INFER_HOME", description: "本地推理子项目根目录（缺省 dev 模式自动推导为仓库根下的 infer/）" },
  { name: "LOCAL_INFER_PROFILE", description: "默认运行档位名（缺省取 config/profiles.json 的 default_profile，推荐 fast）" },
  { name: "LOCAL_INFER_PORT", description: "本地推理服务端口（缺省 8080，OpenAI 兼容端点）" },
  { name: "LOCAL_INFER_MODELS_DIR", description: "模型权重目录（缺省 {GEBAI_HOME}/resources/models/infer）" },
]

/** 项目根绑定：dev 模式指向仓库内的 infer/ 子项目（二进制形态无该目录，返回 undefined）。 */
const projectRoot = (env: Record<string, string>): string | undefined => {
  const home = inferHome(env)
  return existsSync(home) ? home : undefined
}

export const def: SubAgentDef = { name, description, systemPrompt, tools, requiresApproval, preload, envVars, projectRoot }
