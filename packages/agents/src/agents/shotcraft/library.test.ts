/**
 * 技能库载荷与运行时单测：解包（剥顶层目录 / 拒绝越界）、结构校验、来源链与本地目录指针、
 * 幂等复用、运行时安装与失败登记——全部用注入式假实现（不联网、不执行真实包管理器）。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zipSync, unzipSync } from "fflate"
import { makeCtx, clearShotcraftEnv } from "./test-ctx"
import {
  copyTemplate,
  dirStats,
  ensureRuntime,
  ensureSkill,
  extractEntries,
  normalizeZipEntries,
  readRuntimeLock,
  readSkillLock,
  resolveSkillDir,
  restoreLinkEntries,
  sha256Hex,
  templateSignature,
  validateSkillDir,
  type SkillLock,
} from "./library"

const roots: string[] = []
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "shotcraft-test-"))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => clearShotcraftEnv())

describe("符号链接条目还原（zip 快照降级修复）", () => {
  test("内容为相对路径的小文件被还原成符号链接", () => {
    const dir = tmpRoot()
    mkdirSync(join(dir, "workbench"), { recursive: true })
    mkdirSync(join(dir, "demos", "camera"), { recursive: true })
    writeFileSync(join(dir, "demos", "camera", "Demo.tsx"), "export const a = 1")
    // zip 快照把 workbench/demosrc → ../demos 写成了普通文件
    writeFileSync(join(dir, "workbench", "demosrc"), "../demos")
    const repaired = restoreLinkEntries(dir)
    expect(repaired).toEqual(["workbench/demosrc → ../demos（符号链接）"])
    expect(readFileSync(join(dir, "workbench", "demosrc", "camera", "Demo.tsx"), "utf8")).toBe("export const a = 1")
  })

  test("普通小文件与指向包外的路径不动", () => {
    const dir = tmpRoot()
    mkdirSync(join(dir, "workbench"), { recursive: true })
    writeFileSync(join(dir, "workbench", "VERSION"), "1.2.3")
    writeFileSync(join(dir, "workbench", "note.txt"), "hello world")
    writeFileSync(join(dir, "workbench", "escape"), "../../etc")
    writeFileSync(join(dir, "workbench", "missing"), "../nope")
    expect(restoreLinkEntries(dir)).toEqual([])
    expect(readFileSync(join(dir, "workbench", "VERSION"), "utf8")).toBe("1.2.3")
    expect(readFileSync(join(dir, "workbench", "escape"), "utf8")).toBe("../../etc")
  })

  test("解包整包时自动还原（extractEntries 返回修复清单）", () => {
    const dir = tmpRoot()
    const zip = zipSync({
      "skill/SKILL.md": new TextEncoder().encode("# skill"),
      "skill/demos/a/Demo.tsx": new TextEncoder().encode("export const a = 1"),
      "skill/workbench/demosrc": new TextEncoder().encode("../demos"),
    })
    const { entries } = normalizeZipEntries(unzipSync(zip))
    const target = join(dir, "skill")
    const res = extractEntries(entries, target)
    expect(res.repaired).toEqual(["workbench/demosrc → ../demos（符号链接）"])
    expect(readFileSync(join(target, "workbench", "demosrc", "a", "Demo.tsx"), "utf8")).toBe("export const a = 1")
  })
})

/** 最小可用载荷（结构校验必需项齐全）。 */
const PAYLOAD: Record<string, string> = {
  "SKILL.md": "# video-shotcraft",
  "references/shots/camera/basic-3d-scene.md": "---\nname: basic-3d-scene\n---\n## 参考实现\ndemos/camera/basic-3d-scene/\n（Basic3DScene.tsx）\n",
  "references/pipeline.md": "pipeline",
  "references/aesthetic-rules.md": "rules",
  "gallery/api/library.json": JSON.stringify({ revision: "bdd94be16d60fa8f", stats: { cardCount: 157, styleCount: 214 } }),
  "template/package.json": JSON.stringify({ name: "promo-template", dependencies: { remotion: "4.0.484", react: "19.2.7" }, devDependencies: { typescript: "6.0.3" } }),
  "template/package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
  "template/tsconfig.json": JSON.stringify({ include: ["src"] }),
  "template/src/index.ts": "registerRoot(Root);",
  "template/public/audio/sfx/ui/x.wav": "audio",
  "template/node_modules/.bin/should-not-be-copied": "x",
  "template/out/old.mp4": "x",
  "demos/camera/basic-3d-scene/Basic3DScene.tsx": "export const Basic3DScene = () => null",
  "assets/lib/PageCam.tsx": "export const PageCam = () => null",
  "assets/audio/bgm/beat.mp3": "audio",
  "assets/scripts/capture-template.mjs": "// capture",
  "workbench/package.json": JSON.stringify({ name: "shotcraft-workbench" }),
  "jianying-export/mac_draft.py": "print('draft')",
}

