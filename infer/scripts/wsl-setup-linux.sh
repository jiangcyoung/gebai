#!/usr/bin/env bash
# WSL 侧：解压官方 Linux CUDA 构建并验证 GPU 可用
set -e
DL=/mnt/c/Users/Administrator/code/gebai/infer/vendor/dl
DST=$HOME/llama-linux
mkdir -p "$DST"
echo "=== 解压 ==="
tar -xzf "$DL/llama-b11100-bin-ubuntu-cuda-12.8-x64.tar.gz" -C "$DST"
tar -xzf "$DL/cudart-llama-b11100-bin-ubuntu-cuda-12.8-x64.tar.gz" -C "$DST"
chmod +x "$DST"/llama-* 2>/dev/null || true
echo "文件数: $(ls -1 "$DST" | wc -l)"
echo "--- 关键文件 ---"
ls -1 "$DST" | grep -E 'llama-bench|llama-server|libcudart|libcublas|ggml-cuda' | head -8

echo "=== 设置运行时库路径 ==="
export LD_LIBRARY_PATH="$DST:$HOME/llama-linux:${LD_LIBRARY_PATH:-}"
echo "LD_LIBRARY_PATH=$LD_LIBRARY_PATH"

echo "=== 设备探测 ==="
"$DST/llama-bench" --list-devices 2>&1 | head -12

echo "=== 模型是否就绪 ==="
ls -la "$HOME/models/" 2>/dev/null || echo "模型尚未拷贝完成"

echo "WSL_SETUP_DONE"
