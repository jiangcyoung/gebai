# infer — GEBAI 本地推理引擎

在 **RTX 4080 SUPER 16GB + 32GB 内存** 的消费级机器上，把 **Qwen-AgentWorld-35B-A3B**（35B 总参 / 3B 激活的混合线性注意力 MoE）
跑到"日常可用甚至好用"的速度。两条不可妥协的原则：

1. **最强性能** —— 每个决策都以实测 tok/s 与显存/内存占用说话，不以"能跑起来"为满足。
2. **完全可控** —— 自持引擎 fork、自有量化配方、自有服务层；不依赖任何云、不依赖黑盒二进制、每项优化可复现可回退。

---

## 一、硬件基线（实测）

| 项 | 实测值 | 对推理的含义 |
|---|---|---|
| GPU | RTX 4080 SUPER **16GB**（Ada, sm_89） | 装不下 35B 任何 ≥IQ3 全量权重 → **必须异构分层** |
| 显存带宽 | ~736 GB/s | 非专家权重（~3B）轻松容纳，是解码速度的"快车道" |
| 内存 | **32GB DDR5-4800 双通道** | 有效带宽 ~50–60GB/s，成为异构解码的**主瓶颈** |
| CPU | i7-14700KF，20C/28T | 专家层 GEMM 有充裕并行度（P-core 8 + E-core 12） |
| 磁盘 | NVMe，余 1.38TB | 模型加载与 checkpoint 快照充裕 |

**结论**：瓶颈不在算力，而在**内存带宽**。解码时每 token 需从内存搬运被激活的 8 个专家权重
（40 层 × 8 专家 × 512 中间维 × 3 矩阵 ≈ 每 token 十几 MB 级），
所以性能工程的核心是：**把尽量多的专家层塞进 GPU，把 CPU 侧流量压到最小，并用投机解码摊薄每 token 的搬运量**。

---

## 二、模型特性（`Qwen/Qwen-AgentWorld-35B-A3B`，modelscope 官方 Qwen 空间）

```
architectures: ["Qwen3_5MoeForConditionalGeneration"]
model_type:    qwen3_5_moe        → llama.cpp 架构名 qwen35moe（b11100 起原生支持）
```

| 结构 | 取值 | 对部署的意义 |
|---|---|---|
| 层数 | 40（+1 层 MTP） | MTP 层可作投机解码头 |
| 注意力 | **混合**：每 4 层中 3 层线性注意力（Gated-DeltaNet）+ 1 层 full attention | **KV cache 只有 10/40 层** → 128K 上下文仅 ~1.3GB，长上下文几乎是免费的 |
| 专家 | **256 选 8**，moe_intermediate 512，另加共享专家 | 专家参数占 ~32B/35B → **异构分层的甜点区**（每 token 只读 8/256） |
| hidden / vocab | 2048 / 248320 | 非专家部分很小（~3B），可全驻 GPU |
| 上下文 | 262144 | 远超日常所需；压缩/量化 KV 的收益有限，不必激进 |
| 权重 | BF16 21 shard ≈ 68GB | 必须量化；用 unsloth UD 量化档（含 imatrix） |
| 附带 | 视觉塔（config 标 `language_model_only: true`） | 本阶段走纯文本，视觉留待后续 |

### 实测张量布局（IQ4_XS 档，由 `scripts/inspect-gguf.py` 直接从 GGUF 读出）

```
GGUF v3 | 733 张量 | 架构 qwen35moe | chat_template 8044 字符
总 16.55 GiB (17.77 GB)

  expert(ffn_down)     40 张量   5.529 GiB   ████████████████████ 33%
  expert(ffn_gate)     40 张量   4.322 GiB   ███████████████      26%
  expert(ffn_up)       40 张量   4.322 GiB   ███████████████      26%
  attn_linear         370 张量   1.285 GiB   ████                  8%
  token_embd            1 张量   0.503 GiB   ██                    3%
  output                2 张量   0.389 GiB   █                     2%
  shared_expert       160 张量   0.125 GiB                         1%
  ffn_other            40 张量   0.078 GiB                         0%

  专家合计 14.174 GiB（85.6%），非专家 2.38 GiB（14.4%）
  每层专家 362.9 MiB  →  -ncmoe 每 +1 ≈ 省 363 MiB 显存
```

**由此得到的显存规划（先验，待实测校准）**：

| 项 | MiB |
|---|---|
| 显存总量 | 16376 |
| 系统/桌面占用 | ~900 |
| KV cache（32K, q8_0, 仅 10 层 full attn） | ~320 |
| 计算缓冲 | ~1500 |
| **可用于权重** | **~13656** |
| 非专家（必须驻 GPU） | 2437 |
| 可容纳专家 | 11219 → **约 31 层** |
| **推荐 ncmoe 起点** | **9 ~ 10**（40 − 31） |

CPU 侧每 token 流量（ncmoe=10）：`10 层 × 8 专家 × 1.384 MiB ≈ 111 MiB`，
在有效内存带宽 ~45GB/s 下约 2.6ms → **理论上限约 380 tok/s**（实际受 CPU GEMM / 内存延迟制约，会显著更低）。

> **两个由布局推出的优化方向**（P3 验证）：
> 1. **张量粒度 offload**：`ffn_down` 用了更高位宽（0.540 vs 0.422 MiB/专家，unsloth 认为 down 更重要）。
>    只把 `ffn_down_exps` 放 CPU（`-ot` 而非 `-ncmoe`）可让 40 层 gate/up 全驻 GPU = 8.64 GiB，
>    但 CPU 流量升至 173 MiB/token —— 与 ncmoe=10 的 111 MiB 对比，**需实测择优**。
> 2. **自有量化可能省出空间**：把 down 压到与 gate/up 同位宽可省约 1.2GB → 多放 1–2 层专家进显存。

**为什么它是 16GB 卡的最佳拍档**：MoE 稀疏 + 线性注意力，使得"小显存 + 大内存"的组合不至于崩盘——
对比同规模的稠密 35B，激活参数量小一个数量级，且 KV 压力几乎消失。

---

## 三、技术路线

