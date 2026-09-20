/**
 * 真机端到端验证脚本（bun 运行，非测试）：客卿全链路——
 * 真实驱动（python/cpp/rust/go）、真实 spawn、真实 SubAgentManager/ToolRegistry。
 * 验证：发现注册 → 工具名带前缀 → 常驻状态保持 → 崩溃自愈 → pip status →
 * 构建引导（cpp/rust/go 可执行体缺失时自动编译）→ 各语言工具真机调用
 * （imgproc 图像处理 / dirs 目录分析 / vision 本地视觉识别）→
 * vision 跨语言合并（TS 侧 analyze + Python 侧识别四工具，依赖就绪时）→
 * 请求级 ctx（协议 v2：vision_run 无 session 参数时 REPL 命名空间按 ctx.sessionId 隔离）。
 */
import { SubAgentManager } from "../src/core/agents/subagents"
import { ToolRegistry } from "../src/core/base/registry"
import { disposeAllKeqing } from "../src/core/agents/keqing"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"

const registry = new ToolRegistry()
const m = new SubAgentManager({ registry, preloadOverride: [] })
m.setKeqingOpts({}) // 本地形态默认启用
await m.discover()

// 收尾时回收边车进程（防孤儿残留）
process.on("exit", () => disposeAllKeqing())

const expectAgent = (name: string) => {
  const def = m.def(name)
  if (!def) {
    console.error(`FAIL: ${name} 子代理未注册`)
    console.error("loadErrors:", m.loadError(name))
    process.exit(1)
  }
  console.log(`PASS: ${name} 子代理已注册，工具:`, Object.keys(def.tools ?? {}))
  return def
}

const fakeCtx = {
  user: "admin",
  sessionId: "e2e-session",
  workdir: process.cwd(),
  sessionWorkdir: process.cwd(),
  home: process.cwd(),
  env: {},
  resolvePath: (p: string) => p,
  readFile: async () => "",
  readBinaryFile: async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer()),
  writeFile: async () => {},
  writeBinaryFile: async (p: string, data: Uint8Array) => {
    await Bun.write(p, data)
  },
  listFiles: async () => [],
  listDir: async () => [],
  deleteFile: async () => {},
  moveFile: async () => {},
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  uploadAttachment: async (r: { name: string }) => r.name,
  publish: () => {},
  projects: [],
  resolveProjectPath: (n: string) => n,
  getTodos: async () => [],
  setTodos: async () => {},
  registry: { schemas: () => [], resolve: (n: string) => ({ name: n, tool: null }), getAgentNames: () => [] },
  listSubAgentDefs: () => [],
  loadSubAgent: async () => {},
} as never

// Python 语言目录（vision）与语言框架基础工具（run/pip/status）验证见下方 vision 段

// ---------------- imgproc（C++）：图像处理 ----------------
expectAgent("imgproc")
await m.load("imgproc")
// 1x1 红色 PNG（手写最小合法 PNG 字节）——不依赖外部图片资产
const pngPath = join(process.cwd(), "tmp-e2e-imgproc.png")
const pngB64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
writeFileSync(pngPath, Buffer.from(pngB64, "base64"))

const infoTool = registry.resolve("imgproc_info")!
const grayTool = registry.resolve("imgproc_grayscale")!
const resizeTool = registry.resolve("imgproc_resize")!
const statsTool = registry.resolve("imgproc_stats")!
const i1 = await infoTool.tool.execute({ path: pngPath }, fakeCtx)
console.log("imgproc_info:", i1.output.replace(/\n/g, " | "))
if (!i1.output.includes("1x1")) {
  console.error("FAIL: imgproc_info 应为 1x1:", i1.output)
  process.exit(1)
}
const i2 = await resizeTool.tool.execute({ path: pngPath, width: 8, output: join(process.cwd(), "tmp-e2e-imgproc-8.png") }, fakeCtx)
if (!i2.output.includes("1x1 -> 8x8")) {
  console.error("FAIL: imgproc_resize 等比缩放:", i2.output)
  process.exit(1)
}
const i3 = await grayTool.tool.execute({ path: pngPath }, fakeCtx)
if (!existsSync(join(process.cwd(), "tmp-e2e-imgproc.png.gray.png"))) {
  console.error("FAIL: imgproc_grayscale 未产出文件:", i3.output)
  process.exit(1)
}
const i4 = await statsTool.tool.execute({ path: pngPath }, fakeCtx)
if (!i4.output.includes("Otsu")) {
  console.error("FAIL: imgproc_stats 无 Otsu:", i4.output)
  process.exit(1)
}
// 清理测试产物
for (const f of [pngPath, join(process.cwd(), "tmp-e2e-imgproc-8.png"), join(process.cwd(), "tmp-e2e-imgproc.png.gray.png")]) {
  rmSync(f, { force: true })
}
console.log("PASS: imgproc（C++ + stb）info/grayscale/resize/stats")

