#!/usr/bin/env bash
# 编译基于 macOS Vision 框架的 OCR 二进制。
# DeepSeek 公开 API 不支持图片输入，图片解读由 harness 侧 OCR 兜底。
#
# 注意：Swift 编译器默认把模块缓存写到 /var/folders，在受限沙箱下会被拒绝，
# 因此这里把缓存目录重定向到本仓库内。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/.build-cache"
mkdir -p "$CACHE/tmp"

export CLANG_MODULE_CACHE_PATH="$CACHE"
export SWIFT_MODULECACHE_PATH="$CACHE"
export TMPDIR="$CACHE/tmp"

echo "编译 OCR（swiftc → ocr-bin）…"
swiftc -O -o "$HERE/ocr-bin" "$HERE/ocr.swift" \
  -framework Vision -framework ImageIO -framework CoreGraphics

echo "完成：$HERE/ocr-bin"
"$HERE/ocr-bin" --version 2>/dev/null || true
