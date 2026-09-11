#!/usr/bin/env bash
# 显示当前访问口令及其来源。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILE="$ROOT/data/access-code.txt"
echo ""
echo "════════════════════════════════════════"
if [ -f "$FILE" ]; then
  echo "  访问口令：$(cat "$FILE")"
  echo "  来源：${FILE#"$ROOT"/}（自动生成并持久化）"
elif [ -n "${ACCESS_CODE:-}" ]; then
  echo "  访问口令：$ACCESS_CODE"
  echo "  来源：环境变量 ACCESS_CODE"
else
  echo "  尚未生成。先启动一次服务（npm start），或手动设置："
  echo "    ACCESS_CODE=你的口令 npm start"
fi
echo "════════════════════════════════════════"
echo "  只读接口（行情/资讯）无需口令。"
echo "  使用位置：页面左下角「⚙ 连接设置」"
echo ""