```
┌──────────────────────────── RTX 4080 SUPER 16GB ────────────────────────────┐
│  tok_embd / output / attn / DeltaNet / 共享专家 / 前 N 层之外的专家权重        │
│  KV cache（仅 10 层 full attention）                                         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │ PCIe 4.0 x16 (~25GB/s，单向实测)
┌──────────────────────────────────┴──────────────────────────────────────────┐
│  32GB DDR5：被 offload 的 MoE 专家权重（-ncmoe N / -ot 张量级指定）           │
│  每 token 只解引用被路由到的 8 个专家 → 稀疏访问，不像稠密那样等比搬运          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**为什么选 llama.cpp 而不是 vLLM/SGLang**（已逐一核实，2026-09）：

| 引擎 | 结论 |
|---|---|
| **llama.cpp** | ✅ 原生 `qwen35moe`（PR #19435 已合并，含 Gated-DeltaNet 内核），且有 `-ot/--override-tensor`、`-cmoe/-ncmoe`、`--spec-type` 全套异构与投机开关 → **唯一能在 16GB 显存跑 35B 的成熟引擎** |
| vLLM | ✅ 已支持 `qwen3_5`，但权重必须全驻显存 → INT4 也要 ~20GB > 16GB，**结构性不可行** |
| SGLang | ❌ 无 qwen3_5 支持 |

### 调优维度（性能工程的主战场）

| 维度 | 手段 | 预期作用 |
|---|---|---|
| 显存规划 | `-ncmoe N`（前 N 层专家留 CPU）/ `-ot` 张量级覆盖（可细到 `ffn_down_exps` 单张量）/ `-ngl` | 结论已定：**全部专家驻显存**（`-ncmoe 0`）压倒性最优，offload 只在显存装不下时才用 |
| 投机解码 | `--spec-type`（`draft-mtp` / `ngram-mod` / `ngram-cache` 等） | **已实测排除**：自由文本缺可预测重复模式，命中率过低反低于无投机基线——不启用 |
| KV 精度 | `-ctk q8_0 / -ctv q8_0` | KV 本就小，收益有限但释放的显存可换更多专家层上 GPU |
| 计算图 | `-fa on`、`-ub/-b` 批大小、`--no-op-offload` | 提升 prompt processing 与批吞吐 |
| CPU 侧 | 线程数/亲和性 | 仅在启用 offload 时才有意义（全 GPU 配置下不影响） |
| 量化 | 换档位；自有 imatrix 重配比（非专家高精度 + 专家低精度） | **最高优先级旋钮**：能否全量驻显存由它决定，直接决定 3 倍速差 |

---

## 四、目录结构

```
infer/
  README.md              本文件：设计、实测数据、复现步骤
  config/
    hardware.json        本机硬件基线（bootstrap 自检写入）
    profiles.json        运行档位（模型 / 显存规划 / 上下文 / 并行度 / 投机）
    assets.manifest.json 非入库资产清单（大小 + sha256 + 多来源；restore.ps1 读取）
    model-layout-*.json  GGUF 结构与张量布局导出（inspect-gguf 产出，显存规划依据）
  scripts/
    restore.ps1          按清单校验/补齐非入库资产（-List / -Check / -All / -Only / -Proxy）
    bootstrap.ps1        环境自检（GPU/CPU/内存/磁盘/引擎/模型/构建工具链）
    fetch.ps1            单线程健壮下载（重试 + 续传 + 大小校验）
    fetch-parallel.ps1   前台并发分片下载（大文件用）
    build-engine.ps1     自建引擎（cpu/cuda/vulkan，含工具链兼容性门禁）
    run-server.ps1       启动 OpenAI 兼容服务（按档位，启动记录留档）
    bench.ps1            基准测试（吞吐 + 报告落盘）
    bench-concurrent.ps1 并发吞吐测试（多 slot 聚合）
    plan-memory.ps1      显存规划扫描（ncmoe 求 Pareto 点）
    smoke-test.ps1       端到端冒烟（引擎→加载→生成→API，小模型秒级回归）
    verify.ps1           质量基线回归（固定种子/提示词，配置间输出对比）
    inspect-gguf.py      GGUF 结构与张量布局解析（支持未下载完成的文件）
  bench/reports/         基准报告与启动记录（argv 全量留档，可审计可回放）
  quant/                 自有量化配方（imatrix 重配比）
  engine/                引擎 fork、构建说明与补丁
  vendor/                引擎二进制（CUDA / Vulkan / CPU 多形态并存，便于 A/B 与回退）
```

模型权重落 `{GEBAI_HOME}/resources/models/infer/`（与仓库资源子仓库约定一致）。

运维入口是歌白的 `local_infer` 子Agent（`local_infer_status` / `local_infer_models` / `local_infer_start` / `local_infer_stop` / `local_infer_bench` / `local_infer_inspect`），
它复用本目录脚本而不复制逻辑；服务是标准 OpenAI 兼容端点，可直接接成 `GEBAI_LLM_ROUTES` 中的一路本地算力
（配置示例见根目录 `.env.example` 的 `LOCAL_INFER_*` 区块）。

---

## 五、快速开始

### 5.1 在另一台机器上从零还原（先做这一步）

模型权重（43.5 GB）、引擎二进制（~8 GB）、llama.cpp 源码与构建工具链体积大且可从上游重新获取，
**不入 git**。清单与还原脚本把它们变成一条命令：

```powershell
# 查看清单（不联网、不落盘）
pwsh -File infer/scripts/restore.ps1 -List

# 只校验现状（只读；-Quick 仅比大小更快，全量 sha256 校验读 45.8 GB）
pwsh -File infer/scripts/restore.ps1 -Check

# 校验并补齐**必需项**（引擎 + fast 档模型 ≈ 13.0 GB）
pwsh -File infer/scripts/restore.ps1 -Proxy http://<proxy-host>:<port>

# 连同可选资产（其余量化档 / WSL 对照构建 / 工具链，总计 45.8 GB）
pwsh -File infer/scripts/restore.ps1 -All

# 只要某一项（**显式点名即下载，不看 required**）
pwsh -File infer/scripts/restore.ps1 -Only model-iq4xs
```

清单在 `config/assets.manifest.json`（与主仓库 `scripts/resources.manifest.json` 同约定：
`path` / `size` / `sha256` / `required` / `license` / `description` / `sources[]`）。

| id | 大小 | 必需 | 说明 |
|---|---|---|---|
| `engine-cuda-win` | 0.24 GB | ✅ | llama.cpp b11100 Windows CUDA（默认后端） |
| `model-iq3xxs` | 12.80 GB | ✅ | IQ3_XXS —— fast/concurrent/long-context 档默认模型 |
| `model-iq3s` | 13.96 GB | — | IQ3_S —— balanced 档（质量更优） |
| `model-iq4xs` | 16.56 GB | — | IQ4_XS —— quality 档 |
| `imatrix-unsloth` | 0.18 GB | — | 重要性矩阵（自有量化配方用） |
| `engine-vulkan-win` / `engine-cpu-win` | 0.03 / 0.02 GB | — | 回退与对照后端 |
| `engine-cuda-wsl` / `engine-cudart-wsl` | 0.16 / 0.55 GB | — | WSL2 跨平台对照（解压在 WSL 侧，见 `scripts/wsl-setup-linux.sh`） |
| `src-llamacpp` | 0.04 GB | — | llama.cpp 源码（自建 CUDA 引擎用） |
| `toolchain-clang` / `toolchain-llvm-exe` / `toolchain-vsbuildtools` | 0.9 / 0.37 / 0.004 GB | — | 构建工具链（仅重编引擎时需要） |

**设计要点**：

- **只下载必需项即可开工**：13 GB 而不是 45.8 GB；其余按需 `-All` 或 `-Only` 拉取。
- **每个文件多来源顺序尝试**，下载后逐一校验 size + sha256（大文件走 `fetch-parallel.ps1` 前台并发分片；
  本机实测后台任务会被系统挂起，故不丢后台）。
- **`-Proxy` 支持代理**：本机环境 GitHub 直连间歇可达，脚本内已带重试与续传。
- 退出码：`0` 全部就绪 / `1` 有失败 / `2` 校验不通过（适合接入 CI 或开机自检）。

### 5.2 日常使用

```powershell
# 1) 环境自检（GPU/CPU/内存/磁盘/引擎/模型/工具链）
pwsh -File infer/scripts/bootstrap.ps1

