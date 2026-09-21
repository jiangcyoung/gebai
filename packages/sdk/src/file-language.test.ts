/**
 * 路径 → 语言 id 的**路径形态矩阵**测试（`@gebai/sdk` 的 `file-language.ts`）。
 *
 * 这条映射喂两个消费方（服务端 `fs/read` 的 `language`、前端差异/比较/合并视图），错一条不影响
 * 正确性、只让某个文件悄悄变成 `plaintext`（丢高亮与符号）。因此把真实会用到的路径形态**逐类钉住**：
 * 正反斜杠、绝对/相对、深嵌套、中文、空格、特殊字符、大小写扩展名、多点评名、无扩展名特殊名与其
 * 变体、点文件、尾随脏字符。
 *
 * 用例里的路径都是**歌白仓库真实出现过或可预期的形态**（`keqing/go/disk/clean.go`、`.env.example`、
 * `Cargo.toml`、`docs/screenshots/*.png`…）。
 */
import { describe, expect, test } from "bun:test"
import { baseNameOfPath, effectiveLanguageOf, extOfPath, languageOfPath } from "./file-language"

describe("路径分隔与形态", () => {
  const cases: Array<[string, string, string]> = [
    // [路径, 期望语言, 说明]
    ["keqing/go/disk/clean.go", "go", "普通相对路径"],
    ["/workspace/gebai/keqing/go/disk/clean.go", "go", "POSIX 绝对路径"],
    ["C:\\workspace\\gebai\\keqing\\go\\disk\\clean.go", "go", "Windows 绝对路径"],
    ["src\\nested\\deep\\helper.py", "python", "反斜杠相对路径"],
    ["\\\\server\\share\\proj\\main.go", "go", "UNC 路径"],
    ["//server/share/proj/main.go", "go", "UNC（正斜杠形态）"],
    ["a/b/c/d/e/f/g/h/i/j/k/main.go", "go", "10 层深嵌套"],
    ["中文目录/源码/主程序.go", "go", "中文目录与文件名"],
    ["my project/src/my file.ts", "typescript", "含空格的目录与文件名"],
    ["a+b#c@d(e)[f]%g/x.go", "go", "Shell 特殊字符"],
    ["src/MAIN.GO", "go", "扩展名大写"],
    ["src/App.TSX", "typescript", "扩展名大写（TSX）"],
    ["src/foo.test.ts", "typescript", "多点评名"],
    ["src/types/a.d.ts", "typescript", "声明文件（多点评名）"],
    ["docs/screenshots/file-workbench.png", "plaintext", "图片（无语言）"],
    ["src/main.go ", "go", "尾随空格（Windows 复制路径常见脏名）"],
    ["src/main.go.", "go", "尾随点（脏名）"],
    [".config/x.go", "go", "隐藏目录"],
    ["中文 目录/带 空格/文件.py", "python", "中文 + 空格混合"],
  ]
  for (const [path, lang, note] of cases) {
    test(`${note}：${path}`, () => {
      expect(languageOfPath(path)).toBe(lang)
    })
  }
})

describe("无扩展名特殊名与点文件", () => {
  test("基础特殊名", () => {
    expect(languageOfPath("Dockerfile")).toBe("dockerfile")
    expect(languageOfPath("docker/Dockerfile")).toBe("dockerfile")
    expect(languageOfPath("Makefile")).toBe("makefile")
    expect(languageOfPath("CMakeLists.txt")).toBe("cmake")
    expect(languageOfPath(".editorconfig")).toBe("ini")
    expect(languageOfPath(".gitconfig")).toBe("ini")
    expect(languageOfPath(".bashrc")).toBe("shell")
    expect(languageOfPath(".zshrc")).toBe("shell")
  })

  test("变体形态（前缀规则）：Dockerfile.dev / Makefile.am / .env.local 这类真实存在", () => {
    expect(languageOfPath("Dockerfile.dev")).toBe("dockerfile")
    expect(languageOfPath("docker/Dockerfile.prod")).toBe("dockerfile")
    expect(languageOfPath("Makefile.am")).toBe("makefile")
    expect(languageOfPath(".env.local")).toBe("ini")
    expect(languageOfPath(".env.example")).toBe("ini") // 仓库根就有这个文件
    expect(languageOfPath("app/.env.production")).toBe("ini")
  })

  test("前缀规则不误伤：envoy.yaml / environment.ts / makefile-helper.ts 不按特殊名处理", () => {
    expect(languageOfPath("config/envoy.yaml")).toBe("yaml")
    expect(languageOfPath("src/environment.ts")).toBe("typescript")
    expect(languageOfPath("makefile-helper.ts")).toBe("typescript")
    expect(languageOfPath("dockerfile_gen.py")).toBe("python")
    // 反向：真变体（扩展名认不出）仍由前缀规则接管
    expect(languageOfPath("Makefile.am")).toBe("makefile")
    expect(languageOfPath("LICENSE.txt")).toBe("plaintext")
  })

  test("按设计保持 plaintext 的（不硬凑语言，免得给出错误的符号与高亮）", () => {
    expect(languageOfPath(".gitignore")).toBe("plaintext")
    expect(languageOfPath(".gitattributes")).toBe("plaintext")
    expect(languageOfPath("LICENSE")).toBe("plaintext")
    expect(languageOfPath("keqing/go/go.mod")).toBe("plaintext") // go.mod 无 Monaco 语言（文本查看）
    expect(languageOfPath("Cargo.lock")).toBe("plaintext")
    expect(languageOfPath("yarn.lock")).toBe("plaintext")
  })
})

