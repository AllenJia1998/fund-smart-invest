#!/usr/bin/env bash
#
# 启动后端 + Cloudflare 快速隧道，输出公网地址。
#
# 用法：bash scripts/tunnel.sh [--port 5399]
#
# 说明：快速隧道（trycloudflare.com）无需 Cloudflare 账号，但**地址每次重启都会变**，
# 且进程关闭后即失效。变更后需要重新执行 scripts/deploy-pages.sh 让
# GitHub Pages 上的前端指向新地址。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-5399}"
CF_BIN="${CLOUDFLARED_BIN:-$ROOT/tools/cloudflared/cloudflared}"
LOG_DIR="$ROOT/data"
mkdir -p "$LOG_DIR"

# ---- 1. 确保后端在运行 ----
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then
  echo "▸ 后端未运行，正在启动…"
  ( cd "$ROOT" && nohup node server/index.js > "$LOG_DIR/server.log" 2>&1 & )
  for _ in $(seq 1 15); do
    sleep 1
    curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null && break
  done
fi
curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/status" \
  && echo "✓ 后端就绪 http://127.0.0.1:$PORT" \
  || { echo "✗ 后端启动失败，见 $LOG_DIR/server.log"; exit 1; }

# ---- 2. 准备 cloudflared ----
if [ ! -x "$CF_BIN" ]; then
  echo "▸ 下载 cloudflared…"
  mkdir -p "$(dirname "$CF_BIN")"
  curl -sSL -o /tmp/cf.tgz \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
  tar xzf /tmp/cf.tgz -C "$(dirname "$CF_BIN")"
  chmod +x "$CF_BIN"
fi

# ---- 3. 启动隧道并抓取地址 ----
TUNNEL_LOG="$LOG_DIR/tunnel.log"
: > "$TUNNEL_LOG"
echo "▸ 建立隧道…"
HOME="$ROOT/data" nohup "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate \
  > "$TUNNEL_LOG" 2>&1 &

for _ in $(seq 1 40); do
  sleep 1
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [ -n "$URL" ] && break
done

if [ -z "${URL:-}" ]; then
  echo "✗ 隧道地址获取失败，见 $TUNNEL_LOG"
  exit 1
fi

echo "$URL" > "$LOG_DIR/tunnel-url.txt"
echo ""
echo "════════════════════════════════════════════"
echo "  公网地址：$URL"
echo "  已保存到：data/tunnel-url.txt"
echo "════════════════════════════════════════════"
echo ""
echo "可用性自检："
for p in "" "chat.html" "api/funds/dashboard"; do
  printf "  %-22s HTTP %s\n" "/$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$URL/$p")"
done
echo ""
echo "如需前端也走这个地址，执行：bash scripts/deploy-pages.sh"
