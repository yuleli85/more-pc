#!/usr/bin/env bash
# 装 WorkBuddy 总控的终端（Mac / Linux）：装好后在终端里用 wb 命令向云主机派活、看各台状态、看结果。
# 用法：curl -fsSL "<总控>/term.sh?t=<口令>" | bash   （总控网页「加电脑」里直接复制）
# 不用管理员权限；没有 Node 就装一份到 ~/.wb-fleet。重跑就是升级或换总控。
set -euo pipefail
HUB="__HUB_URL__"; KEY="__FLEET_KEY__"
DIR="$HOME/.wb-fleet"; NODE_VER="v22.12.0"; MIRROR="https://npmmirror.com/mirrors/node"
mkdir -p "$DIR"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then NODE="$(command -v node)"
elif [ -x "$DIR/node/bin/node" ]; then NODE="$DIR/node/bin/node"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PKG="darwin-arm64" ;; Darwin-x86_64) PKG="darwin-x64" ;;
    Linux-x86_64) PKG="linux-x64" ;; Linux-aarch64) PKG="linux-arm64" ;;
    *) echo "不认识这台电脑的系统：$(uname -sm)"; exit 1 ;;
  esac
  say "装 Node（只放在 $DIR，不动系统）"
  curl -fsSL "$MIRROR/$NODE_VER/node-$NODE_VER-$PKG.tar.gz" | tar -xz -C "$DIR"
  rm -rf "$DIR/node"; mv "$DIR/node-$NODE_VER-$PKG" "$DIR/node"; NODE="$DIR/node/bin/node"
fi

curl -fsSL "$HUB/wb.js" -o "$DIR/wb.js"
umask 077; printf '{"hub":"%s","key":"%s"}\n' "$HUB" "$KEY" > "$DIR/wb.json"; umask 022

# wb 命令放进 PATH
if [ -w /usr/local/bin ]; then BIN=/usr/local/bin; else BIN="$HOME/.local/bin"; mkdir -p "$BIN"; fi
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE" "$DIR/wb.js" > "$BIN/wb"; chmod +x "$BIN/wb"
case ":$PATH:" in *":$BIN:"*) ;; *)
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    { [ -f "$rc" ] || [ "$rc" = "$HOME/.zshrc" -a "$(uname -s)" = Darwin ]; } && ! grep -qs "$BIN" "$rc" && echo "export PATH=\"$BIN:\$PATH\"" >> "$rc"
  done; NEWPATH=1 ;;
esac

say "终端装好了，先连一下总控："
"$BIN/wb" || { echo "连不上总控，看看地址对不对、云主机安全组有没有放行端口"; exit 1; }
echo
"$BIN/wb" help
[ -n "${NEWPATH:-}" ] && printf '\n\033[1;33m新开一个终端窗口\033[0m就能直接用 wb（这个窗口里先用 %s）。\n' "$BIN/wb"
exit 0
