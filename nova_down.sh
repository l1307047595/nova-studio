#!/usr/bin/env bash
# Nova Image Studio 停止脚本
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stopped=0
if [ -f "$ROOT/nova.pid" ]; then
  pid="$(cat "$ROOT/nova.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && taskkill //PID "$pid" //F >/dev/null 2>&1 || true
    echo "已停止 PID $pid"
    stopped=1
  fi
  rm -f "$ROOT/nova.pid"
fi

# 兜底：按命令行匹配清理残留的 server.js 进程
leftover=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*nova-image-studio*server.js*' } | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r' | tr '\n' ' ')
if [ -n "${leftover// /}" ]; then
  for p in $leftover; do taskkill //PID "$p" //F >/dev/null 2>&1 && echo "已清理残留 PID $p"; stopped=1; done
fi

[ "$stopped" = "0" ] && echo "没有正在运行的 Nova 服务"
exit 0