function writePayload(dir: string, files: Record<string, string> = PAYLOAD): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

function payloadZip(prefix = "video-shotcraft-main/"): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [rel, content] of Object.entries(PAYLOAD)) entries[`${prefix}${rel}`] = new TextEncoder().encode(content)
  return zipSync(entries)
}

describe("结构校验", () => {
  test("必需项齐全即通过，缺文件报出具体路径", () => {
    const dir = writePayload(join(tmpRoot(), "skill"))
    expect(validateSkillDir(dir)).toEqual([])
    rmSync(join(dir, "template/package.json"))
    expect(validateSkillDir(dir).join(" ")).toContain("template/package.json")
  })

  test("library.json 非法或缺统计时报出", () => {
    const dir = writePayload(join(tmpRoot(), "skill"))
    writeFileSync(join(dir, "gallery/api/library.json"), "{not json")
    expect(validateSkillDir(dir).join(" ")).toContain("不是合法 JSON")
    writeFileSync(join(dir, "gallery/api/library.json"), JSON.stringify({ revision: "x" }))
    expect(validateSkillDir(dir).join(" ")).toContain("cardCount")
  })
})

describe("zip 归一化与解包", () => {
  test("剥掉归档顶层目录、跳过目录项与越界路径", () => {
    const files: Record<string, Uint8Array> = {
      "video-shotcraft-main/SKILL.md": new TextEncoder().encode("a"),
      "video-shotcraft-main/references/": new Uint8Array(),
      "video-shotcraft-main/../evil.txt": new TextEncoder().encode("evil"),
    }
    const { entries, skipped } = normalizeZipEntries(files)
    expect([...entries.keys()]).toEqual(["SKILL.md"])
    expect(skipped).toBe(1)
  })

  test("解包落盘到目标目录（先临时目录再改名）", () => {
    const target = join(tmpRoot(), "out", "skill")
    const entries = new Map<string, Uint8Array>([
      ["SKILL.md", new TextEncoder().encode("hello")],
      ["references/pipeline.md", new TextEncoder().encode("p")],
    ])
    const { fileCount } = extractEntries(entries, target)
    expect(fileCount).toBe(2)
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("hello")
    expect(dirStats(target).files).toBe(2)
  })
})

describe("ensureSkill", () => {
  test("远程源下载解包 + 锁文件登记 + 二次调用复用", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const zip = payloadZip()
    let downloads = 0
    const deps = { download: async () => (downloads++, zip) }
    const first = await ensureSkill(ctx, { deps })
    expect(first.ok).toBe(true)
    expect(first.skillDir).toBe(join(home, "vendor", "video-shotcraft", "skill"))
    expect(readFileSync(join(first.skillDir!, "SKILL.md"), "utf8")).toContain("video-shotcraft")
    const lock = readSkillLock(ctx) as SkillLock
    expect(lock.sourceKind).toBe("url")
    expect(lock.cards).toBe(157)
    expect(lock.styles).toBe(214)
    expect(lock.upstreamRevision).toBe("bdd94be16d60fa8f")
    expect(lock.archiveSha256).toBe(sha256Hex(zip))
    expect(lock.fileCount).toBe(Object.keys(PAYLOAD).length)

    const second = await ensureSkill(ctx, { deps })
    expect(second.ok).toBe(true)
    expect(second.actions.join(" ")).toContain("已就绪")
    expect(downloads).toBe(1)
  })

  test("全部远程源失败：给出离线供给指引", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const res = await ensureSkill(ctx, { deps: { download: async () => { throw new Error("network down") } } })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("SHOTCRAFT_SOURCE")
    expect(res.actions.filter((a) => a.includes("来源失败")).length).toBe(2)
  })

  test("本地目录来源：指针登记不复制，resolveSkillDir 指向该目录", async () => {
    const local = writePayload(join(tmpRoot(), "clone"))
    const home = tmpRoot()
    const { ctx } = makeCtx(home, { SHOTCRAFT_SOURCE: local })
    const res = await ensureSkill(ctx, { deps: { download: async () => { throw new Error("不应联网") } } })
    expect(res.ok).toBe(true)
    expect(res.skillDir).toBe(local)
    expect(resolveSkillDir(ctx)).toBe(local)
    expect(readSkillLock(ctx)?.sourceKind).toBe("local-dir")
    expect(readFileSync(join(home, "vendor/video-shotcraft/skill.lock.json"), "utf8")).toContain("local-dir")
  })

  test("update=true 时强制重新获取", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const deps = { download: async () => payloadZip() }
    await ensureSkill(ctx, { deps })
    const again = await ensureSkill(ctx, { update: true, deps })
    expect(again.actions.join(" ")).not.toContain("已就绪")
    expect(again.ok).toBe(true)
  })
})

