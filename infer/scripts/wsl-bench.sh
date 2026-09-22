#!/usr/bin/env bash
# WSL 侧：用官方 Linux CUDA 构建跑基准，与 Windows 对比
BIN=$HOME/llama-linux/llama-b11100
LIB=$HOME/llama-linux/cudart-llama-b11100-bin-ubuntu-cuda-12.8-x64
MODEL=$HOME/models/Qwen-AgentWorld-35B-A3B-UD-IQ3_XXS.gguf
export LD_LIBRARY_PATH="$BIN:$LIB:${LD_LIBRARY_PATH:-}"

echo "=== 设备探测 ==="
"$BIN/llama-bench" --list-devices 2>&1 | head -8

echo
echo "=== 基线解码基准（与 Windows 同参数：ngl 99 / ncmoe 0 / fa on / KV q8_0）==="
"$BIN/llama-bench" -m "$MODEL" -ngl 99 -ncmoe 0 -p 512 -n 256 -r 2 \
  -fa on -ctk q8_0 -ctv q8_0 -t 14 2>&1 | grep -E 'pp512|tg256|build:|error|failed' | head -8

echo
echo "WSL_BENCH_DONE"
