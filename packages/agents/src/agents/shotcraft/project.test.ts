/**
 * 工程脚手架与运行时联接单测：目录联接（复用共享运行时/保留独立安装）、空白脚手架产物、
 * 入口点探测、源码签名（bundle 缓存失效依据）、status 与 init 的离线路径。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearShotcraftEnv, makeCtx } from "./test-ctx"
import { linkNodeModules, projectTool, scaffoldBlank } from "./project"
import { detectEntryPoint, projectSourceSignature } from "./runtime"

const roots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "shotcraft-project-"))
  roots.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => clearShotcraftEnv())

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, content)
}

function makeSkill(root: string): string {
  const skill = join(root, "skill")
  const files: Record<string, string> = {
    "SKILL.md": "# skill",
    "references/shots/camera/basic.md": "---\nname: basic\n---",
    "references/pipeline.md": "pipeline",
    "references/aesthetic-rules.md": "rules",
    "gallery/api/library.json": JSON.stringify({ revision: "rev12345", stats: { cardCount: 157, styleCount: 214 } }),
    "template/package.json": JSON.stringify({ name: "promo-template", dependencies: { remotion: "4.0.484", react: "19.2.7" }, devDependencies: { typescript: "6.0.3" } }),
    "template/src/index.ts": "registerRoot(Root);",
    "demos/camera/basic/Basic.tsx": "export const Basic = () => null",
    "assets/lib/PageCam.tsx": "export const PageCam = () => null",
    "assets/audio/bgm/beat.mp3": "audio",
    "assets/scripts/capture-template.mjs": "// capture",
    "workbench/package.json": JSON.stringify({ name: "wb" }),
    "jianying-export/mac_draft.py": "print()",
  }
  for (const [rel, content] of Object.entries(files)) write(join(skill, rel), content)
  return skill
}

describe("共享运行时目录联接", () => {
  test("联接复用共享 node_modules；再次调用识别已联接", () => {
    const root = tmpRoot()
    const runtime = join(root, "runtime")
    mkdirSync(join(runtime, "node_modules", "remotion"), { recursive: true })
    const project = join(root, "project")
    mkdirSync(project, { recursive: true })

    const first = linkNodeModules(project, runtime)
    expect(first.linked).toBe(true)
    expect(lstatSync(join(project, "node_modules")).isSymbolicLink()).toBe(true)
    expect(first.note).toContain("已联接")

    const second = linkNodeModules(project, runtime)
    expect(second.linked).toBe(true)
    expect(second.note).toContain("已联接")
  })

  test("项目已有独立 node_modules 时保留不动", () => {
    const root = tmpRoot()
    const runtime = join(root, "runtime")
    mkdirSync(join(runtime, "node_modules"), { recursive: true })
    const project = join(root, "project")
    mkdirSync(join(project, "node_modules"), { recursive: true })
    const res = linkNodeModules(project, runtime)
    expect(res.linked).toBe(false)
    expect(res.note).toContain("独立 node_modules")
  })

  test("共享运行时未安装依赖时给出明确提示", () => {
    const root = tmpRoot()
    const project = join(root, "project")
    mkdirSync(project, { recursive: true })
    const res = linkNodeModules(project, join(root, "runtime"))
    expect(res.linked).toBe(false)
    expect(res.note).toContain("尚未安装依赖")
  })
})

describe("空白脚手架", () => {
  test("写出工程文件，依赖版本取自技能库模板", () => {
    const root = tmpRoot()
    const skill = makeSkill(root)
    const target = join(root, "video")
    const written = scaffoldBlank(skill, target)
    expect(written).toContain("package.json")
    expect(written).toContain("src/Root.tsx")
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8")) as { dependencies: Record<string, string> }
    expect(pkg.dependencies.remotion).toBe("4.0.484")
    expect(readFileSync(join(target, "src/index.ts"), "utf8")).toContain("registerRoot")
    expect(readFileSync(join(target, "src/Root.tsx"), "utf8")).toContain("Composition")
    expect(readFileSync(join(target, "remotion.config.ts"), "utf8")).toContain("setVideoImageFormat")
    expect(existsSync(join(target, "public/.gitkeep"))).toBe(true)
  })
})

describe("入口点探测", () => {
  test("优先项目清单记录", () => {
    const dir = join(tmpRoot(), "p")
    write(join(dir, "src/index.ts"), "// a")
    write(join(dir, "src/entry.ts"), "registerRoot(Root);")
    write(join(dir, ".shotcraft.json"), JSON.stringify({ entryPoint: "src/entry.ts" }))
    expect(detectEntryPoint(dir)).toBe(join(dir, "src/entry.ts"))
  })

  test("常规候选与 registerRoot 扫描回退", () => {
    const normal = join(tmpRoot(), "n")
    write(join(normal, "src/index.ts"), "// a")
    expect(detectEntryPoint(normal)).toBe(join(normal, "src/index.ts"))

    const scanned = join(tmpRoot(), "s")
    write(join(scanned, "src/Root.tsx"), "registerRoot(Root);")
    expect(detectEntryPoint(scanned)).toBe(join(scanned, "src/Root.tsx"))

    const empty = join(tmpRoot(), "e")
    mkdirSync(empty, { recursive: true })
    expect(detectEntryPoint(empty)).toBeNull()
  })
})

describe("源码签名（bundle 缓存失效依据）", () => {
  test("内容变化即失效，未变化则稳定", () => {
    const dir = join(tmpRoot(), "proj")
    write(join(dir, "src/index.ts"), "export const a = 1")
    write(join(dir, "package.json"), JSON.stringify({ name: "p" }))
    const first = projectSourceSignature(dir)
    expect(projectSourceSignature(dir)).toBe(first)
    write(join(dir, "src/index.ts"), "export const a = 2 // 改动后长度不同")
    expect(projectSourceSignature(dir)).not.toBe(first)
  })
})

describe("工具动作", () => {
  test("status 无技能库也能给出项目状态", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const dir = join(home, "video")
    write(join(dir, "src/index.ts"), "registerRoot(Root);")
    const res = await projectTool.execute({ action: "status", path: dir }, ctx)
    expect(res.output).toContain(`项目：${dir}`)
    expect(res.output).toContain("入口点")
    expect(res.output).toContain("技能库：未就绪")
  })

  test("init 使用本地技能库来源（install=false 免装依赖）", async () => {
    const home = tmpRoot()
    const skill = makeSkill(tmpRoot())
    const { ctx } = makeCtx(home, { SHOTCRAFT_SOURCE: skill })
    const target = join(home, "video")
    const res = await projectTool.execute({ action: "init", path: target, install: false }, ctx)
    expect(res.output).toContain("项目已就绪")
    expect(res.output).toContain("跳过依赖安装")
    expect(existsSync(join(target, "src/index.ts"))).toBe(true)
    expect(readFileSync(join(target, ".shotcraft.json"), "utf8")).toContain("src/index.ts")
  })

  test("init 遇到已有工程时拒绝（除非 force）", async () => {
    const home = tmpRoot()
    const skill = makeSkill(tmpRoot())
    const { ctx } = makeCtx(home, { SHOTCRAFT_SOURCE: skill })
    const target = join(home, "video")
    write(join(target, "package.json"), "{}")
    const blocked = await projectTool.execute({ action: "init", path: target, install: false }, ctx)
    expect(blocked.output).toContain("已存在工程")
    const forced = await projectTool.execute({ action: "init", path: target, install: false, force: true }, ctx)
    expect(forced.output).toContain("项目已就绪")
  })
})
