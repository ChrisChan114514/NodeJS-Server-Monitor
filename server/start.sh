#!/bin/bash

cd "$(dirname "$0")"

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
    echo "[Server] Installing dependencies..."
    npm install
fi

# Ensure runtime folders exist
mkdir -p logs scripts database
chmod +x scripts/check_vnc_5901.sh 2>/dev/null || true

# Check PM2
if ! command -v pm2 &> /dev/null; then
    echo "[Server] PM2 not found. Installing global PM2..."
    npm install -g pm2
fi

# Stop existing instance
pm2 stop system-monitor-server 2>/dev/null
pm2 delete system-monitor-server 2>/dev/null

# Start Server
echo "[Server] Starting with PM2..."
pm2 start server.js --name "system-monitor-server"
pm2 save

echo "[Server] Running on http://localhost:5020"
echo "[Server] MQTT Broker on mqtt://localhost:1883"