describe("运行时安装", () => {
  test("npm ci 安装成功：锁文件 ready + Remotion 版本 + 二次调用复用", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const skill = writePayload(join(tmpRoot(), "skill"))
    let installs = 0
    const deps = {
      which: (cmd: string) => (cmd === "npm" ? "/fake/npm" : null),
      run: async (cmd: string[], opts: { cwd: string; onData?: (c: string) => void }) => {
        installs++
        expect(cmd[1]).toBe("ci")
        const remotionDir = join(opts.cwd, "node_modules", "remotion")
        mkdirSync(remotionDir, { recursive: true })
        writeFileSync(join(remotionDir, "package.json"), JSON.stringify({ version: "4.0.484" }))
        opts.onData?.("added 200 packages\n")
        return { code: 0, output: "added 200 packages" }
      },
    }
    const res = await ensureRuntime(ctx, { skill, deps })
    expect(res.ok).toBe(true)
    expect(res.lock?.status).toBe("ready")
    expect(res.lock?.packageManager).toBe("npm")
    expect(res.lock?.remotionVersion).toBe("4.0.484")
    expect(readRuntimeLock(ctx)?.remotionVersion).toBe("4.0.484")
    expect(res.actions.join(" ")).toContain("安装依赖")

    const again = await ensureRuntime(ctx, { skill, deps })
    expect(again.actions.join(" ")).toContain("已就绪")
    expect(installs).toBe(1)
  })

  test("安装失败：登记 failed 与错误尾部，不清理已复制文件", async () => {
    const home = tmpRoot()
    const { ctx } = makeCtx(home)
    const skill = writePayload(join(tmpRoot(), "skill"))
    const res = await ensureRuntime(ctx, {
      skill,
      deps: { which: (cmd) => (cmd === "npm" ? "/fake/npm" : null), run: async () => ({ code: 1, output: "npm ERR! network timeout" }) },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("依赖安装失败")
    expect(readRuntimeLock(ctx)?.status).toBe("failed")
    expect(readFileSync(join(res.runtimeDir, "package.json"), "utf8")).toContain("promo-template")
  })

  test("无 npm 无 bun：明确报错", async () => {
    const { ctx } = makeCtx(tmpRoot())
    const skill = writePayload(join(tmpRoot(), "skill"))
    const res = await ensureRuntime(ctx, { skill, deps: { which: () => null } })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("npm")
  })

  test("模板签名随模板 package.json 变化", () => {
    const skill = writePayload(join(tmpRoot(), "skill"))
    const before = templateSignature(skill)
    writeFileSync(join(skill, "template/package.json"), JSON.stringify({ name: "promo-template", dependencies: { remotion: "4.0.500" } }))
    expect(templateSignature(skill)).not.toBe(before)
    expect(templateSignature(join(tmpRoot(), "missing"))).toBe("missing")
  })
})

describe("模板复制", () => {
  test("复制源码与公共资源，排除 node_modules/out", () => {
    const skill = writePayload(join(tmpRoot(), "skill"))
    const target = join(tmpRoot(), "project")
    const copied = copyTemplate(skill, target)
    expect(copied).toContain("src")
    expect(readFileSync(join(target, "src/index.ts"), "utf8")).toContain("registerRoot")
    expect(readFileSync(join(target, "package.json"), "utf8")).toContain("promo-template")
    expect(() => readFileSync(join(target, "out/old.mp4"))).toThrow()
    expect(() => readFileSync(join(target, "node_modules/.bin/should-not-be-copied"))).toThrow()
  })
})
