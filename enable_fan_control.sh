#!/bin/bash
set -e

echo "[1/3] 允许 root 访问当前 X 会话..."
if command -v xhost >/dev/null 2>&1; then
  xhost +SI:localuser:root || true
else
  echo "xhost 不存在，请先安装 x11-xserver-utils"
fi

echo "[2/3] 测试 nvidia-settings 是否可访问..."
DISPLAY=:0 XAUTHORITY=/home/cc/.Xauthority nvidia-settings -q GPUFanControlState || true

echo "[3/3] 提示：如需无密码控制风扇，请手动执行以下命令配置 sudoers："
echo "sudo visudo"
echo "追加一行："
echo "cc ALL=(root) NOPASSWD: /usr/bin/nvidia-settings"

echo "完成。若 BIOS 锁定风扇，本脚本也无法强制解除。"