# 2) 启动服务（默认档位）
pwsh -File infer/scripts/run-server.ps1

# 3) 基准测试
pwsh -File infer/scripts/bench.ps1 -Contexts 4096,32768 -Runs 3

# 4) 显存规划搜索（找出本机最优 ncmoe）
pwsh -File infer/scripts/plan-memory.ps1
```

---

## 六、实测数据（全部为本机真实测量）

**测试环境**：llama.cpp b11100 官方预编译｜模型 `Qwen-AgentWorld-35B-A3B`（unsloth UD 量化，sha256 已校验）
｜RTX 4080 SUPER 16GB + i7-14700KF + 32GB DDR5｜KV `q8_0`｜`-fa on`｜`-t 14`｜上下文 32768

### 6.1 后端对比——**决定性的 2.6 倍**

同一模型（IQ3_XXS）、同一参数（ncmoe=0，全部专家在显存）下：

| 后端 | pp512 t/s | tg256 t/s | GPU 利用率 | SM 时钟 | 功耗 |
|---|---|---|---|---|---|
| Vulkan | 2 696 | 54.4 | 93% | 2745 MHz | 117 W |
| **CUDA** | **4 391** | **143.4** | 88% | — | 202 W |
| 提升 | **1.6×** | **2.6×** | — | — | — |

> **结论**：本机场景（256 专家 / 40 层 → 每 token 320 次小 GEMM）下，CUDA 的 MoE 内核效率
> 远高于 Vulkan。**性能工程的首要决策是选 CUDA**，而不是调参。Vulkan 作为无 CUDA Toolkit 时的回退。

### 6.2 完整配置矩阵（CUDA）

| 配置 | 量化 | 专家驻 GPU | pp512 | tg256 | 显存 |
|---|---|---|---|---|---|
| **IQ3_XXS 全 GPU** | 3.06 bpw | 40/40 | **4 391** | **143.4** | 13.2 GB |
| IQ3_XXS ncmoe=6 | 3.06 bpw | 34/40 | 1 416 | 96.8 | ~11.0 GB |
| IQ4_XS ncmoe=8 | 4.25 bpw | 32/40 | 943 | 82.3 | 14.8 GB |
| IQ4_XS ncmoe=10 | 4.25 bpw | 30/40 | 677 | 74.8 | ~14.0 GB |
| IQ4_XS ncmoe=14 | 4.25 bpw | 26/40 | 493 | 63.1 | ~12.6 GB |

**核心规律**：
1. **全 GPU（ncmoe=0）压倒性最优**。CUDA 下把 6 层专家丢给 CPU 就损失 32%（143→97），
   远比 Vulkan 场景严重——因为 GPU 太快，CPU 一点点拖后腿就成瓶颈。
2. 策略因此明确：**选能把全部专家塞进 16GB 显存的最小量化**，而非“高量化+部分 offload”。
3. 每层专家 363 MiB（IQ4_XS）/ 320 MiB（IQ3_XXS）——`-ncmoe` 每 +1 就是确定的显存开销。

### 6.3 服务级实景（`llama-server` + OpenAI 兼容端点）

```
模型加载：12 秒（IQ3_XXS 全 GPU）

prompt eval： 37 tokens /  464 ms
     eval：400 tokens / 3139 ms  →  127.1 t/s
    total：        3.6 s / 437 tokens
---
1+1等于几？  →  content="1+1等于2。"
                reasoning_content="Thinking Process: 1. Identify the core question..."
                predicted_per_second = 126.3 t/s
