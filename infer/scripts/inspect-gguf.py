#!/usr/bin/env python3
"""inspect-gguf.py — 直接解析 GGUF 头部，输出架构与张量布局。

为什么不用 llama-gguf：本工具要能在**未下载完成**的文件（*.incomplete）上工作——
GGUF 的元数据与张量目录都在文件前部，权重数据在后部，因此下载到 5% 就能拿到
完整的结构信息（层数/专家数/每层张量字节数），用于：
  1. 确认架构（qwen35moe）与 MTP 头是否随文件发布
  2. 精确计算「-ncmoe N」各档的显存/内存分配，指导 plan-memory 扫描范围

用法: python inspect-gguf.py <file.gguf[.incomplete]> [--json out.json]
"""
import json
import struct
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

GGML_TYPE = {
    0: ("F32", 4), 1: ("F16", 2), 2: ("Q4_0", None), 3: ("Q4_1", None),
    6: ("Q5_0", None), 7: ("Q5_1", None), 8: ("Q8_0", None), 9: ("Q8_1", None),
    10: ("Q2_K", None), 11: ("Q3_K", None), 12: ("Q4_K", None), 13: ("Q5_K", None),
    14: ("Q6_K", None), 15: ("Q8_K", None), 16: ("IQ2_XXS", None), 17: ("IQ2_XS", None),
    18: ("IQ3_XXS", None), 19: ("IQ1_S", None), 20: ("IQ4_NL", None), 21: ("IQ3_S", None),
    22: ("IQ2_S", None), 23: ("IQ4_XS", None), 24: ("I8", 1), 25: ("I16", 2), 26: ("I32", 4),
    27: ("I64", 8), 28: ("F64", 8), 29: ("IQ1_M", None), 30: ("BF16", 2),
}
# 各量化类型的 block 大小（元素数）与字节数
GGML_BLOCK = {
    "Q4_0": (32, 18), "Q4_1": (32, 20), "Q5_0": (32, 22), "Q5_1": (32, 24), "Q8_0": (32, 34),
    "Q8_1": (32, 36), "Q2_K": (256, 84), "Q3_K": (256, 110), "Q4_K": (256, 144),
    "Q5_K": (256, 176), "Q6_K": (256, 210), "Q8_K": (256, 292),
    "IQ2_XXS": (256, 66), "IQ2_XS": (256, 74), "IQ2_S": (256, 82), "IQ3_XXS": (256, 98),
    "IQ3_S": (256, 110), "IQ1_S": (256, 50), "IQ1_M": (256, 56), "IQ4_NL": (32, 18),
    "IQ4_XS": (256, 136),
}