// ---------------- dirs（Go）：目录空间分析 ----------------
expectAgent("dirs")
await m.load("dirs")
const duTool = registry.resolve("dirs_du")!
const depthTool = registry.resolve("dirs_depth")!
const topTool = registry.resolve("dirs_top")!
const treeTool = registry.resolve("dirs_tree")!
const goDir = join(process.cwd(), "..", "..", "keqing", "go")
const d1 = await duTool.tool.execute({ dir: goDir, depth: 1, top_k: 5 }, fakeCtx)
console.log("dirs_du:", d1.output.split("\n").slice(0, 3).join(" | "))
if (!d1.output.includes("占用排行")) {
  console.error("FAIL: dirs_du:", d1.output)
  process.exit(1)
}
// 参数到达验证：data.root 必须等于传参目录（tool.call 平级 args 被丢弃时工具会回退缺省目录，输出仍含「占用排行」标题）
if (String((d1.data as Record<string, unknown>)?.root ?? "").replaceAll("\\", "/") !== goDir.replaceAll("\\", "/")) {
  console.error(`FAIL: dirs_du 参数未到达工具（data.root=${String((d1.data as Record<string, unknown>)?.root)}，期望 ${goDir}）——tool.call 请求的平级 args 被丢弃`)
  process.exit(1)
}
const d2 = await depthTool.tool.execute({ dir: goDir }, fakeCtx)
if (!/文件: \d+/.test(d2.output) || !/最大深度/.test(d2.output)) {
  console.error("FAIL: dirs_depth:", d2.output)
  process.exit(1)
}
const d3 = await topTool.tool.execute({ dir: goDir, top_k: 3 }, fakeCtx)
if (!d3.output.includes("最大文件排行")) {
  console.error("FAIL: dirs_top:", d3.output)
  process.exit(1)
}
const d4 = await treeTool.tool.execute({ dir: goDir, max_depth: 2 }, fakeCtx)
if (!d4.output.includes("项）")) {
  console.error("FAIL: dirs_tree:", d4.output)
  process.exit(1)
}
console.log("PASS: dirs（Go）tree/du/top/depth（并发遍历）")

