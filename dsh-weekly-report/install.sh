#!/usr/bin/env bash
# 周报工作台 · Linux / 通用一键安装
#   bash install.sh            安装并打开面板
#   bash install.sh --verify   校验
#   bash install.sh --uninstall 回滚
set -u
cd "$(dirname "$0")" || exit 1

NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for c in \
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
    /usr/local/bin/node /usr/bin/node; do
    if [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "未找到 Node.js（需要 20 以上版本）。" >&2
  exit 1
fi

if [ "${1:-}" = "--verify" ] || [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "--dry-run" ]; then
  exec "$NODE" install.mjs "$1"
fi

"$NODE" install.mjs --open "$@"
rc=$?
echo "面板地址：http://127.0.0.1:8798/"
exit "$rc"
