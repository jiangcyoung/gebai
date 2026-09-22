# quant — 自有量化配方

目标：在**给定显存预算**下拿到最好的模型质量。上游现成量化（unsloth UD 系列）是通用配方，
不一定适配"专家驻 CPU/GPU 混合、非专家全驻 GPU"的本机拓扑。本目录存放自有配方与流程。

---

## 一、为什么需要自有配方

1. **张量重要性非均匀**：非专家部分（注意力、DeltaNet、嵌入/输出头）**每 token 必读**，且全驻 GPU（快车道），
   应当保高精度；专家部分每 token 只激活 8/256，且部分要走 CPU（慢车道），可压更狠。
   上游 UD 配方对此的权衡不受我们的显存/带宽约束驱动。
2. **质量标尺不能想当然**：上游 issue #28879 指出 GDN 混合架构上 perplexity **非精度单调**
   （F16 反不如 Q4_K_M）。→ 必须用**实测**（困惑度 + 任务级抽检）挑档，而非按比特数直觉。
3. **可控性**：自有配方 = 可复现的转换命令 + 明确的 imatrix 来源与校验和。

---

## 二、材料

| 材料 | 来源 | 状态 |
|---|---|---|
| BF16 原始权重（21 shard ≈ 68GB） | `modelscope: Qwen/Qwen-AgentWorld-35B-A3B` | 按需下载（需要时） |
| 现成量化档（备用/对照） | `modelscope: unsloth/Qwen-AgentWorld-35B-A3B-GGUF` | 已启用（IQ4_XS） |
| **imatrix** 重要性矩阵（192MB） | 同上仓库 `imatrix_unsloth.gguf_file` | ✅ 已落 `resources/models/infer/imatrix/` |

---

## 三、配方策略

### 非专家张量（约 2.2B 参数，全驻 GPU）
- 目标精度：**Q5_K / Q6_K**（每 token 必读，精度收益直接体现在输出质量）
- 命中张量：`token_embd` / `output` / `attn_*` / `ssm_*`（DeltaNet 的 conv1d、in_proj、A_log、dt_bias）/ `ffn_*_shexp`（共享专家）

### 专家张量（约 32.2B 参数，部分驻 CPU）
- 目标精度：**IQ3_XXS ~ IQ4_XS**，按层分级：
  - 驻 GPU 的层（显存充裕）：可稍高
  - 驻 CPU 的层（走内存带宽）：可稍低
- 依据 imatrix 的重要性分布重排比特预算

### 转换流程（待 P4/P2 校准）

```powershell
# 1) HF → GGUF（bf16），若需自转换需先应用 engine/patches 的 A1 补丁
python convert_hf_to_gguf.py <hf_dir> --outfile <out.bf16.gguf --outtype bf16

# 2) imatrix 计算（若不自带上游 imatrix）
llama-imatrix -m <out.bf16.gguf> -f <calib.txt> -o <own.imatrix>

# 3) 按张量类型分别量化（llama-quantize 支持 --tensor-type 规则）
llama-quantize --imatrix <imatrix> `
  --tensor-type "token_embd=q6_K" --tensor-type "output=q6_K" `
  --tensor-type "attn_=q5_K" --tensor-type "ssm_=q5_K" `
  --tensor-type "ffn_.*_exps=iq3_xxs" `
  <in.gguf> <out.gguf> Q4_K_M
```

> 具体参数名与规则语法以 b11100 的 `llama-quantize --help` 为准，落定后回写本节。

---

## 四、验收

每个自有档必须过两关，数据入 `bench/reports/`：

| 关卡 | 方法 | 门槛 |
|---|---|---|
| 困惑度 | `llama-perplexity`，固定语料与上下文 | 不劣于上游同尺寸档 |
| 任务抽检 | 固定种子 + 固定提示词集（含工具调用 JSON 生成场景） | 输出结构合法、无退化 |

> 记忆点：**#28879 的教训是"更高比特≠更好"**——质量结论只认实测，不认比特数。