describe("仓库真实文件的抽查", () => {
  const cases: Array<[string, string]> = [
    ["AGENTS.md", "markdown"],
    ["docs/file-workbench-implementation.md", "markdown"],
    ["packages/web/src/files/lsp.ts", "typescript"],
    ["packages/web/files.html", "html"],
    ["packages/web/src/css/files.css", "css"],
    ["packages/web/public/vendor/tree-sitter/tree-sitter.js", "javascript"],
    ["packages/server/src/core/lsp/project-root.ts", "typescript"],
    ["keqing/go/framework/framework.go", "go"],
    ["keqing/go/go.mod", "plaintext"],
    ["keqing/rust/framework/src/lib.rs", "rust"],
    ["keqing/rust/framework/Cargo.toml", "ini"],
    ["keqing/cpp/framework.hpp", "cpp"],
    ["keqing/cpp/stb/stb_image.h", "c"],
    ["keqing/python/vision/tools.py", "python"],
    ["keqing/cpp/build.sh", "shell"],
    ["keqing/cpp/build.bat", "bat"],
    ["scripts/resources.manifest.json", "json"],
    [".env.example", "ini"],
    ["[图片占位].png", "plaintext"],
  ]
  for (const [path, lang] of cases) {
    test(`${path} → ${lang}`, () => {
      expect(languageOfPath(path)).toBe(lang)
    })
  }
})

describe("库文件（工作区外）的路径判定", () => {
  test("typeshed 存根与 C++ 库头扩展名", () => {
    expect(languageOfPath("typeshed-fallback/stdlib/os/__init__.pyi")).toBe("python")
    expect(languageOfPath("/usr/include/c++/13/bits/stl_vector.hxx")).toBe("cpp")
    expect(languageOfPath("vendor/foo/impl.ipp")).toBe("cpp")
    expect(languageOfPath("vendor/foo/impl.tcc")).toBe("cpp")
    expect(languageOfPath("vendor/foo/impl.inl")).toBe("cpp")
  })

  test("无扩展名的库文件仍按 plaintext（由跳转来源的语言提示兜底，不在路径层猜）", () => {
    // C++ 标准库头就叫 `string`/`vector`：路径上没有任何可判信息，不硬猜（否则会把 `LICENSE` 之类也误判）
    expect(languageOfPath("/usr/include/c++/13/string")).toBe("plaintext")
    expect(languageOfPath("/usr/include/c++/13/vector")).toBe("plaintext")
  })
})

describe("effectiveLanguageOf（跨文件跳转的生效语言）", () => {
  test("路径判不出语言：用跳转来源的语言（无扩展名的库文件）", () => {
    expect(effectiveLanguageOf("plaintext", "cpp")).toBe("cpp")
    expect(effectiveLanguageOf("plaintext", "go")).toBe("go")
    expect(effectiveLanguageOf("plaintext", "rust")).toBe("rust")
  })

  test("C 家族歧义：`.h` 从 C++ 跳过去按 C++ 算（libstdc++ 的 .h 确实是 C++）", () => {
    expect(effectiveLanguageOf("c", "cpp")).toBe("cpp")
    expect(effectiveLanguageOf("cpp", "c")).toBe("c")
    expect(effectiveLanguageOf("c", "objective-c")).toBe("objective-c")
    // 同族且相同：不变
    expect(effectiveLanguageOf("cpp", "cpp")).toBe("cpp")
  })

  test("其余一律以路径为准（不做“来源语言优先”，跨语言跳转是真实存在的）", () => {
    expect(effectiveLanguageOf("typescript", "go")).toBe("typescript")
    expect(effectiveLanguageOf("python", "cpp")).toBe("python")
    expect(effectiveLanguageOf("markdown", "rust")).toBe("markdown")
    expect(effectiveLanguageOf("ini", "go")).toBe("ini")
  })

  test("无提示 / 空提示 / plaintext 提示：保持路径判定", () => {
    expect(effectiveLanguageOf("cpp")).toBe("cpp")
    expect(effectiveLanguageOf("cpp", "")).toBe("cpp")
    expect(effectiveLanguageOf("cpp", "   ")).toBe("cpp")
    expect(effectiveLanguageOf("plaintext", "plaintext")).toBe("plaintext")
    expect(effectiveLanguageOf("plaintext", null)).toBe("plaintext")
  })
})

describe("底层工具函数", () => {
  test("baseNameOfPath：正反斜杠都认，无路径时返回自身", () => {
    expect(baseNameOfPath("a/b/c.ts")).toBe("c.ts")
    expect(baseNameOfPath("a\\b\\c.ts")).toBe("c.ts")
    expect(baseNameOfPath("c.ts")).toBe("c.ts")
    expect(baseNameOfPath("")).toBe("")
    expect(baseNameOfPath("a/b/")).toBe("")
  })

  test("extOfPath：点文件整段当扩展名、尾随脏字符先剥、无扩展名返回空", () => {
    expect(extOfPath("a/b/c.TS")).toBe("ts")
    expect(extOfPath(".gitignore")).toBe("gitignore")
    expect(extOfPath("a/.env")).toBe("env")
    expect(extOfPath("c.go ")).toBe("go")
    expect(extOfPath(".env.example")).toBe("example") // 特殊名的判定在 languageOfPath（前缀规则）
    expect(extOfPath("Makefile")).toBe("")
    expect(extOfPath("a/.hidden")).toBe("hidden")
    expect(extOfPath("a/b.")).toBe("")
  })

  test("脏输入不抛错（前端会拿到各种来源的名称）", () => {
    for (const bad of ["", ".", "..", "/", "\\", "a/.", "   ", "a/b:c"]) {
      expect(() => languageOfPath(bad)).not.toThrow()
    }
    expect(languageOfPath("")).toBe("plaintext")
    expect(languageOfPath("   ")).toBe("plaintext")
  })
})