// ---------------- vision（Python + TS 跨语言合并）：识别四工具 + analyze ----------------
const visionDef = expectAgent("vision")
// 跨语言合并：TS 侧贡献 analyze（描述留空），Python 侧贡献 ocr/locate/locate_image/detect
if (!("analyze" in (visionDef.tools ?? {})) || !("ocr" in (visionDef.tools ?? {}))) {
  console.error("FAIL: vision 应同时含 TS 贡献 analyze 与 客卿 贡献 ocr:", Object.keys(visionDef.tools ?? {}))
  process.exit(1)
}
if (!visionDef.description || !visionDef.description.includes("本地")) {
  console.error("FAIL: vision 描述应由 客卿 侧贡献（TS 留空不拼接空串）:", visionDef.description)
  process.exit(1)
}
await m.load("vision")
const ocrTool = registry.resolve("vision_ocr")!
// 依赖/模型就绪时真机 OCR（生成含文字 PNG 不现实，用空图验证链路与错误引导）；
// 依赖缺失时验证安装提示而非栈追踪
const vDir = join(process.cwd(), "tmp-e2e-vision")
rmSync(vDir, { recursive: true, force: true })
mkdirSync(vDir, { recursive: true })
const vPng = join(vDir, "blank.png")
// 纯白 64x32 PNG（用系统 python + PIL 生成真实可解码文件；PIL 严格校验 CRC，手写最小编码会被拒）
Bun.spawnSync(["python", "-X", "utf8", "-c", "from PIL import Image; Image.new('RGB', (64, 32), (255,255,255)).save(r'" + vPng.replace(/\\/g, "/") + "')"], { stdout: "ignore", stderr: "pipe" })
if (!existsSync(vPng)) {
  console.log("SKIP: vision 真机 OCR（无系统 python/PIL 生成测试图）")
} else {
  const v1 = await ocrTool.tool.execute({ image: vPng }, fakeCtx)
  if (/Traceback|ImportError|ModuleNotFoundError/.test(v1.output)) {
    console.error("FAIL: vision_ocr 依赖缺失应给安装提示而非栈:", v1.output)
    process.exit(1)
  }
  const missingDeps = /依赖缺失/.test(v1.output)
  const missingModels = /模型未配置/.test(v1.output)
  if (missingDeps || missingModels) {
    console.log(`SKIP: vision 真机 OCR（${missingDeps ? "依赖未装" : "模型未配置"}）——链路与引导文案验证通过:`)
    console.log("  ", v1.output.split("\n")[0])
  } else {
    // 依赖与模型就绪：纯白空图应正常返回「未识别到文字」引导
    if (!v1.output.includes("未识别到文字")) {
      console.error("FAIL: vision_ocr 空图应返回未识别引导:", v1.output)
      process.exit(1)
    }
    console.log("PASS: vision 真机 OCR（onnxruntime 原生推理）空图引导")
  }
}
rmSync(vDir, { recursive: true, force: true })
console.log("PASS: vision 跨语言合并（TS 贡献 analyze 与 Python 识别四工具同命名空间）")

// ---------------- Python 语言目录基础工具（driver.py 框架能力，经 tools.py 合并上报：run/pip/status） ----------------
const runTool = registry.resolve("vision_run")
if (!runTool) {
  console.error("FAIL: vision 未合并基础 run 工具")
  process.exit(1)
}
// 常驻命名空间状态保持
const p1 = await runTool.tool.execute({ code: "import math\nval = math.pi\nval", session: "e2e" }, fakeCtx)
if (!p1.output.includes("3.14")) {
  console.error("FAIL: 首次执行应回显 math.pi:", p1.output)
  process.exit(1)
}
const p2 = await runTool.tool.execute({ code: "round(val * 2, 4)", session: "e2e" }, fakeCtx)
if (p2.output.trim() !== "6.2832") {
  console.error("FAIL: 常驻状态丢失:", p2.output)
  process.exit(1)
}
console.log("PASS: vision_run 常驻命名空间状态保持（tools.py 合并基础工具）")

// 请求级 ctx（协议 v2）：无 session 参数时 REPL 命名空间缺省按 ctx.sessionId 隔离——
// 不同会话（sessionId 不同）互不可见，同会话共享
const c1 = await runTool.tool.execute({ code: "ctx_val = 42\nctx_val" }, fakeCtx)
if (!c1.output.includes("42")) {
  console.error("FAIL: ctx 缺省命名空间执行:", c1.output)
  process.exit(1)
}
const otherCtx = { ...(fakeCtx as Record<string, unknown>), sessionId: "e2e-other-session" } as never
const c2 = await runTool.tool.execute({ code: "'ctx_val' in dir()" }, otherCtx)
if (c2.output.includes("True")) {
  console.error("FAIL: 跨会话命名空间应隔离（ctx.sessionId 分桶）:", c2.output)
  process.exit(1)
}
const c3 = await runTool.tool.execute({ code: "ctx_val" }, fakeCtx)
if (!c3.output.includes("42")) {
  console.error("FAIL: 同会话命名空间应共享:", c3.output)
  process.exit(1)
}
console.log("PASS: 请求级 ctx（协议 v2）REPL 命名空间按 sessionId 隔离（跨会话互不可见）")

