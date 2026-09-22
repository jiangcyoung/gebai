# engine — 引擎 fork 与补丁

自持 llama.cpp fork 的目的不是"重新发明引擎"，而是把三类**上游不做、但本机场景关键**的事做实：

1. **修 qwen3_5 混合线性注意力的已确认缺陷**（上游 issue 尚未闭合）
2. **针对 16GB 显存 + 32GB 内存异构 MoE 的定向优化**（上游面向通用场景）
3. **完全可控**：每个改动有基准数据、可单独回退、可随时重放

---

## 一、基线

| 项 | 值 |
|---|---|
| 上游 | `ggml-org/llama.cpp` |
| 基线 tag | `b11100`（2026-09-22） |
| 架构支持 | `qwen35moe`（PR #19435，2026-02-08 合并；含 `src/models/qwen35.cpp` / `qwen35moe.cpp` / `delta-net-base.cpp`） |
| 预编译产物 | `llama-b11100-bin-win-cuda-12.4-x64.zip`（**P0 基线用，无需编译器**） |

> 骨架阶段先跑通预编译二进制；fork 与自建在 P4 展开。

---

## 二、构建（自建 fork）

### 已知工具链约束（实测）

| 组合 | 结果 |
|---|---|
| CUDA 12.9 nvcc + VS2026（MSVC 14.51） | ❌ `host_config.h` 硬拒：`unsupported Microsoft Visual Studio version` |
| 同上 + `-allow-unsupported-compiler` | ❌ `cudafe++` ACCESS_VIOLATION 崩溃（非警告） |
| CUDA 13.x + VS2026 | ⚠️ 可编译，但本机驱动 576.02 仅支持到 CUDA 12.9 runtime |
| **VS18 内置的 14.44 工具集**（`vcvars64.bat -vcvars_ver=14.44`） | ✅ **本机构建方案**：VS Installer 可在同一实例内并存多个 MSVC 工具集，装上 VS2022 era 工具集（14.44.35207）后 nvcc 直接可用 |
| 免安装 clang-cl（LLVM 官方包） | ✅ 备选（`-ccbin clang-cl`），无需管理员 |

**为什么关键**：nvcc 12.9 只接受 `_MSC_VER ≤ 1949`（VS2022）；VS Installer 的多工具集并存特性让
“不卸载 VS2026、也不装第二个 VS”成为可能——只需在 VS Installer 里勾选旧版 MSVC 生成工具组件。

`build-cuda-1444.bat` 即该方案的完整实现（vcvars 选 14.44 → cmake 配 CUDA/sm_89 → 构建）。

> **实测捷径**：上述约束**只影响自建**。官方预编译的 win-cuda-12.4 包不需要任何编译器，
> 且补上 `cudart64_12.dll + cublas64_12.dll + cublasLt64_12.dll` 后**完全自包含**，
> 不依赖 CUDA Toolkit 安装（已验证）。

`../scripts/build-engine.ps1` 已内置上述门禁：CUDA 后端会先读 MSVC 主版本，
命中 ≥14.50（VS2026）时直接给出可操作的报错，而不是编译到一半再崩溃；
`CMAKE_CUDA_HOST_COMPILER` 由脚本按探测结果自动填入。

### 何时才需要自建（启动条件）

自建 fork 是**按需启动的储备能力**。上游 qwen3_5 的已知问题在当前使用方式下均未触发
（现成 GGUF + 纯文本路径），参数层也已由实测确认无剩余空间——因此没有自发启动的动机。
本目录的价值是**保证要用时能立刻开工**；完整的启动条件见 `../README.md` 的「引擎改造的启动条件」。

### 构建命令（Windows CUDA，待工具链就位后校准）

```powershell
cmake -B build -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DGGML_CUDA=ON `
  -DCMAKE_CUDA_ARCHITECTURES=89 `
  -DCMAKE_CUDA_COMPILER="C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9\bin\nvcc.exe" `
  -DCMAKE_CUDA_HOST_COMPILER="<VS2022 or clang-cl 的 cl.exe/clang-cl.exe>" `
  -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build build --config Release -j 16
```

自建产物落 `engine/build/`，由 `config/profiles.json` 的 `engine_dir` 切换（与预编译包并存，便于 A/B 对比）。

---

## 三、补丁清单

### A. 正确性（上游未闭合 issue）

| 编号 | 上游条目 | 症状 | 计划 |
|---|---|---|---|
| A1 | #27019 / PR #27132 | `convert_hf_to_gguf` 对混合线性注意力张量处理有误（`ssm_conv1d` 核维度、`in_proj_a/b` 扩展） | 需自转换时应用；直接用现成 GGUF 可规避 |
| A2 | #26916 | 混合模型加载报 `tensor 'blk.32.attn_norm.weight' not found` | 加载期张量图校验，锁定层映射/stride |
| A3 | #28166 | 混合递归模型 mrope 位置警告（图像路径） | 纯文本影响小，跟踪 |
| A4 | #28879 | GDN 架构 perplexity **非精度单调**（F16 反不如 Q4_K_M） | **关键**：不采用"精度越高越好"的直觉，改用实测质量标尺选档 |

### B. 性能（针对实测瓶颈）

**实测给出的靶心**：解码 143 t/s，而按显存带宽推算的理论上限约 1750 t/s（利用率仅 8.2%）。
同时参数层扫描（线程/batch/FA/KV）**全部无差异**，且权重多 8.5% 的档位只慢 4%——
三者共同指向：**瓶颈是每 token 320 次小 GEMM（40 层 × 8 专家）的启动与图调度固定开销，而非带宽**。
因此所有性能补丁都必须瞄准「降低固定开销」，而不是「加快数据搬运」。

| 编号 | 目标 | 手段 | 验收 |
|---|---|---|---|
| B1 | 减少内核启动次数 | 同一层多专家的 GEMV 合并为单次批量调用（核实现有 `ggml_mul_mat_id` 的批处理粒度是否已最优） | 解码 tok/s 提升 ≥10% |
| B2 | 压缩图调度开销 | 减少每 token 的图重建 / 提交次数，提升图复用率 | 同上，并用 `graphs reused` 计数佐证 |
| B3 | 线性注意力层开销 | 检查 DeltaNet（`delta-net-base.cpp`）逐 token 递推的同步点 | 逐层耗时剖析佐证 |
| B4 | CUDA graphs 覆盖度 | 确认解码路径全部落入 CUDA graph（未覆盖部分会退回逐次 launch） | 对比启用/禁用下的每 token 耗时 |

> **测量先行**：动手前应先用 `nsight` 子Agent（nsys 采集）取到逐内核时间线，
> 确认 320 次 GEMM 中真正的时间去向——不做剖析就改内核，等于猜。

> 每项补丁必须带 `bench/reports/` 的前后对比数据，且过 `verify.ps1` 质量回归；
> 无数据不入库；不达标回滚。

---

## 四、同步上游

```powershell
git -C engine remote add upstream https://github.com/ggml-org/llama.cpp
git -C engine fetch upstream master
git -C engine rebase upstream/master      # 补丁以独立 commit 保存，便于 rebase
```

补丁以「一个补丁一个 commit」为原则，commit message 带 issue 编号与基准结论，便于上游化与回退。
