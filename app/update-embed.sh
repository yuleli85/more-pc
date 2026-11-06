#!/usr/bin/env bash
# wb-fleet 连接程序升级脚本（Mac / Linux，总控下发版）
set -u
HUB='__HUB_URL__'
DIR="$HOME/.wb-fleet"

if [ ! -f "$DIR/agent.js" ]; then
  echo "这台还没接入总控（找不到 $DIR/agent.js），跳过。"
  exit 1
fi

if ! curl -fsSL "$HUB/agent.js" -o "$DIR/agent.js.new"; then
  echo "下载失败，原文件没动。"
  exit 1
fi

NEW=$(grep -o "const VERSION = '[0-9][0-9.]*'" "$DIR/agent.js.new" | head -1 | sed "s/.*'\([0-9.]*\)'/\1/")
if [ -z "$NEW" ]; then
  echo "下载到的内容不像连接程序，已放弃（原文件没动）。"
  rm -f "$DIR/agent.js.new"
  exit 1
fi
OLD=$(grep -o "const VERSION = '[0-9][0-9.]*'" "$DIR/agent.js" | head -1 | sed "s/.*'\([0-9.]*\)'/\1/")

cp "$DIR/agent.js" "$DIR/agent.js.bak" 2>/dev/null || true
mv "$DIR/agent.js.new" "$DIR/agent.js"
echo "已换成新版：${OLD:-?} -> $NEW"

nohup bash -c '
sleep 3
pkill -f "wb-fleet/agent.js" 2>/dev/null || true
sleep 2
pgrep -f "wb-fleet/agent.js" >/dev/null 2>&1 && exit 0   # launchd / systemd 已经拉起来了
if command -v node >/dev/null 2>&1; then N=node
elif [ -x "$HOME/.wb-fleet/node/bin/node" ]; then N="$HOME/.wb-fleet/node/bin/node"
else exit 0; fi
nohup "$N" "$HOME/.wb-fleet/agent.js" --config "$HOME/.wb-fleet/config.json" >> "$HOME/.wb-fleet/agent.log" 2>&1 &
' >/dev/null 2>&1 &

echo "连接程序会在 3 秒后自动重启：本机在总控网页上会短暂离线，随后自动回来。"
