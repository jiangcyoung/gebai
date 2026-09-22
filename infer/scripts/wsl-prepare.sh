#!/usr/bin/env bash
# WSL 侧准备：装构建工具 + 拷贝源码（模型从 /mnt/c 直读）
set -e
export DEBIAN_FRONTEND=noninteractive

echo "=== 1) 安装 cmake / ninja ==="
if ! command -v cmake >/dev/null 2>&1; then
  sudo apt-get update -qq 2>&1 | tail -2
  sudo apt-get install -y -qq cmake ninja-build 2>&1 | tail -3
fi
echo "cmake: $(cmake --version | head -1)"
echo "ninja: $(ninja --version 2>/dev/null || echo '缺失')"

echo "=== 2) 准备源码（从 Windows 侧拷到 Linux 文件系统，避免 9p 慢速）==="
SRC=/mnt/c/Users/Administrator/code/gebai/infer/engine/llama.cpp-b11100
DST=$HOME/llama.cpp
if [ ! -d "$DST" ]; then
  cp -r "$SRC" "$DST"
fi
echo "源码: $DST ($(du -sh "$DST" | cut -f1))"

echo "=== 3) nvcc 与 GPU ==="
nvcc --version | tail -2
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

echo "=== 4) 内存与磁盘 ==="
free -g | head -2
df -h "$HOME" | tail -1

echo "PREPARE_DONE"
