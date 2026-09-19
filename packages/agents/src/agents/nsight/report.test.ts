/**
 * 报告解析与源码定位的单元测试：env 工具链解析、报告识别与缓存指纹、CSV 流式解析、符号→源码定位。
 * 全部用桩 ToolContext，不依赖 nsys/ncu 安装与 GPU。
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCommand, missingToolchainNote, probeCounterPermission, resolveNsightEnv, shellQuote, type NsightEnvState } from "./env"
import { cacheDirFor, detectReportKind, statReport, exportCommand, importNsys } from "./report"
import { cellAt, headerIndex, num, stallColumns, streamCsvFile } from "./csv"
import { locateSymbols, symbolBaseNames, renderLocate } from "../../core/perf/locate"
import { makeStubCtx, writeSourceFile } from "../../core/perf/test-ctx"

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "gebai-nsight-"))

describe("env（工具链解析与命令构造）", () => {
  test("shellQuote 按当前平台语法引用（空格/括号/单引号）", () => {
    const quoted = shellQuote("C:\\Program Files\\NVIDIA Corporation\\nsys.exe")
    expect(quoted.startsWith("'") || quoted.startsWith('"')).toBe(true)
    expect(quoted.endsWith("'") || quoted.endsWith('"')).toBe(true)
    expect(shellQuote("plain")).toMatch(/^['"]?plain['"]?$/)
  })

  test("buildCommand 在 Windows PowerShell 下带调用运算符（路径含空格必需）", () => {
    const cmd = buildCommand("C:\\Program Files\\x\\nsys.exe", ["--version"])
    if (process.platform === "win32") {
      expect(cmd.startsWith("& ")).toBe(true)
      expect(cmd).toContain("--version")
    } else {
      expect(cmd.startsWith("'C:\\Program Files")).toBe(true)
    }
  })

  test("环境变量指定可执行文件时优先采用（探测版本）", async () => {
    const root = tempRoot()
    const fake = join(root, "nsys.exe")
    writeFileSync(fake, "stub")
    const { ctx } = makeStubCtx(root, {
      env: { NSIGHT_SYSTEMS_BIN: fake },
      runCommand: async (cmd) => (cmd.includes("--version") ? { stdout: "NVIDIA Nsight Systems version 2025.1.3\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 }),
    })
    const env = await resolveNsightEnv(ctx)
    expect(env.nsys?.path).toBe(fake)
    expect(env.nsys?.source).toBe("env")
    expect(env.nsys?.version).toContain("2025.1.3")
    expect(env.cacheDir).toContain("cache")
  })

  test("环境变量指向不存在的文件时记入 issues 并回退自动探测", async () => {
    const root = tempRoot()
    const missing = join(root, "nope.exe")
    const { ctx } = makeStubCtx(root, {
      env: { NSIGHT_SYSTEMS_BIN: missing },
      runCommand: async () => ({ stdout: "", stderr: "", code: 1 }),
    })
    const env = await resolveNsightEnv(ctx)
    expect(env.issues.join(" ")).toContain("不存在")
    expect(env.nsys?.path).not.toBe(missing)
  })

  test("NSIGHT_CACHE_DIR 覆盖缓存根", async () => {
    const root = tempRoot()
    const custom = join(root, "my-cache")
    const { ctx } = makeStubCtx(root, { env: { NSIGHT_CACHE_DIR: custom }, runCommand: async () => ({ stdout: "", stderr: "", code: 1 }) })
    const env = await resolveNsightEnv(ctx)
    expect(env.cacheDir).toBe(custom)
  })

  test("缺工具链的说明含修复动作与环境变量名", () => {
    const env: NsightEnvState = { cacheDir: "/tmp", issues: [] }
    const note = missingToolchainNote(env, "both")
    expect(note).toContain("NSIGHT_SYSTEMS_BIN")
    expect(note).toContain("NSIGHT_COMPUTE_BIN")
    expect(missingToolchainNote({ cacheDir: "/tmp", nsys: { path: "n", version: "", source: "path" }, ncu: { path: "c", version: "", source: "path" }, issues: [] }, "both")).toBeNull()
  })

  test("性能计数器权限探测区分 denied / granted", async () => {
    const root = tempRoot()
    const denied = makeStubCtx(root, {
      runCommand: async () => ({ stdout: "", stderr: "==ERROR== ERR_NVGPUCTRPERM - The user does not have permission", code: 1 }),
    })
    const d = await probeCounterPermission(denied.ctx, "ncu")
    expect(d.state).toBe("denied")
    expect(d.detail).toContain("ERR_NVGPUCTRPERM")

    const granted = makeStubCtx(root, { runCommand: async () => ({ stdout: "Device 0: metrics...", stderr: "", code: 0 }) })
    expect((await probeCounterPermission(granted.ctx, "ncu")).state).toBe("granted")
  })
})

describe("report（报告识别/指纹/导入）", () => {
  test("按扩展名识别报告类型（大小写不敏感）", () => {
    expect(detectReportKind("a.nsys-rep")).toBe("nsys")
    expect(detectReportKind("a.QDSTRM")).toBe("nsys")
    expect(detectReportKind("a.ncu-rep")).toBe("ncu")
    expect(detectReportKind("a.nsys-rep.bak")).toBeNull()
    expect(detectReportKind("a.sqlite")).toBeNull()
  })

  test("statReport：不存在/目录/未知类型分别报错", async () => {
    const root = tempRoot()
    const { ctx } = makeStubCtx(root)
    await expect(statReport(ctx, "missing.nsys-rep")).rejects.toThrow("不存在")
    await expect(statReport(ctx, ".")).rejects.toThrow("目录")
    const other = join(root, "x.txt")
    writeFileSync(other, "x")
    await expect(statReport(ctx, other)).rejects.toThrow("无法识别的报告类型")
  })

  test("缓存目录按内容指纹（名-大小-mtime）寻址：报告重新采集不误用旧缓存", async () => {
    const root = tempRoot()
    const abs = join(root, "r.nsys-rep")
    writeFileSync(abs, "12345")
    const { ctx } = makeStubCtx(root)
    const ref1 = await statReport(ctx, abs)
    const env: NsightEnvState = { cacheDir: join(root, "cache"), issues: [] }
    const dir1 = cacheDirFor(env, ref1)
    expect(dir1).toContain("r-5-")
    const ref2 = { ...ref1, size: 6, mtimeMs: ref1.mtimeMs + 1000 }
    expect(cacheDirFor(env, ref2)).not.toBe(dir1)
  })

  test("导出命令引用路径（含空格安全）", () => {
    const env: NsightEnvState = { cacheDir: "/tmp", nsys: { path: "C:\\Program Files\\Nsight\\nsys.exe", version: "", source: "scan" }, issues: [] }
    const cmd = exportCommand(env, { path: "C:\\my dirs\\a.nsys-rep", name: "a.nsys-rep", stem: "a", kind: "nsys", size: 1, mtimeMs: 1 }, "/tmp/cache/x")
    expect(cmd).toContain("--type")
    expect(cmd).toContain("sqlite")
    expect(cmd).toContain("a.nsys-rep")
  })

  test("导入超出时间预算时返回 pending + 可后台执行的命令（不静默失败）", async () => {
    const root = tempRoot()
    const abs = join(root, "big.nsys-rep")
    writeFileSync(abs, "fake")
    const { ctx } = makeStubCtx(root, { runCommand: async () => ({ stdout: "collecting...", stderr: "", code: 0 }) })
    const env: NsightEnvState = { cacheDir: join(root, "cache"), nsys: { path: "nsys", version: "v", source: "path" }, issues: [] }
    const ref = await statReport(ctx, abs)
    const res = await importNsys(ctx, env, ref, { budgetMs: 5 })
    expect(res.pending).toBe(true)
    expect(res.artifacts.length).toBe(0)
    expect(res.command).toContain("export")
    expect(res.note).toContain("再次调用")
  })
})

describe("csv（流式解析）", () => {
  test("引号、逗号、字段内换行与转义引号均按 RFC4180 解析", async () => {
    const root = tempRoot()
    const p = join(root, "t.csv")
    writeFileSync(p, 'a,b,c\n1,"x,y","line1\nline2"\n2,"he said ""hi""",3\n')
    const rows: string[][] = []
    for await (const r of streamCsvFile(p)) rows.push(r)
    expect(rows[0]).toEqual(["a", "b", "c"])
    expect(rows[1]).toEqual(["1", "x,y", "line1\nline2"])
    expect(rows[2]).toEqual(["2", 'he said "hi"', "3"])
  })

  test("表头索引与取值、数值解析容忍千分位与空值", () => {
    const header = ["ID", "Metric Name", "Metric Value", "stall_wait", "stall_long_sb (Not Issued)"]
    const index = headerIndex(header)
    expect(cellAt(["7", "Duration", "1,234", "3", "9"], index, "Metric Value")).toBe("1,234")
    expect(num("1,234")).toBe(1234)
    expect(num("-")).toBeUndefined()
    expect(num("")).toBeUndefined()
    // "(Not Issued)" 变体是不带该停顿的参照列，不作为停顿原因
    expect(stallColumns(header).map((s) => s.name)).toEqual(["wait"])
  })
})

describe("locate（符号 → 源码定位）", () => {
  const project = (): string => {
    const root = tempRoot()
    writeSourceFile(
      root,
      "kernels/my_kernel.cu",
      [
        "#include <cuda_runtime.h>",
        "__global__ void scaleKernel(float* data, float factor, int n) {",
        "    int i = blockIdx.x * blockDim.x + threadIdx.x;",
        "    if (i < n) data[i] *= factor;",
        "}",
        "",
        "void launch(float* d, int n) {",
        "    scaleKernel<<<(n + 255) / 256, 256>>>(d, 2.0f, n);",
        "}",
      ].join("\n"),
    )
    writeSourceFile(root, "train.py", ['import torch', 'def step(x):', '    torch.cuda.nvtx.range_push("phase_step")', '    return x @ x.t()'].join("\n"))
    return root
  }

  test("符号归一：demangled 名取函数基名；mangled 名与通用词不产生搜索词", () => {
    expect(symbolBaseNames("void scaleKernel<float>(float*, float, int)")).toContain("scaleKernel")
    expect(symbolBaseNames("at::native::vectorized_elementwise_kernel<4, Foo>(int)")).toContain("vectorized_elementwise_kernel")
    expect(symbolBaseNames("_Z11scaleKernelPffi")).toEqual([])
    expect(symbolBaseNames("void cutlass::Kernel<Params>(T)")).not.toContain("Kernel")
  })

  test("命中内核定义与启动点，并给出文件:行", async () => {
    const root = project()
    const { ctx } = makeStubCtx(root, { files: [{ path: "kernels/my_kernel.cu", size: 300 }, { path: "train.py", size: 100 }] })
    const summary = await locateSymbols(ctx, [{ kind: "kernel", value: "void scaleKernel<float>(float*, float, int)" }])
    const r = summary.results[0]!
    const kinds = r.matches.map((m) => m.kind)
    expect(kinds).toContain("kernel-def")
    expect(kinds).toContain("kernel-launch")
    expect(r.matches.find((m) => m.kind === "kernel-def")!.line).toBe(2)
    expect(r.matches.find((m) => m.kind === "kernel-launch")!.line).toBe(8)
    expect(r.matches.every((m) => m.path === "kernels/my_kernel.cu")).toBe(true)
  })

  test("NVTX 名定位到打点行（框架工作负载定位到用户代码的主要通道）", async () => {
    const root = project()
    const { ctx } = makeStubCtx(root, { files: [{ path: "kernels/my_kernel.cu", size: 300 }, { path: "train.py", size: 100 }] })
    const summary = await locateSymbols(ctx, [{ kind: "nvtx", value: "phase_step" }])
    const m = summary.results[0]!.matches[0]!
    expect(m.path).toBe("train.py")
    expect(m.line).toBe(3)
    expect(m.kind).toBe("nvtx")
  })

  test("词边界匹配：通用短词不再命中无关行（子串匹配会误报 path/arrange）", async () => {
    const root = tempRoot()
    writeSourceFile(root, "a.py", ["import os", "path = 1", "arrange = 2"].join("\n"))
    const { ctx } = makeStubCtx(root, { files: [{ path: "a.py", size: 20 }] })
    const summary = await locateSymbols(ctx, [{ kind: "kernel", value: "at::native::Mystery" }], { extraTerms: ["at", "range"] })
    expect(summary.results[0]!.matches.length).toBe(0)
    expect(summary.results[0]!.terms).toContain("Mystery")
  })

  test("mangled 输入给出可操作提示而非无声无命中", async () => {
    const root = project()
    const { ctx } = makeStubCtx(root, { files: [{ path: "kernels/my_kernel.cu", size: 300 }] })
    const summary = await locateSymbols(ctx, [{ kind: "kernel", value: "_Z11scaleKernelPffi" }])
    const out = renderLocate(summary).join("\n")
    expect(out).toContain("mangled")
    expect(out).toContain("demangled")
  })

  test("库内核无命中时提示优化点在上层调用方式", async () => {
    const root = project()
    const { ctx } = makeStubCtx(root, { files: [{ path: "kernels/my_kernel.cu", size: 300 }] })
    const summary = await locateSymbols(ctx, [{ kind: "kernel", value: "void cutlass_80_simt_sgemm_256x128_nn(T)" }])
    expect(summary.results[0]!.matches.length).toBe(0)
    expect(summary.results[0]!.note).toContain("预编译库")
  })

  test("超大源文件被跳过时标记扫描不完整（不静默漏报）", async () => {
    const root = tempRoot()
    const files: Array<{ path: string; size: number }> = []
    for (let i = 0; i < 5; i++) {
      writeSourceFile(root, `f${i}.cu`, "__global__ void k() {}")
      files.push({ path: `f${i}.cu`, size: 22 })
    }
    const { ctx } = makeStubCtx(root, { files })
    // 人为压低上限：通过大文件触发总字节上限
    const big = makeStubCtx(root, { files: [{ path: "huge.cu", size: 200 * 1024 * 1024 }] })
    const summary = await locateSymbols(big.ctx, [{ kind: "kernel", value: "k" }])
    expect(summary.scanTruncated).toBe(true)
    expect(summary.scannedFiles).toBe(0)
    const normal = await locateSymbols(ctx, [{ kind: "kernel", value: "k" }])
    expect(normal.scanTruncated).toBe(false)
    expect(normal.scannedFiles).toBe(5)
  })
})
