#!/usr/bin/env bash
# 收银宝服务端启动脚本（macOS / Linux）
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js。"
  echo "请先安装（https://nodejs.org 或包管理器），然后重新运行本脚本。"
  exit 1
fi

echo "正在启动收银宝服务端（端口 3000）..."
echo "访问地址将打印在下方，手机/其他电脑用'局域网访问'那行地址。"
echo "关闭服务：按 Ctrl+C。"
exec node server.js
