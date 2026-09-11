#!/usr/bin/env bash
#
# 把纯静态前端部署到 GitHub Pages，并自动把当前后端隧道地址写入 config.js。
#
# 用法：
#   bash scripts/deploy-pages.sh                      # 自动读取 data/tunnel-url.txt
#   bash scripts/deploy-pages.sh https://xxx.trycloudflare.com   # 显式指定后端地址
#
# 背景：GitHub Pages 只能托管静态文件，无法运行后端。因此前端（静态）与后端
# （Node 服务）分离部署，前端通过 CORS 调用后端隧道地址。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPO="${REPO:-AllenJia1998/fund-smart-invest}"
REMOTE="${REMOTE:-upstream}"
BRANCH="${BRANCH:-gh-pages}"

# ---- 1. 确定后端地址 ----
BACKEND="${1:-}"
if [ -z "$BACKEND" ] && [ -f data/tunnel-url.txt ]; then
  BACKEND="$(cat data/tunnel-url.txt)"
fi
if [ -z "$BACKEND" ]; then
  echo "✗ 未提供后端地址，且 data/tunnel-url.txt 不存在。"
  echo "  请先运行：bash scripts/tunnel.sh"
  exit 1
fi
echo "▸ 后端地址：$BACKEND"

# ---- 2. 自检后端可达 ----
if ! curl -sf -o /dev/null --max-time 25 "$BACKEND/api/status"; then
  echo "✗ 该地址不可达，请确认隧道仍在运行。"
  exit 1
fi
echo "✓ 后端可达"

# ---- 3. 把地址写入 config.js ----
python3 - "$BACKEND" <<'PY'
import re, sys
backend = sys.argv[1]
path = 'public/js/config.js'
src = open(path, encoding='utf-8').read()
new, n = re.subn(r"(var REMOTE_BACKEND = ')[^']*(';)", lambda m: m.group(1) + backend + m.group(2), src)
if n == 0:
    raise SystemExit('✗ 未能在 config.js 中定位 REMOTE_BACKEND')
open(path, 'w', encoding='utf-8').write(new)
print(f'✓ 已写入 config.js：{backend}')
PY

# ---- 4. 提交并推送 ----
git add -A
if git diff --cached --quiet; then
  echo "▸ 无变更，跳过提交"
else
  git -c user.name="${GIT_NAME:-allenjia}" -c user.email="${GIT_EMAIL:-jiahaocong@kuaishou.com}" \
    commit -q -m "deploy: 前端指向后端 ${BACKEND}"
  echo "✓ 已提交"
fi

echo "▸ 推送 main…"
git push -q "$REMOTE" main
echo "▸ 推送 gh-pages（前端静态产物）…"
git subtree push --prefix public "$REMOTE" "$BRANCH" 2>&1 | tail -3

SITE="https://$(echo "$REPO" | cut -d/ -f1 | tr '[:upper:]' '[:lower:]').github.io/$(echo "$REPO" | cut -d/ -f2)/"
echo ""
echo "════════════════════════════════════════════"
echo "  前端：$SITE"
echo "  后端：$BACKEND"
echo "  （Pages 构建约需 1 分钟）"
echo "════════════════════════════════════════════"