```

**这是推理型模型**（带思维链）：正文在 `content`，思考过程在 `reasoning_content`。
消费类 API 必须同时处理两个字段，否则只拿到半截输出（调 180 token 时正文可能被思维链挤空）。

> **实用提醒**：该模型的思维链相当冗长（实测一个简单问题耗掉 950+ token，其中正文仅 1 句）。
> 因此 `max_tokens` 必须给足（建议 ≥1500，否则正文会被思维链挤空——表现为"有 usage 但 content 为空"）；
> 需要低延迟时应按需关闭思考（chat template 支持 `--no-reasoning-preserve` 相关开关）。

### 6.4 无效优化（务实的负结果）

| 手段 | 结果 | 结论 |
|---|---|---|
| **MTP 投机解码**（`--spec-type draft-mtp`） | 无法使用 | 该 GGUF **未包含 MTP 张量**（已用 `inspect-gguf.py` 验证） |
| **ngram-mod 投机** | 29.7 t/s（基准 40.3） | ❌ 反而变慢 |
| **ngram-cache 投机** | 37.7 t/s（基准 40.3） | ❌ 无收益（draft 16 个仅接受 7 个） |

**原因**：自由文本生成缺少可预测的重复模式，n-gram 投机命中率过低，抵消不了草稿开销。
→ **投机解码在本场景关闭**（已在 `profiles.json` 中全部置 null）。

### 6.5 量化档位对比与显存余量（决定档位制的依据）

三档均为实测（llama-bench 256-token / 服务模式 32K 上下文）：

| 档位 | 位宽 | 大小 | 专家位置 | bench 解码 | 服务解码 | 服务显存 | 余量 |
|---|---|---|---|---|---|---|---|
| `fast`（默认） | 3.06 bpw | 13.7 GB | 全 GPU | **143.6** | ~127 | 13.2 GB | 舒适（~3 GB） |
| `balanced` | 3.96 bpw | 15.0 GB | 全 GPU | 137.5 | 117.8 | **15.8 GB** | ⚠️ 仅 ~565 MB |
| `quality` | 4.25 bpw | 16.6 GB | 8 层在 CPU | 82.3 | — | 14.8 GB | 舒适 |

**两个关键权衡**：

1. **`balanced` 的价值与风险并存**：IQ3_S 的 `ffn_down` 与 IQ4_XS 同款位宽（unsloth 的质量倾斜：
   down 矩阵给高精度，gate/up 压得更狠），因此**质量高于 IQ3_XXS 而只需全 GPU 驻留**——
   同全 GPU 配置下，它把「质量档」从 82 t/s 抬到 137.5 t/s（+68%）。
   代价是显存余量只剩 565 MB：**长上下文或并发场景应改用 `fast`**（或降低 ctx），否则会 OOM。
2. **`quality` 档是唯一必须 offload 的档位**——IQ4_XS 的 16.6 GB 放不进 16 GB 显存，
   8 层专家落 CPU 后解码腰斩（143.6 → 82.3）。仅在确需最高保真度且能接受一半速度时使用。

> 由布局数据可解释为何 `balanced` 只慢 4%：三档的 `gate`/`up`/`attn_linear` 张量位宽相同
> （3.230 / 1.002 GiB），差异全部集中在 `ffn_down`（4.373 → 5.529 GiB，+1.16 GiB）与专家总字节。
> 解码是访存受限，权重总量只增 8.5%，速度自然只降 4%。

### 6.6 参数扫描：已验证无剩余空间（负结果）

在 `fast` 档（全 GPU）上扫描常见调优旋钮，每项 `-p 512 -n 256 -r 2`：

| 配置 | pp512 | tg256 |
|---|---|---|
| 基线 `t=14 b=2048 ub=512` | 4 618 | 143.0 |
| `t=20` / `t=10` | 4 639 / 4 683 | 143.7 / 142.6 |
| `ub=1024` / `b=4096 ub=1024` / `b=8192 ub=2048` | 4 500 / 4 744 / 4 480 | 142.1 / 143.2 / 143.8 |
| `fa off` | 4 537 | 143.3 |
| KV `f16`（替代 `q8_0`） | 4 710 | 143.6 |

**全部落在 142.1–143.8 t/s 的噪声区间内，无任何实质差异。** 结论：

- 线程数不影响解码——全 GPU 时 CPU 只做调度，不是瓶颈；
- batch/ubatch 只影响预填充（且本场景预填充已远超需求），对解码无用；
- FA 开关与 KV 精度对速度无影响（KV 本就只占 10/40 层）。

**唯一有效的调用参数是 `-bs`（后端采样）**：129.1 → 136.4 t/s（**+5.7%**），
temperature=0 下**输出逐字节一致**（已合入全部非对照档位；验证脚本 `scripts/verify-bs.ps1`）。
它消除的是每步的 logits 回传（248320×4 B）。注意与语法约束（grammar）不兼容——
带 grammar 的请求引擎会自动回退到 CPU 采样，不影响正确性。

→ **除 `-bs` 外参数层已榨干**：140 t/s 量级是所选后端的稳态上限，进一步提升必须改引擎代码（见下节）。

### 6.7 最终推荐配置

```jsonc
// profiles.json → "fast"（默认）
engine : vendor/llama-b11100-win-cuda12.4   // 已自包含（cudart+cublas+cublasLt 已入目录）
model  : Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf
-ncmoe 0  -ngl 99  -fa on  -ctk q8_0 -ctv q8_0  -c 32768  -t 14  --jinja  -bs
→  解码 143 t/s（+bs 后服务实测 134.7）｜ 预填充 4 391 t/s ｜ 显存 13.2 GB
// 多子会话并行：concurrent 档（np=2, ctx 65536）—— GEBAI prompt 实测 15K token，每 slot 需 ≥24K
// 短 prompt 批量：throughput 档（np=16）→ 聚合 627.8 t/s（4.30×）
```

**从初始的 37 t/s 到 143 t/s（3.9× 提升）**，路径是：换后端（Vulkan→CUDA）+ 换量化（让全部专家进显存），
两者都不是“调参”，而是结构性决策。

### 6.8 相对硬件上限的位置

| 项 | 数值 | 含义 |
|---|---|---|
| 显存带宽 | ~736 GB/s | 硬件上限 |
| 每 token 需读权重 | 12.79 GiB / 8 专家激活 ≈ 0.42 GiB | 25% 专家占比 |
| **纯带宽理论上限** | **≈ 1750 t/s** | 736 ÷ 0.42 |
| **实测** | **143 t/s（8.2% 利用率）** | 剩余空间在前端调度 / 内核效率 |

→ 账面还有 12 倍空间，但**这不等于“努力就能拿到”**：参数层已验证无空间（见 6.6），
剩余差距只可能来自引擎内部结构——当前受限于**每 token 上千个微小内核（1 425 个，均 3.87 µs）的串行执行**
（填不满 SM，占用率仅 18–38%），而非带宽，也**不是内核启动**（剖析实测内核启动数 0.00/token）。
要触及它必须改引擎代码，风险与成本都显著上台阶（见「引擎改造的启动条件」）。

> **一个反直觉的实测佐证**：`balanced` 档权重比 `fast` 多 8.5%，解码只慢 4%。
> 若解码纯受带宽支配，应当同比例变慢。这说明**每步固定开销（内核碎片化 / 图调度）占了相当比重**——
> 这既是带宽利用率只有 8% 的原因，也是唯一值得改代码的方向。

### 6.9 长上下文 / 并发 / CPU 对照

**长上下文（KV q8_0，只有 10/40 层是 full attention）**：

| 上下文 | 显存 | 解码 | 结论 |
|---|---|---|---|
| 32 768 | 15 052 MiB | 95.7 t/s | 基准 |
| 65 536 | 15 523 MiB | 93.8 t/s | 可用 |
| **131 072（128K）** | **15 869 MiB** | **93.3 t/s** | ✅ **实测硬上限**（速度几乎不衰减） |
| 163 840（160K） | 16 021 MiB | 22.2 t/s | ❌ 性能断崖 |
| 196 608（192K） | 15 956 MiB | 38.5 t/s | ❌ |
| 229 376（224K） | 15 994 MiB | 28.0 t/s | ❌ |
| 262 144（256K，模型训练上限） | 16 027 MiB | 20.9 t/s | ❌ |

**两个关键结论**：

1. **128K 以内，长上下文几乎免费**——从 32K 到 128K，显存仅增 817 MiB（KV 只占 10/40 层），
   解码速度从 95.7 掉到 93.3 t/s（-2.5%）。这是混合线性注意力（3 层 DeltaNet + 1 层 full attention）的直接红利。
2. **128K 是硬边界，且原因不是显存**：160K 以上显存占用与 128K 几乎相同（都在 15.9–16.0 GB），
   但解码崩到 20–38 t/s。说明逼近显存上限后引擎走入了低效路径（而非简单 OOM）。
   → **不要试图用 KV 量化换更大上下文**：KV 总量本就很小，压它换不来跨过这个边界。

128K 下的真实表现（8K 提示词实测）：

```
提示 2409 token  →  预填充 3 579.7 t/s  |  解码 112.7 t/s  |  峰值显存 15 646 MiB
```

**实践提示**：128K 时显存仅余约 730 MiB，请勿与其他 GPU 任务并用；日常交互用 `fast` 档（32K、余量充裕），
需要长文档处理时切 `long-context` 档。

**并发（`-np N` → 每 slot 分得 ctx/N）**：

用 Bun 原生并发 + **服务端内部计时（`timings`）+ 预热**测得（100 token/请求，np=16，ctx 32768）：

| 并发请求数 | 总 token | 聚合吞吐 | 单请求 | 相对单流 |
|---|---|---|---|---|
| 1 | 100 | 143.1 t/s | 143.1 | 1.02× |
| 2 | 200 | 225.1 | 112.5 | 1.61× |
| 4 | 400 | 329.4 | 82.4 | 2.35× |
| 8 | 800 | 447.3 | 55.9 | 3.19× |
| **16** | **1 600** | **642.1** | 40.1 | **4.59×** |

**627.8 t/s 已超过统一批处理的理论值**（`llama-batched-bench` B=8 → ≈510 t/s）——
连续批处理的动态填充优于固定批。

**slot 数存在精确最优（短 prompt 批量场景，同一并发数下扫描）**：

| slot 数 | 显存 | 单请求（无并发时） | 16 路并发聚合 |
|---|---|---|---|
| 1 | 14 862 MiB | 143.1 | — |
| 8 | 14 862 MiB | 143.1 | 447.3 |
| **16** | **15 222 MiB** | **142.6（不降！）** | **642.1** |
| 24 | 15 606 MiB | 85.8（开始劣化） | 482.0 |
| 32 | 15 985 MiB | 11.9（崩塌） | — |

**两条关键结论**：

1. **增大 slot 数不牺牲单请求性能**（np=16 时单请求仍 142.6，与 np=1 持平）——
   slot 是按需分配的，只要显存有余量就可以放心调大。
2. **但存在硬边界**：np=24 起劣化、np=32 崩塌（单请求 11.9），
   与显存逼近上限（15 985 / 16 376 MiB）同步发生——与 6.9 长上下文“超 128K 崩塌”同一现象。

> ⚠️ **测量方法教训（必读，否则会得到完全错误的数字）**：
> ① 本模型首请求含 **CUDA graph 捕获（约 10–12 s）**，必须**先预热**再取数；
> ② **`Start-Process` + `Wait-Process` 本身就引入约 12 s 偏差**——用墙钟会得到「与规模无关的恒定值」
> （曾因此把 8 路并发的 349.5 t/s 误算为 37.5 t/s）。
> 正确做法：用原生并发（Bun `Promise.all`）+ **服务端 `timings` 内部计时**
> （`scripts/bench-concurrency-precise.ps1` 与本文数据均按此口径）。

→ **集成建议**：见下节「GEBAI 场景的真实约束」——并非“无脑 np=16”，
slot 数必须按 prompt 大小反推。

**GEBAI 场景的真实约束（关键，决定了上述高并发不可直接套用）**：

用 GEBAI 真实请求实测发现其 prompt（系统提示词 + 工具定义）达 **15 352 token**：

```
request (15352 tokens) exceeds the available context size (4096 tokens)
```

而每 slot 窗口 = ctx / np，所以：

| 档位 | ctx | np | 每 slot | 能否跑 GEBAI | 聚合（16 并发） |
|---|---|---|---|---|---|
| throughput | 65 536 | 16 | 4 096 | ❌ 报 exceed_context | 627.8 t/s（仅短 prompt） |
| **concurrent** | **65 536** | **2** | **32 768** | ✅ | 114.7 t/s（大 prompt 无增益） |

**两条结论**：

1. **GEBAI 场景下高并发拿不到**：prompt 15K + 显存有限 ⇒ 每 slot 需 ≥ 24K ⇒ np ≤ 2。
   且大 prompt 时预填充占主导，**并发本身也无增益**（120.1 → 114.7）。
2. **真正重要的是 prompt caching**（默认已启用）：实测 3 603 token 固定前缀的第二次请求
   直接命中缓存（`cache_n=3603, prompt_n=4`），**墙钟 0.83 → 0.46 s（−45%）**。
   GEBAI 的固定系统提示词只需算一次——这比提并发对体验的改善大得多。

> 验证脚本：`scripts/bench-concurrency-precise.ps1`（并发上限）、
> `scripts/verify-engine-equiv.ps1`（引擎等价性）、`scripts/verify-bs.ps1`（-bs 正确性）。

**CPU 对照（`-ngl 0`，全 CPU）**：

| 指标 | GPU 全量 | CPU 全量 | 加速比 |
|---|---|---|---|
| 预填充 | 4 391 t/s | 53.8 t/s（pp64） | **81.6×** |
| 解码 | 143.4 t/s | 13.7 t/s（tg16） | **10.4×** |

### 6.10 单流性能上限的量化归因（剖析结论）

前面所有配置扫描都是负结果，因此做了量化剖析定位真正的上限。

**① 批量解码实际能线性扩展**

`llama-batched-bench -npp 128 -ntg 64`（全 GPU）：

| 批大小 | 聚合解码 t/s | 相对单流 |
|---|---|---|
| 1 | 94.96 | 1.0× |
| 2 | 187.53 | 2.0× |
| 4 | 268.46 | 2.8× |
| **8** | **508–512** | **≈3.6×** |

> 早期曾把 B=8 记为 391 t/s，那是冷启动/环境干扰下的偏差；交替 A/B 复核（各两次）
> 得 508.30 / 512.05（official）与 496.53 / 503.32（selfbuilt）。

预填充同样受益（B=4 时 3800 t/s，单流 742）。→ MoE 的权重读取确实能被批量摊薄。

**② 任意两批大小即可反解出「固定开销」与「边际成本」**

设每次 decode 调用固定开销 O、每 token 边际成本 C，则：
- B=1：O + C = 7.3 ms/token（实测 tg256 = 137 t/s）
- B=8：O + 8C = 15.7 ms / 8 token（实测 ≈510 t/s）

解得 **O ≈ 6.1 ms（每次调用）**、**C ≈ 1.20 ms（每 token）**。

**→ 单流时 84% 的时间是固定开销；GPU 真正干活只占约 16%**（C = 1.2 ms）。

这个结果与独立的剖析数据自洽：O ≈ 6.1 ms ≈ 采样等待 4.6 ms + graph launch 0.7 ms + 其它（见 6.11–6.12）。

> 注意：服务端连续批处理的实测聚合（ctx 32768、np=16、并发 16 → **642 t/s**；
> ctx 65536 时为 627.8 t/s，见下节 GEBAI 约束）**超过**同步批处理的
> B=8 上限（≈510 t/s）——因为连续批处理能在请求完成时动态补位，利用率高于同步推进。
> 所以服务端的真实上限应以 6.9 的实测为准，不能用 batched-bench 直接外推。

**③ 实测确认：GPU 时间上很忙，但硬件填不满**

生成期间 `nvidia-smi dmon`：SM 占用率 18–38%、显存带宽 4–25%。
但 nsys 同时给出：**decode 期 GPU 时间利用率 88%**（每 100 ms 有 88 ms 有内核在跑）。
两者不矛盾——SM% 是 **warp 活跃度**，不是时间占用率。

真正的病理是**内核碎片化**：

| 指标 | 实测 |
|---|---|
| decode 期内核数 | **136 779 / 96 token = 1 425 个/token** |
| 内核平均时长 | **3.87 µs**（最短 0.77 µs） |
| 单个采样同步（4.7 ms）内的内核忙碌 | **4.4 ms（93%）** |

→ 解码**既不是算力/带宽瓶颈，也不是“等主机”**（GPU 大部分时间在跑内核）；
而是**每 token 上千个微小内核串行执行，单个内核填不满 SM**（18–38%）。
这既是批量能摊薄的原因（batch=8 时每个内核算 8 个序列，时间只增 ~2.2× 而吞吐 8×），
也指向真正的优化方向：**算子融合 / 增大内核粒度**，而不是“消除往返”。

> **复现方法**（判断“同步期间 GPU 是在算还是在等”）：
> 1. `nsys profile --cuda-graph-trace=node -o sample-wait <llama-bench ...>`；
> 2. 对每个 `cudaStreamSynchronize` 区间，与 `CUPTI_ACTIVITY_KIND_KERNEL` 求重叠：
>    `SELECT COUNT(*), SUM(MIN(k.end,r.end)-MAX(k.start,r.start)) FROM ... WHERE k.start < r.end AND k.end > r.start`；
> 3. 重叠忙碌 / 同步时长 ≈ 93% → GPU 在真算（而非等主机）。
> **注意**：WDDM 下内核**时长**会失真，但“是否有内核重叠”这个存在性判断仍然可靠。

**④ 已穷尽的旋钮（全部无实质效果，供后人不再重复）**

| 类别 | 测过 | 结果 |
|---|---|---|
| 线程 | 8 / 14 / 20 / 28 | 140.1–143.7（噪声） |
| 同步与优先级 | `--poll 0/100`、`--prio 2/3`、`--cpu-range` | 无改善（prio=3 反降） |
| 批次 | `-b/-ub` 各组、`--no-host` | 无改善（后者不兼容） |
| 注意力 | `-fa on/off`、KV `q8_0`/`f16` | 无差异 |
| CUDA 后端 | `GGML_CUDA_PDL`、`FORCE_CUBLAS`、`F16` | 无差异 |
| 采样 | `-bs`（后端采样） | **+5%**（130.5 → 136.9 t/s，非主因） |
| **CUDA graphs** | 禁用对比 | **关键：141 → 59 t/s**，必须开启（已默认） |

**⑤ 投机解码在本模型上不可行（已定论）**

- ngram 类自投机：实测低于无投机基线（自由文本缺重复模式）；
- MTP 头：config 虽声明 `mtp_num_hidden_layers: 1`，但**官方原始权重就没有 MTP 张量**
  （索引 693 张量 / 40 层，无 mtp/nextn，也无视觉塔）——无米之炊，彻底排除；
- 外部草稿模型：词表不匹配（248320），不可用。

**⑥ 下一步方向（含一个已否证的假设，避免重走）**

O ≈ 6.1 ms 的量级远超 CUDA API 应在的开销（nsys 实测 `cudaGraphLaunch` 641 µs、
`cudaStreamSynchronize` 290 µs，合计不到 1 ms），因此曾怀疑是 **Windows WDDM** 的计算命令延迟
（本卡以 WDDM 模式运行，非 TCC）。

**验证结果：假设不成立。** 在 WSL2 下用官方 Linux CUDA 构建跑同一模型、同参数：

| 环境 | pp512 t/s | tg256 t/s |
|---|---|---|
| Windows（原生 CUDA 构建） | 4 391 | **140.98** |
| **WSL2 / Linux（官方 Linux CUDA 构建）** | 3 947 | **137.46** |

两平台几乎一致 ⇒ **限制不在操作系统/驱动路径，而在 llama.cpp 自身解码循环的结构**。

### 6.11 解码期内核级剖析（含 CUDA graph 内节点）

> **剖析前提**：解码路径全程在 CUDA graph 内，**必须加 `--cuda-graph-trace=node`** 才能看到图内节点；
> 不加时内核数是 5 942（只含 prefill 与图外内核），加了是 **83 014**（+13 倍）——两者的结论完全不同。

采集：`nsys profile --cuda-graph-trace=node -p 8 -n 48`（自建 CUDA 引擎，b11100 源）

**解码期 Top 内核**（按总耗时）：

| 内核 | 调用 | 总耗时 | 占比 | 平均 | 最大 | 网格 |
|---|---|---|---|---|---|---|
| `mul_mat_vec_q<Q6_K,1>` | 5 784 | 119.9 ms | 21.4% | 20.7 µs | 1.72 ms | 248320×1 |
| **`mul_mat_vec_q_moe<IQ2_S>`** | **78** | **87.5 ms** | **15.6%** | **1.12 ms** | **12.09 ms** | 256×8 |
| `mul_mat_vec_q<Q6_K,8>` | 486 | 76.0 ms | 13.6% | 156 µs | 7.15 ms | 4096×1 |
| **`mul_mat_vec_q_moe<IQ3_S>`** | **74** | **53.8 ms** | **9.6%** | **728 µs** | 7.77 ms | 1024×8 |

**MoE 专家内核合计 25%**，且**平均 1.12 ms / 最大 12.09 ms（10 倍方差）**。
每层专家权重约 86 MiB，按 736 GB/s 应在 **117 µs** 完成，实测 **1 120 µs → 约 10% 带宽效率**。

**`nsight_findings` 定级（按可回收时间）**：

| 严重度 | 问题 | 关键证据 | 可回收 |
|---|---|---|---|
| 高 | 小内核过多 | **72 833 次调用 < 10 µs（87.7%）**；同流相邻内核平均间隔 929.55 µs（含主机侧启动） | 128 ms |
| 高 | 同步等待 | Stream wait sync **1 917 次** / 640 ms | 640 ms |
| 中 | 网格并行度未填满 | 20 个内核网格仅 512–1024 块（≈65K 线程，硬件可容十万级） | 314 ms |
| 中 | 寄存器占用偏高 | `mul_mat_vec_q_moe` 每线程 72 寄存器、块 32×8 | — |

**最关键的线索（已量化坐实）**：解码期的流同步随 token 数线性增长（受控实验）：

| 运行 | 同步次数 | 内核数 |
|---|---|---|
| `-n 8` | 997 | 5 192 |
| `-n 64` | 2 285 | 5 192 |
| **差值 / 56 token** | **+1 288 → 23.0 次/token** | **+0** |

```
23 次同步/token × 306 µs = 7.0 ms/token
实测每 token（B=1）：     7.3 ms/token   ← 吻合
```

同类受控对比得出每 token 的完整开销清单：

| API | 每 token 增量 | 含义 |
|---|---|---|
| `cudaGraphLaunch` | 1.00 | 图启动（正常，每步一次） |
| `cudaLaunchKernel` | **0.00** | 不随 token 增长——**不是内核启动问题** |
| `cudaMemcpyAsync` | **10.00** | 每步 10 次主机↔设备拷贝 |
| `cudaStreamSynchronize` | **23.00** | 每步 23 次流同步 |

**注意区分「次数多」与「代价大」**：同步与拷贝的次数确实多（23 + 10），但**代价很小**——
两者合计仅 **0.27 ms/token**（占 7.1 ms 的 3.8%，见 6.12 末）。
单流的真正主体是**每步上千个微小内核的串行执行时间**（1 425 个/token，均 3.87 µs）——
它们填不满 SM（占用率 18–38%），但 GPU 时间上确实在忙（利用率 88%）。

### 6.12 进一步定位（一个被证否的候选，记录以免重试）

高详细度日志显示**每次 decode 的计算图被切成两段**：

```
sched_reserve: graph: nodes = 3907, splits = 2, input objects = 4, input tensors = 9
sched_reserve:      CUDA0 compute buffer size =     4.86 MiB
sched_reserve:  CUDA_Host compute buffer size =     0.33 MiB
done_getting_tensors: tensor 'token_embd.weight' (q6_K) cannot be used with
                      preferred buffer type CUDA_Host, using CPU instead
