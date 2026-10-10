#!/bin/bash
# 启动工作台。同一局域网的人可以直接访问；如果 Cloudflare 隧道连得上，还会给出一个公网链接。
# 按 Ctrl+C 停止。
cd "$(dirname "$0")"
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-8787}
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -z "$IP" ] && IP=$(ifconfig | awk '/inet 192\.168|inet 10\.|inet 172\./{print $2; exit}')

node server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
[ -n "$IP" ] && echo "局域网访问地址：http://$IP:$PORT（需与本机在同一网络）"

if [ -x bin/cloudflared ]; then
  echo "正在尝试建立公网链接。成功的话，下面会出现 https://xxxx.trycloudflare.com，每次启动都会变。"
  bin/cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate 2>&1 \
    | grep --line-buffered -o -E 'https://[a-z0-9-]+\.trycloudflare\.com|failed to request quick Tunnel.*|Unable to establish.*'
  echo "公网链接没有建立成功，通常是当前网络连不上 Cloudflare。服务仍在运行，局域网地址可用。"
fi
wait $SERVER
