#!/usr/bin/env bash
# Nova Image Studio 启动脚本（本机回环 127.0.0.1:3111）
# 用法：bash nova_up.sh            # 后台启动
#       PORT=3222 bash nova_up.sh  # 换端口
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT/backend" || { echo "找不到 backend 目录"; exit 1; }

mkdir -p data nova-images

# 必须在 node 启动前设成进程环境变量：server.js:7 早于 .env 解析执行 require('next')，
# 若为 development 会去 require('next') 并直接崩（backend 未装 next 运行时依赖）。
export NODE_ENV=production
export PORT="${PORT:-3111}"
# Windows/git-bash 环境里 HOSTNAME 已被预设为计算机名，会覆盖 .env 的 HOSTNAME，
# 导致绑定到内网 IP:3111 而不是回环。这里强制覆盖。
export HOSTNAME="127.0.0.1"

if [ -f "$ROOT/nova.pid" ] && kill -0 "$(cat "$ROOT/nova.pid")" 2>/dev/null; then
  echo "已在运行（PID $(cat "$ROOT/nova.pid")），先执行 bash nova_down.sh"
  exit 0
fi

nohup node server.js > "$ROOT/nova.log" 2>&1 &
echo $! > "$ROOT/nova.pid"
echo "启动中 PID $(cat "$ROOT/nova.pid") → http://127.0.0.1:$PORT/"

for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "就绪：http://127.0.0.1:$PORT/  (日志：$ROOT/nova.log)"
    exit 0
  fi
  sleep 1
done

echo "30 秒内未就绪，日志尾部："
tail -n 20 "$ROOT/nova.log"
exit 1
