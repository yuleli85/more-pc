#!/usr/bin/env bash
# 把这台电脑接进 WorkBuddy 总控（Mac / Linux）。用法：curl -fsSL "<总控>/join.sh?t=<口令>" | bash [-s -- 名字 [默认文件夹]]
# 做的事：没有 Node 就装一份到 ~/.wb-fleet（不用管理员权限）→ 没有 WorkBuddy 命令行就装上 → 下载连接程序 → 设成开机自动连。
set -euo pipefail
HUB="__HUB_URL__"
KEY="__FLEET_KEY__"
NAME="${1:-${FLEET_NAME:-$(hostname -s 2>/dev/null || hostname)}}"
WORKDIR="${2:-${FLEET_WORKDIR:-$HOME/WorkBuddy-tasks}}"
DIR="$HOME/.wb-fleet"
NODE_VER="v22.12.0"
MIRROR="https://npmmirror.com/mirrors/node"
REG="https://registry.npmmirror.com"
mkdir -p "$DIR" "$WORKDIR"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# 1. Node 18+
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then
  NODE="$(command -v node)"
elif [ -x "$DIR/node/bin/node" ]; then
  NODE="$DIR/node/bin/node"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PKG="darwin-arm64" ;; Darwin-x86_64) PKG="darwin-x64" ;;
    Linux-x86_64) PKG="linux-x64" ;; Linux-aarch64) PKG="linux-arm64" ;;
    *) echo "不认识这台电脑的系统：$(uname -sm)"; exit 1 ;;
  esac
  say "装 Node（只放在 $DIR，不动系统）"
  curl -fsSL "$MIRROR/$NODE_VER/node-$NODE_VER-$PKG.tar.gz" | tar -xz -C "$DIR"
  rm -rf "$DIR/node"; mv "$DIR/node-$NODE_VER-$PKG" "$DIR/node"
  NODE="$DIR/node/bin/node"
fi
NODE_BIN="$(dirname "$NODE")"
export PATH="$NODE_BIN:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 2. WorkBuddy 命令行（CodeBuddy Code，和 WorkBuddy 同一个内核、同一个账号）
CB="$(command -v codebuddy 2>/dev/null || true)"
if [ -z "$CB" ]; then
  say "装 WorkBuddy 命令行"
  if [ -w "$("$NODE_BIN/npm" prefix -g 2>/dev/null)/lib" ] 2>/dev/null; then
    "$NODE_BIN/npm" i -g @tencent-ai/codebuddy-code --registry="$REG" >/dev/null
    CB="$("$NODE_BIN/npm" prefix -g)/bin/codebuddy"
  else
    "$NODE_BIN/npm" i -g --prefix "$DIR/npm" @tencent-ai/codebuddy-code --registry="$REG" >/dev/null
    CB="$DIR/npm/bin/codebuddy"
  fi
fi
say "WorkBuddy 命令行：$("$CB" --version 2>/dev/null || echo 未知版本)"

# 3. 连接程序
curl -fsSL "$HUB/agent.js" -o "$DIR/agent.js"
ARGS=("$NODE" "$DIR/agent.js" --hub "$HUB" --key "$KEY" --name "$NAME" --workdir "$WORKDIR")
ENVPATH="$(dirname "$CB"):$NODE_BIN:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# 4. 开机自动连
if [ "$(uname -s)" = "Darwin" ]; then
  PL="$HOME/Library/LaunchAgents/cc.wbfleet.agent.plist"
  mkdir -p "$(dirname "$PL")"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
    echo '<key>Label</key><string>cc.wbfleet.agent</string><key>ProgramArguments</key><array>'
    for a in "${ARGS[@]}"; do printf '<string>%s</string>' "$(printf '%s' "$a" | sed 's/&/\&amp;/g;s/</\&lt;/g')"; done
    echo '</array><key>EnvironmentVariables</key><dict>'
    printf '<key>PATH</key><string>%s</string><key>CODEBUDDY_BIN</key><string>%s</string>' "$ENVPATH" "$CB"
    echo '</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
    printf '<key>StandardOutPath</key><string>%s</string><key>StandardErrorPath</key><string>%s</string>' "$DIR/agent.log" "$DIR/agent.log"
    echo '</dict></plist>'
  } > "$PL"
  launchctl bootout "gui/$(id -u)/cc.wbfleet.agent" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PL"
else
  # Linux：能用 systemd 就设成用户服务，不行就后台跑
  U="$HOME/.config/systemd/user/wb-fleet.service"
  QARGS=""; for a in "${ARGS[@]}"; do QARGS="$QARGS \"${a//\"/\\\"}\""; done
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 \
     && mkdir -p "$(dirname "$U")" \
     && printf '[Unit]\nDescription=WorkBuddy fleet agent\nAfter=network-online.target\n[Service]\nEnvironment="PATH=%s" "CODEBUDDY_BIN=%s"\nExecStart=%s\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=default.target\n' "$ENVPATH" "$CB" "$QARGS" > "$U" \
     && systemctl --user daemon-reload 2>/dev/null && systemctl --user enable wb-fleet.service 2>/dev/null && systemctl --user restart wb-fleet.service 2>/dev/null; then
    :
  else
    for p in $(pgrep -f "$DIR/agent.js" 2>/dev/null); do kill "$p" 2>/dev/null || true; done
    PATH="$ENVPATH" CODEBUDDY_BIN="$CB" nohup "${ARGS[@]}" >> "$DIR/agent.log" 2>&1 < /dev/null &
  fi
fi

sleep 3
say "这台已接入总控，名字「$NAME」，默认在 $WORKDIR 干活。回总控网页就能看到它。"
if echo "回复 OK 两个字母即可" | "$CB" -p --max-turns 1 2>&1 | grep -qi "Authentication required\|/login"; then
  printf '\n\033[1;33m还差一步：这台的 WorkBuddy 命令行没登录。\033[0m\n运行 codebuddy ，输入 /login 按提示用 WorkBuddy 的账号登录，登好输入 /exit 就行。\n'
fi
