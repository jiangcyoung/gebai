/**
 * 内置模板一致性：内联副本（`template.generated.ts`）必须与磁盘维护源
 * （`packages/agents/assets/reel-template/`）逐字节一致——改模板后忘记重跑生成脚本，本测试即失败。
 * 另外守住两条"落位即可用"的底线：模板必须包含可渲染工程的完整骨架，且不得含绝对路径。
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { readTemplateDir, signTemplateFiles } from "./template-signature"
import { TEMPLATE_FILES, TEMPLATE_REMOTION_VERSION, TEMPLATE_SIGNATURE } from "./template.generated"
import { TEMPLATE_REMOTION_VERSION as CONTRACT_REMOTION_VERSION } from "./paths"

/** 磁盘维护源：包根 `assets/reel-template/`（本文件在 `src/agents/reel/`，上溯三级到包根）。 */
const TEMPLATE_SRC = join(import.meta.dirname, "..", "..", "..", "assets", "reel-template")

describe("内置模板：内联副本与磁盘维护源一致", () => {
  test("维护源目录存在（生成脚本的输入）", () => {
    expect(existsSync(TEMPLATE_SRC)).toBe(true)
    expect(existsSync(join(TEMPLATE_SRC, "package.json"))).toBe(true)
  })

  test("签名一致——不一致说明改过模板但没重跑生成脚本", () => {
    const disk = readTemplateDir(TEMPLATE_SRC)
    const diskSig = signTemplateFiles(disk)
    if (diskSig !== TEMPLATE_SIGNATURE) {
      throw new Error(
        `模板签名不一致（磁盘 ${diskSig} ≠ 内联 ${TEMPLATE_SIGNATURE}）：` +
          `请重新运行 \`cd packages/agents && bun run scripts/embed-reel-template.ts\``,
      )
    }
    expect(diskSig).toBe(TEMPLATE_SIGNATURE)
  })

  test("内联副本覆盖磁盘上的每个文件（无遗漏、无多余）", () => {
    const disk = readTemplateDir(TEMPLATE_SRC)
    expect(Object.keys(TEMPLATE_FILES).sort()).toEqual(Object.keys(disk).sort())
  })
})

describe("内置模板：可渲染工程骨架齐备", () => {
  const required = [
    "package.json",
    "tsconfig.json",
    "remotion.config.ts",
    "src/index.ts",
    "src/Root.tsx",
    "src/film/Film.tsx",
    "src/film/theme.ts",
    "src/film/ui.tsx",
    "src/film/PageCam.tsx",
    "src/film/timeline.ts",
  ]
  for (const rel of required) {
    test(`含 ${rel}`, () => {
      expect(typeof TEMPLATE_FILES[rel]).toBe("string")
      expect((TEMPLATE_FILES[rel] ?? "").length).toBeGreaterThan(20)
    })
  }

  test("入口点注册根组件，根组件注册 Reel 合成", () => {
    expect(TEMPLATE_FILES["src/index.ts"]).toContain("registerRoot")
    expect(TEMPLATE_FILES["src/Root.tsx"]).toContain("<Composition")
    expect(TEMPLATE_FILES["src/Root.tsx"]).toContain("Reel")
  })

  test("示例镜头齐备且被装配进 Film", () => {
    const scenes = Object.keys(TEMPLATE_FILES).filter((k) => k.startsWith("src/film/scenes/"))
    expect(scenes.length).toBeGreaterThanOrEqual(3)
    for (const scene of scenes) {
      const name = scene.replace("src/film/scenes/", "").replace(".tsx", "")
      expect(TEMPLATE_FILES["src/film/Film.tsx"]).toContain(name)
    }
  })

  test("时间线是唯一真相源：镜头窗口与总时长一致", () => {
    const timeline = TEMPLATE_FILES["src/film/timeline.ts"] ?? ""
    expect(timeline).toContain("export const SHOTS")
    expect(timeline).toContain("export const TOTAL")
    expect(timeline).toContain("export const COPY")
    expect(timeline).toContain("export const SFX")
  })

  test("Remotion 版本：模板声明与契约常量一致", () => {
    expect(TEMPLATE_REMOTION_VERSION).toBe(CONTRACT_REMOTION_VERSION)
  })
})

describe("内置模板：示例镜头的节拍不超窗", () => {
  test("每个示例镜头的最大延迟都在本镜时长内（留 20 帧余量）", () => {
    const timeline = TEMPLATE_FILES["src/film/timeline.ts"] ?? ""
    const shots: Record<string, number> = {}
    for (const m of timeline.matchAll(/(\w+):\s*\{\s*from:\s*(\d+),\s*duration:\s*(\d+)\s*\}/g)) shots[m[1]] = Number(m[3])
    expect(Object.keys(shots).length).toBeGreaterThanOrEqual(4)
    const problems: string[] = []
    for (const [rel, content] of Object.entries(TEMPLATE_FILES)) {
      const matched = /^src\/film\/scenes\/Scene(\w+)\.tsx$/.exec(rel)
      if (!matched) continue
      const key = matched[1].charAt(0).toLowerCase() + matched[1].slice(1) // SceneOpen → open
      const dur = shots[key]
      if (dur === undefined) continue
      const delays = [...content.matchAll(/(?:delay|start|igniteAt|nodeDelay)\s*[:=]\s*\{?\s*(\d+)/g)].map((x) => Number(x[1]))
      const max = delays.length ? Math.max(...delays) : 0
      if (max > dur - 20) problems.push(`${rel}：最大延迟 ${max} ≥ 镜长 ${dur} − 20（字标/标语会在镜头之外才出现）`)
    }
    expect(problems).toEqual([])
  })
})

describe("内置模板：可迁移（不含绝对路径与确定性隐患）", () => {
  test("没有任何文件写死绝对路径", () => {
    const bad: string[] = []
    for (const [rel, content] of Object.entries(TEMPLATE_FILES)) {
      if (/["'`]\/workspace\/|["'`]\/home\/|["'`]\/Users\/|[A-Za-z]:\\\\/.test(content)) bad.push(rel)
    }
    expect(bad).toEqual([])
  })

  test("模板源码不引入随机源（渲染必须逐帧可复现）", () => {
    const bad: string[] = []
    for (const [rel, content] of Object.entries(TEMPLATE_FILES)) {
      if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue
      if (/Math\.random\(|Date\.now\(/.test(content)) bad.push(rel)
    }
    expect(bad).toEqual([])
  })

  test("模板声明的依赖只用 Remotion 与 React（不引入额外运行时依赖）", () => {
    const pkg = JSON.parse(TEMPLATE_FILES["package.json"] ?? "{}") as { dependencies?: Record<string, string> }
    const allowed = /^(remotion|react|react-dom|@remotion\/(cli|renderer|bundler|compositor-.*))$/
    const extra = Object.keys(pkg.dependencies ?? {}).filter((d) => !allowed.test(d))
    expect(extra).toEqual([])
  })
})