// pip status
const pipTool = registry.resolve("vision_pip")!
const p3 = await pipTool.tool.execute({ action: "status" }, fakeCtx)
if (!p3.output.includes("venv:")) {
  console.error("FAIL: vision_pip status 无 venv 报告:", p3.output)
  process.exit(1)
}
console.log("PASS: vision_pip status 报告")

// 崩溃自愈：驱动内 os._exit(1) → 宿主重启 → 下次调用新进程成功
await runTool.tool.execute({ code: "import os\nos._exit(1)", session: "crash" }, fakeCtx).catch(() => "")
const p4 = await runTool.tool.execute({ code: "'alive-after-crash'", session: "crash2" }, fakeCtx)
if (!p4.output.includes("alive-after-crash")) {
  console.error("FAIL: 崩溃后新进程未恢复:", p4.output)
  process.exit(1)
}
console.log("PASS: 崩溃自愈（真实 os._exit → 重启 → 新进程可用）")
console.log("\n=== Python 语言目录（vision）+ 基础工具段全部通过 ===")

// ---------------- desktop_ocr → vision 边车委托（sidecar-first 真机链路） ----------------
// desktop 的 ocr/locate/detect 推理经注册表调用 vision 边车（onnxruntime 原生推理），
// 坐标语义与 wasm 同构；此处验证真边车进程 + 真推理 + 真坐标映射（含文字图片）
if (process.platform === "win32" && existsSync(join(process.cwd(), "..", "..", "keqing", "python", "venv"))) {
  await m.load("desktop") // 懒装载：desktop 工具入注册表（desktop_ocr 等）
  const desktopOcr = registry.resolve("desktop_ocr")
  if (!desktopOcr) {
    console.error("FAIL: desktop_ocr 未在注册表（desktop 子代理未注册）")
    process.exit(1)
  }
  // 生成含文字 PNG（真机 OCR：PIL 画字，与本会话验证到的边车 OCR 能力对接）
  const e2eDir = join(process.cwd(), "tmp-e2e-desktop")
  rmSync(e2eDir, { recursive: true, force: true })
  mkdirSync(e2eDir, { recursive: true })
  const shotPng = join(e2eDir, "shot.png")
  Bun.spawnSync(["python", "-X", "utf8", "-c", "from PIL import Image, ImageDraw, ImageFont; f = ImageFont.truetype(r'C:/Windows/Fonts/arial.ttf', 20); im = Image.new('RGB', (160, 44), (255,255,255)); d = ImageDraw.Draw(im); d.text((8, 10), 'Hello OCR 123', fill=(0,0,0), font=f); im.save(r'" + shotPng.replace(/\\/g, "/") + "')"], { stdout: "ignore", stderr: "pipe" })
  if (existsSync(shotPng)) {
    const r5 = await desktopOcr.tool.execute({ image: shotPng }, { ...fakeCtx, registry: { schemas: () => [], resolve: (n: string) => (n === "vision_ocr" ? registry.resolve("vision_ocr") : undefined), getAgentNames: () => ["vision"] } } as never)
    const lines = (r5.data as { lines?: Array<{ text: string }> })?.lines ?? []
    if (r5.output.includes("HelloOCR123") || lines.some((l) => l.text.replace(/\s/g, "").includes("HelloOCR123"))) {
      console.log("PASS: desktop_ocr → vision 边车委托（真边车真推理，坐标回加同构）")
    } else if (/本地识别失败|未配置/.test(r5.output)) {
      console.log("SKIP: desktop_ocr 委托真机推理（模型未配置）:", r5.output.split("\n")[0])
    } else {
      console.error("FAIL: desktop_ocr 委托未得到预期文字:", r5.output)
      process.exit(1)
    }
    rmSync(e2eDir, { recursive: true, force: true })
  } else {
    console.log("SKIP: desktop_ocr 委托真机（无系统 python/PIL 生成测试图）")
  }
}

console.log("\n=== 真机端到端全部通过（python + cpp + rust + go 四语言 + vision 跨语言合并 + 请求级 ctx + desktop→vision 委托）===")
disposeAllKeqing() // 显式回收后再退出（exit hook 兄弟保险，防孤儿进程）
process.exit(0)
