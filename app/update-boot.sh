#!/usr/bin/env bash
# 引导脚本（Mac / Linux）：把更新丢到分离的后台进程，自己立刻返回
set -u
U='__HUB_URL__/update.sh?t=__FLEET_KEY__'
DIR="$HOME/.wb-fleet"
mkdir -p "$DIR" 2>/dev/null || true
LOG="$DIR/update.log"
nohup bash -c "sleep 4; curl -fsSL '$U' | bash" >>"$LOG" 2>&1 &
echo "更新已在后台开始（约 10 秒完成）。连接程序会短暂断线，随后自动重连。"
echo "过程日志：$LOG"
