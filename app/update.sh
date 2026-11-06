#!/usr/bin/env bash
# 只更新「连接程序」到最新版（Mac / Linux）
# 用法：curl -fsSL "<总控>/update.sh?t=<口令>" | bash
set -u

HUB='__HUB_URL__'
DIR="$HOME/.wb-fleet"

if [ ! -f "$DIR/agent.js" ]; then
  echo "这台还没接入总控：请用网页「加电脑」里的加入命令。"
  exit 1
fi
if [ -f "$DIR/config.json" ]; then
  H=$(node -e "try{console.log(require('$DIR/config.json').hub||'')}catch(e){}" 2>/dev/null || true)
  [ -n "$H" ] && HUB="$H"
fi

echo "从 $HUB 下载最新连接程序..."
if ! curl -fsSL "$HUB/agent.js" -o "$DIR/agent.js.new"; then
  echo "下载失败，原文件没动。"
  exit 1
fi

NEWVER=$(grep -o "const VERSION = '[0-9][0-9.]*'" "$DIR/agent.js.new" | head -1 | sed "s/.*'\([0-9.]*\)'/\1/")
if [ -z "$NEWVER" ]; then
  echo "下载到的文件不像连接程序，已放弃（原文件没动）。"
  rm -f "$DIR/agent.js.new"
  exit 1
fi
OLDVER=$(grep -o "const VERSION = '[0-9][0-9.]*'" "$DIR/agent.js" | head -1 | sed "s/.*'\([0-9.]*\)'/\1/")

cp "$DIR/agent.js" "$DIR/agent.js.bak" 2>/dev/null || true
mv "$DIR/agent.js.new" "$DIR/agent.js"

pkill -f "wb-fleet/agent.js" 2>/dev/null || true
sleep 2
if ! pgrep -f "wb-fleet/agent.js" >/dev/null 2>&1; then
  # launchd（Mac）/ systemd（Linux）没接管时才手动拉起来
  if command -v node >/dev/null 2>&1; then N=node
  elif [ -x "$DIR/node/bin/node" ]; then N="$DIR/node/bin/node"
  else N=""; fi
  if [ -n "$N" ]; then
    nohup "$N" "$DIR/agent.js" --config "$DIR/config.json" >> "$DIR/agent.log" 2>&1 < /dev/null &
  fi
fi

echo "连接程序 ${OLDVER:-?} -> $NEWVER 已更新，正在重连总控（约 5 秒）。"
echo "回总控网页刷新一下，那台电脑的版本号应该变了。"
