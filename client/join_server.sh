#!/usr/bin/env bash
set -euo pipefail

# 一键加入 Server 脚本
# 功能：从示例复制配置、可选编辑、安装依赖并启动客户端

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "一键加入 Server：client/join_server.sh"

# 备份已有配置
if [ -f agent.config.json ]; then
  ts=$(date +%s)
  cp agent.config.json "agent.config.json.bak.$ts"
  echo "已备份现有 agent.config.json -> agent.config.json.bak.$ts"
fi

# 如果不存在则从示例复制
if [ ! -f agent.config.json ] && [ -f agent.config.json.example ]; then
  cp agent.config.json.example agent.config.json
  echo "已从 agent.config.json.example 创建 agent.config.json"
fi

# 自动确保 deviceId 唯一：如果 deviceId 是 "local" 等通用值，替换为本机 hostname
HOSTNAME="$(hostname 2>/dev/null || echo '')"
if [ -f agent.config.json ] && [ -n "$HOSTNAME" ]; then
  CURRENT_DEVICE_ID=$(node -e "try{process.stdout.write(require('./agent.config.json').deviceId||'')}catch(e){process.stdout.write('')}" 2>/dev/null || echo '')
  GENERIC_IDS="local localhost default agent test"
  for gid in $GENERIC_IDS; do
    if [ "${CURRENT_DEVICE_ID,,}" = "$gid" ]; then
      echo "⚠ 检测到 deviceId 为通用值 \"$CURRENT_DEVICE_ID\"，自动替换为 hostname: \"$HOSTNAME\""
      node -e "
        const fs=require('fs');
        const cfg=JSON.parse(fs.readFileSync('agent.config.json','utf8'));
        cfg.deviceId='$HOSTNAME';
        fs.writeFileSync('agent.config.json', JSON.stringify(cfg, null, 4) + '\n');
      " 2>/dev/null || true
      CURRENT_DEVICE_ID="$HOSTNAME"
      break
    fi
  done
  if [ -z "$CURRENT_DEVICE_ID" ]; then
    echo "⚠ deviceId 为空，自动设置为 hostname: \"$HOSTNAME\""
    node -e "
      const fs=require('fs');
      const cfg=JSON.parse(fs.readFileSync('agent.config.json','utf8'));
      cfg.deviceId='$HOSTNAME';
      fs.writeFileSync('agent.config.json', JSON.stringify(cfg, null, 4) + '\n');
    " 2>/dev/null || true
  fi
fi

# 提示用户编辑配置
DEFAULT_EDITOR="${EDITOR:-nano}"
read -r -p "是否现在编辑 agent.config.json ? (默认 $DEFAULT_EDITOR) [Y/n]: " edit_choice
edit_choice=${edit_choice:-Y}
if [[ "$edit_choice" =~ ^([yY]|$) ]]; then
  if command -v "$DEFAULT_EDITOR" >/dev/null 2>&1; then
    "$DEFAULT_EDITOR" agent.config.json
  else
    echo "未发现编辑器 $DEFAULT_EDITOR，跳过编辑。你可以手动修改 agent.config.json 后再运行本脚本。"
  fi
fi

# 检查 node 与 npm
need_node=false
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 node。"
  need_node=true
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "未检测到 npm。"
  need_node=true
fi
if [ "$need_node" = true ]; then
  echo "请先安装 Node.js (建议 v16+)。"
  echo "Debian/Ubuntu: sudo apt update && sudo apt install -y nodejs npm" 
  echo "或使用 NodeSource: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
  read -r -p "安装好后按回车继续，输入 q 退出: " choice
  if [ "$choice" = "q" ]; then
    echo "退出。"
    exit 1
  fi
fi

# 安装依赖
if [ -f package.json ]; then
  echo "检测到 package.json，开始安装依赖 (npm install)..."
  npm install --no-audit --no-fund
else
  echo "未检测到 package.json，跳过依赖安装。"
fi

# 启动客户端
echo "准备启动客户端..."
if [ -f start.sh ]; then
  chmod +x start.sh || true
  echo "使用 start.sh 启动（阻塞）..."
  exec ./start.sh
elif [ -f agent.js ]; then
  echo "使用 node 启动 agent.js（阻塞）..."
  exec node agent.js
elif [ -f package.json ] && grep -q "\"start\"\s*:\s*" package.json; then
  echo "使用 npm start 启动（阻塞）..."
  exec npm start
else
  echo "未找到可用的启动方式：请手动运行 'node agent.js' 或 'sh start.sh'。"
  exit 1
fi