llama_context:      CUDA_Host  output buffer size =     0.95 MiB   (= 248320×4，logits)
```

嵌入表驻 CPU + logits 输出缓冲在主机，使图被切为两段。

**但把切分消除后并没有提速——所以切分不是瓶颈**：

| 配置 | 图切分 | tg256 |
|---|---|---|
| 基线 | **splits = 2** | 138.81 |
| `-ot token_embd.weight=CUDA0` | **splits = 1** | 140.10 |

（`-ot` 生效已被日志确认：`buffer type overridden to CUDA0` → `splits = 1`。）
切分从 2 降到 1 而吞吐持平 ⇒ **每步 23 次同步的成本不在图切分上**，
而在每步的**采样路径与状态管理**（其中 `CUDA_Host output buffer 0.95 MiB` 始终存在——
CPU 采样必须把 logits 回传；这正是 `-bs` 后端采样能消除的那一次）。

**已逐一排除的候选修法**（全部无效，供后人不再重复）：

| 尝试 | 结果 |
|---|---|
| `-ot token_embd.weight=CUDA0`（嵌入表推 GPU，图切分 2→1） | 140.10 vs 138.81 —— **噪声内，无改善** |
| `--no-host` | 参数被拒（实现不完整） |
| 线程/批/FA/KV/CUDA 环境变量全旋钮 | 均落在噪声区间（见 6.6） |
| 换平台（WSL/Linux 官方构建） | 137.46 vs 140.98 —— 一致，非平台问题 |
| `-bs` 后端采样（消除 logits 回传） | 130.5 → 136.9 t/s，**+5%**（唯一有效但幅度小） |

**因此剩下两个真正有效的方向**：

1. **批处理（已落地）**：微小内核在 batch>1 时被填得更满（batch=8 时每个内核算 8 个序列，
   时间只增 ~2.2× 而吞吐 8×），`throughput` 档（np=16，短 prompt）聚合 627.8 t/s（**4.30×**，
   超过统一批处理 B=8 的 ≈510）——见 6.9。
2. **算子融合 / 增大内核粒度（需改引擎）**：把每 token 上千个微内核合并成更少的、填得满 SM 的内核。
   这才是单流的根本出路。

**为什么不能靠“减少同步次数”拿到大幅提速**（定量依据）：explore 给出的时间预算显示，
23 次同步 + 10 次拷贝合计仅 **0.27 ms/token**（占 7.1 ms 的 3.8%）。
而采样等待的 4.7 ms 经实测**是 GPU 真的在内核算**（重叠 4.4 ms，93%）——
**不是等主机，也不是往返延迟**。

> **一个被实测否决的诱人方向**：曾推测“把采样完全搬到显卡、消除主机往返”能大幅提速。
> 但 4.7 ms 里 93% 是 GPU 繁忙，往返只占 ~0.3 ms——**上界约 5%**，
> 正好解释 `-bs` 为何只涨 5.7%（它已把回传数据量降了四个数量级，993 KB → 4 B）。
> 结论：改采样架构**不值得**，真正方向是减少内核数量（算子融合）。

> 本节的结论修正过一次：最初把图切分当作根因，经验证（消除切分后无提速）后推翻。
> 保留此过程是因为它排除了一条看似成立的路径——避免后人重走。

### 6.13 待测

| 项 | 说明 |
|---|---|
| 首 token 延迟（长提示词） | 当前仅测了短提示 |
| 质量标尺 | 三档的困惑度/任务级对比（`verify.ps1` 已备好固定种子回归），用于把「档位制」建立在质量数据上而非位宽直觉 |
| IQ4_XS 的 `-ot` 张量级 offload | 只把 `ffn_down_exps` 留 CPU（而非按层整块），CPU 侧流量 173 MiB/token——需实测是否优于按层方案 |

---

## 七、引擎改造的启动条件

自建 fork 是本项目「完全可控」的最终形态。**前置条件已达成**（可重复构建 CUDA 引擎，
与官方二进制性能持平），且剖析已把开销结构量化到具体数字（每步 23 次同步 + 10 次拷贝，
见 6.11–6.12，并已排除图切分这一候选）。

### 已就绪的部分

| 项 | 状态 |
|---|---|
| 源码 | `engine/llama.cpp-b11100`（已解压，含 `src/models/qwen35*.cpp`、`delta-net-base.cpp`） |
| 构建脚本 | `scripts/build-engine.ps1`（cpu/cuda/vulkan 三后端，含 **nvcc 宿主编译器版本门禁**，自动探测 vcvars 与 ninja） |
| 工具链约束 | 已实测并记录（见 `engine/README.md` 的兼容性表） |
| 补丁目标 | 上游 qwen3_5 未闭合条目已列出（见下节）；参数层已确认无空间（见 6.6） |
| 精度基线 | `smoke-test.ps1`（全链路）+ `verify.ps1`（固定种子质量回归） |

### 编译环境（已解决）

| 路径 | 结果 |
|---|---|
| **VS Installer 并存旧工具集**：同一 VS 实例内装 VS2022 era 的 MSVC 14.44，用 `vcvars64.bat -vcvars_ver=14.44` 选中 | ✅ **本机构建方案**（`engine/build-cuda-1444.bat`，实测 460/460 构建成功，性能与官方持平） |
| LLVM 官方包解压 `clang-cl`，`nvcc -ccbin clang-cl` | ✅ 备选（本机已下载至 `vendor/llvm/`） |
| VS2026（14.51）+ CUDA 12.9 | ❌ nvcc 硬拒，逃生开关下 `cudafe++` 崩溃 |

### 靶心与风险

**根因已定位**（见 6.10–6.12）：每 token **1 425 个微小内核**（均 3.87 µs）串行执行，
GPU 时间利用率 88% 但 SM 占用率仅 18–38%——硬件填不满，不是带宽问题、也不是等主机。
已排除：图切分、参数旋钮、平台差异、嵌入表落位、采样往返（实测仅值 ~5%）。
**主攻方向是算子融合 / 增大内核粒度**——把上千个微内核合并成少数填得满 SM 的内核。
（此为**方向判断**：SM 占用率 18–38% 说明填不满，但融合的具体收益未实测——
可能是 1.5×，也可能受限于图调度架构。）

**修复方向明确但属引擎核心改造**：合并两段图（嵌入/logits 设备化）、
循环状态缓冲常驻设备、用后端采样消除 logits 回传。
验收标准：同步次数/步 → O → 单流 tok/s（可量化、可回归）。

**风险**：llama.cpp 的调度器与循环状态耦合较深（`llama-memory-recurrent`），
且上游正活跃演进该部分，局部 fork 需持续 rebase；改动必须逐项过 `verify.ps1` 质量回归。
工作量按天计，为本项目风险最高的一项。

### 启动门槛

- ✅ 可重复构建 CUDA 引擎（已达成）
- ✅ 根因量化到具体机制与可验收指标（已达成）
- ⏳ 待决：是否投入引擎级改造（减少每步同步/拷贝；天级工作量、需正确性回归守护）

> 现状：**140 t/s 是 llama.cpp 现有实现的稳态上限，参数层空间已完全用尽**。
> 进一步提速只能改引擎代码；不改也能用——多会话并发已能拿到 2.67× 聚合。

---

## 八、已知风险与上游现状（2026-09 核实）

llama.cpp 的 qwen3_5 支持仍有未闭合条目。**当前使用方式下均未触发**（现成 GGUF + 纯文本路径），
因此不作为行动项，仅作库存记录——一旦需要自转换或出现对应症状，这些就是补丁的起点
（启动条件见上节）：

| 条目 | 症状 | 我们的应对 |
|---|---|---|
| #27019 / PR #27132 | `convert_hf_to_gguf` 对混合线性注意力张量（ssm_conv1d 核维度、in_proj_a/b 扩展）处理有问题 | 只用现成 GGUF 可规避；自转换时打补丁 |
| #26916 | 混合模型加载报 `tensor 'blk.32.attn_norm.weight' not found` | 加载期校验，锁定 stride/层映射 |
| #28166 | 混合递归模型的 mrope 位置警告 | 纯文本场景影响小，持续跟踪 |
| #28879 | GDN 架构上 perplexity 非精度单调（F16 反而不如 Q4_K_M） | **关键**：不盲信"更高精度更好"，用实测质量标尺选档 |

**构建工具链注意**：CUDA 12.9 的 nvcc 只支持 MSVC ≤2022（宿主编译器硬校验），
本机 VS2026（MSVC 14.51）会触发 `unsupported Microsoft Visual Studio version`，
加 `-allow-unsupported-compiler` 后 `cudafe++` 直接 ACCESS_VIOLATION（已实测）。
→ 自建 fork 需要 VS2022 生成工具（或免安装的 clang-cl）作为 nvcc 的宿主编译器；
**预编译二进制路径不受影响**。

---

## 九、安全与可控

- 全链路离线：不依赖任何云 API；模型与引擎均落本地磁盘，来源与校验和可追溯。
- 可审计：每次启动的完整命令行、显存规划、引擎版本记录进 `bench/reports/`。
- 可回退：档位化配置，任一优化不达标即回滚到上一档；`git` 管理 `config/` 与 `engine/patches/`。

---

## 十、在 GEBAI 中使用

把本地引擎接成 GEBAI 的模型算力，起一份独立实例体验（`scripts/run-gebai-local.ps1`）：

```powershell
# 先拉起推理服务
pwsh -File infer/scripts/run-server.ps1 -Profile fast -Background