def tensor_nbytes(ttype, nelem):
    if ttype in ("F32", "I32"):
        return nelem * 4
    if ttype in ("F16", "BF16", "I16"):
        return nelem * 2
    if ttype in ("I8", "F64", "I64"):
        return nelem * (1 if ttype == "I8" else 8)
    if ttype in GGML_BLOCK:
        blk, nbytes = GGML_BLOCK[ttype]
        return (nelem // blk) * nbytes
    return None


class Reader:
    def __init__(self, f):
        self.f = f

    def u32(self):
        return struct.unpack("<I", self.f.read(4))[0]

    def u64(self):
        return struct.unpack("<Q", self.f.read(8))[0]

    def i32(self):
        return struct.unpack("<i", self.f.read(4))[0]

    def f32(self):
        return struct.unpack("<f", self.f.read(4))[0]

    def boolean(self):
        return struct.unpack("<?", self.f.read(1))[0]

    def string(self):
        n = self.u64()
        return self.f.read(n).decode("utf-8", errors="replace")

    def value(self, vtype):
        if vtype == 0: return self.u8()
        if vtype == 1: return struct.unpack("<b", self.f.read(1))[0]
        if vtype == 2: return struct.unpack("<H", self.f.read(2))[0]
        if vtype == 3: return struct.unpack("<h", self.f.read(2))[0]
        if vtype == 4: return self.u32()
        if vtype == 5: return self.i32()
        if vtype == 6: return self.f32()
        if vtype == 7: return self.boolean()
        if vtype == 8: return self.string()
        if vtype == 9:
            et = self.u32(); n = self.u64()
            vals = [self.value(et) for _ in range(n)]
            return vals if et in (8,) else vals
        if vtype == 10: return self.u64()
        if vtype == 11: return struct.unpack("<q", self.f.read(8))[0]
        if vtype == 12: return struct.unpack("<d", self.f.read(8))[0]
        raise ValueError(f"unknown value type {vtype}")

    def u8(self):
        return struct.unpack("<B", self.f.read(1))[0]


def main():
    path = Path(sys.argv[1])
    out_json = None
    if "--json" in sys.argv:
        out_json = sys.argv[sys.argv.index("--json") + 1]

    with open(path, "rb") as f:
        r = Reader(f)
        magic = f.read(4)
        if magic != b"GGUF":
            print(f"不是 GGUF 文件（magic={magic!r}）")
            return 1
        version = r.u32()
        n_tensors = r.u64()
        n_kv = r.u64()
        print(f"文件: {path.name}")
        print(f"GGUF v{version} | 张量 {n_tensors} 个 | 元数据 {n_kv} 项")

        kv = {}
        SKIP_BIG = {"tokenizer.ggml.tokens", "tokenizer.ggml.merges", "tokenizer.ggml.scores",
                    "tokenizer.ggml.token_type"}
        for _ in range(n_kv):
            key = r.string()
            vtype = r.u32()
            if key in SKIP_BIG:
                # 跳过超大数组：先读元素类型与个数，再按类型宽度跳过
                et = r.u32(); n = r.u64()
                if et == 8:
                    for _ in range(n):
                        ln = r.u64(); f.seek(ln, 1)
                elif et in (0, 1, 7):
                    f.seek(n, 1)
                elif et in (2, 3):
                    f.seek(n * 2, 1)
                elif et in (4, 5, 6):
                    f.seek(n * 4, 1)
                else:
                    raise ValueError(f"无法跳过 {key} (elem type {et})")
                kv[key] = f"<{n} 项已跳过>"
            else:
                kv[key] = r.value(vtype)

        print("\n=== 关键元数据 ===")
        for k in ["general.architecture", "general.name", "general.size_label",
                  "general.file_type", "llama.block_count", "llama.context_length",
                  "llama.embedding_length", "llama.expert_count", "llama.expert_used_count",
                  "llama.attention.head_count", "llama.attention.head_count_kv",
                  "llama.feed_forward_length", "llama.expert_feed_forward_length",
                  "llama.expert_shared_feed_forward_length", "llama.rope.freq_base",
                  "llama.attention.full_attention_interval", "llama.nextn_predict_layers",
                  "llama.attention.recurrent_layers", "llama.ssm.conv_kernel",
                  "llama.ssm.inner_size", "llama.ssm.state_size", "llama.ssm.group_count",
                  "split.count", "tokenizer.ggml.model", "tokenizer.ggml.eos_token_id"]:
            if k in kv:
                v = kv[k]
                s = str(v)
                print(f"  {k:48} = {s[:100]}")

        has_jinja = "tokenizer.chat_template" in kv
        print(f"  {'tokenizer.chat_template':48} = {'有（%d 字符）' % len(str(kv['tokenizer.chat_template'])) if has_jinja else '无'}")

        # 张量目录
        tensors = []
        for _ in range(n_tensors):
            name = r.string()
            n_dims = r.u32()
            dims = [r.u64() for _ in range(n_dims)]
            ttype_id = r.u32()
            offset = r.u64()
            tname = GGML_TYPE.get(ttype_id, (f"UNKNOWN({ttype_id})", None))[0]
            nelem = 1
            for d in dims:
                nelem *= d
            nb = tensor_nbytes(tname, nelem)
            tensors.append({"name": name, "dims": dims, "type": tname,
                            "nbytes": nb, "offset": offset})

        # 统计
        total_bytes = sum(t["nbytes"] or 0 for t in tensors)
        print(f"\n=== 张量统计（理论 {total_bytes/1e9:.2f} GB / {total_bytes/2**30:.2f} GiB）===")

        from collections import defaultdict
        by_kind = defaultdict(lambda: [0, 0])
        for t in tensors:
            n = t["name"]
            if "_exps" in n:
                kind = "expert(" + n.split(".")[-2].replace("_exps", "") + ")"
            elif "_shexp" in n:
                kind = "shared_expert"
            elif n.startswith("token_embd"):
                kind = "token_embd"
            elif n.startswith("output"):
                kind = "output"
            elif n.startswith("blk.") and ("attn" in n or "ssm" in n or "linear" in n):
                kind = "attn_linear"
            elif n.startswith("blk.") and "ffn" in n:
                kind = "ffn_other"
            else:
                kind = "other"
            by_kind[kind][0] += 1
            by_kind[kind][1] += (t["nbytes"] or 0)
        for k, (cnt, nb) in sorted(by_kind.items(), key=lambda x: -x[1][1]):
            print(f"  {k:24} {cnt:5} 张量  {nb/2**30:8.3f} GiB")

        # 每层专家字节（用于显存规划）
        per_layer = {}
        for t in tensors:
            if "_exps" in t["name"]:
                m = t["name"].split(".")
                if m[0] == "blk":
                    per_layer[int(m[1])] = per_layer.get(int(m[1]), 0) + (t["nbytes"] or 0)
        if per_layer:
            layers = sorted(per_layer)
            avg = sum(per_layer.values()) / len(per_layer)
            print(f"\n=== 每层专家权重 ===")
            print(f"  层数 {len(layers)}（blk {layers[0]}..{layers[-1]}）")
            print(f"  平均每层 {avg/2**20:.1f} MiB，合计 {sum(per_layer.values())/2**30:.3f} GiB")
            print(f"  → 每把 1 层专家放到 CPU（-ncmoe 增 1），显存约省 {avg/2**20:.0f} MiB")

        # MTP 相关张量
        mtp = [t["name"] for t in tensors if "nextn" in t["name"] or t["name"].startswith("blk.40.")]
        print(f"\n=== MTP 头 ===")
        print(f"  {'发现 %d 个 MTP 张量 → --spec-type draft-mtp 可用' % len(mtp) if mtp else 'GGUF 未包含 MTP 张量 → 无法用 MTP 投机'}")

        if out_json:
            Path(out_json).write_text(json.dumps(
                {"meta": kv, "tensors": tensors,
                 "expert_per_layer_bytes": per_layer,
                 "mtp_tensors": mtp, "total_bytes": total_bytes},
                ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"\n已写出: {out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
