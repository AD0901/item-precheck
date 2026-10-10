#!/bin/bash
# 启动工作台，并用 Cloudflare 隧道生成一个公网链接。按 Ctrl+C 同时停止两者。
cd "$(dirname "$0")"
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-8787}

node server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1

if [ -x bin/cloudflared ]; then
  echo "正在建立公网链接，稍等几秒，下面出现的 https://xxxx.trycloudflare.com 就是远程访问地址。"
  echo "这个地址每次启动都会变。电脑休眠或关闭本窗口后，链接失效。"
  bin/cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate 2>&1 | grep --line-buffered -E 'trycloudflare\.com|ERR'
else
  echo "没有找到 bin/cloudflared，只在本机运行：http://localhost:$PORT"
  wait $SERVER
fi
