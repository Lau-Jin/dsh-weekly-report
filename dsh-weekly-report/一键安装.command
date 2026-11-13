#!/bin/bash
# 周报工作台 · macOS 双击安装
# 在 Finder 里双击本文件即可：自动定位 Node、执行 install.mjs、打开面板。
cd "$(dirname "$0")" || exit 1

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for c in \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "未找到 Node.js（需要 20 以上版本）。DeepSeek Harness 自带 Node，也可自行安装。"
  read -r -p "按回车关闭…" _
  exit 1
fi

echo "使用 Node：$NODE"
"$NODE" install.mjs --open
rc=$?
echo
echo "面板地址：http://127.0.0.1:8798/"
echo "DSH 左侧边栏「周报」也可直接使用。"
read -r -p "按回车关闭…" _
exit "$rc"