# 再起一个独立的 GEBAI 实例（默认 :3100 → 本地模型）
pwsh -File infer/scripts/run-gebai-local.ps1

# 停止
pwsh -File infer/scripts/run-gebai-local.ps1 -Stop
```

**与既有实例共处**（脚本已内置，无需手工配）：独立数据根 `<仓库根>/.gebai-local`（会话/用户数据隔离，
`resources/` 以目录联接指向仓库资源，CV 等能力照常可用）；`GEBAI_SCHEDULER=off`（不跑定时/闲时调度）；
GC 关闭；飞书机器人关闭（两实例同时订阅事件会重复响应）。

### 关键：默认关闭思考模式

该模型是推理型，**思维链可占输出 90% 以上**。实测同一工具调用任务：

| 模式 | 工具调用结果 | token 用量 | 端到端耗时 |
|---|---|---|---|
| 开思考（默认） | `ls({"path":"C:\\Windows"})` | 315 | 13.2 s |
| **关思考** | 同上（**完全一致**） | **27（↓91%）** | **5.0 s** |

关闭方式（脚本默认已带）：

```
GEBAI_LLM_EXTRA_PARAMS={"chat_template_kwargs":{"enable_thinking":false}}
```

复杂推理任务如需思维链，用 `-EnableThinking` 重启，或在前端环境变量面板临时覆盖该变量为空。

### 上下文窗口由推理服务的档位决定

GEBAI 侧的上下文预算**自适应服务端窗口**（脚本启动时探测 `/props` 的 `n_ctx`，取
`min(-MaxContext 期望值, n_ctx − 输出预留)`）——所以**要调大上下文，改的是推理服务的档位**，不是实例参数：

| 推理档位 | 服务端窗口 | 实例预算 | 显存 | 适用 |
|---|---|---|---|---|
| `fast` | 32K | 24K | 15.0 GB | 日常交互（余量充裕） |
| **`long-context`** | **128K** | **120K** | 15.9 GB | 长文档处理（余量仅约 730 MiB） |

```powershell
# 换到 128K：先重起推理服务，再重起实例
pwsh -File infer/scripts/run-server.ps1 -Profile long-context -Background
pwsh -File infer/scripts/run-gebai-local.ps1 -Port 3100 -Stop
pwsh -File infer/scripts/run-gebai-local.ps1 -Port 3100
```

> **128K 是本机实测硬上限**，且瓶颈不是显存（160K 以上显存占用与 128K 几乎相同，但解码崩到 1/4）。
> 完整边界数据见 6.9 节——不要试图用 KV 量化或其它手段突破它。

### 实测体验基线（经 GEBAI SDK 端到端）

```
思维链: 0 chunk        正文: 9 chunk / 97 字符
首字延迟: 4.6 s       总耗时: 5.0 s
```

**能力边界**（据实说明，避免误用）：工具调用格式正确可靠（已验证 `tool_calls` 与参数 JSON），
适合日常问答、单步/少步的工具操作。但它是 3 bit 量化的 35B MoE 本地模型，**复杂多步推理、
长链路任务规划明显弱于云端大模型**；且 llama-server 为单 slot（同时只处理一个请求），
多会话并发会排队。重活请交给云端模型，本地模型的定位是**离线、零配额、数据不出本机**。
