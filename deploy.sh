#!/bin/bash
# 国内云一键部署脚本（阿里云 / 腾讯云轻量服务器，Ubuntu 22.04）
# 用法：把代码传到服务器后，在代码目录里运行 bash deploy.sh
# 第一次运行会装 Node 20 + PM2 + Nginx，之后每次更新代码再跑一次即可
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "正在安装 Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "正在安装 PM2..."
  sudo npm install -g pm2
fi
if ! command -v nginx >/dev/null 2>&1; then
  echo "正在安装 Nginx..."
  sudo apt-get update && sudo apt-get install -y nginx
fi

# 改密码：第一次务必改掉 ecosystem.config.js 里的 ADMIN_PASSWORD
if grep -q "change-me-123456" ecosystem.config.js; then
  echo "⚠️  请先改掉 ecosystem.config.js 里的 ADMIN_PASSWORD 再部署！"
  echo "   改完再跑一次 bash deploy.sh"
  exit 1
fi

sudo mkdir -p /data/concert-order
sudo chown -R "$USER":"$USER" /data/concert-order

pm2 delete concert-order || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" || true

echo "✅ 已启动，本地检查：curl http://127.0.0.1:3000/health"
echo "下一步：把 nginx.conf 里的域名换成你的，复制到 /etc/nginx/conf.d/，再开 80/443 端口和 HTTPS，见 README.md"
