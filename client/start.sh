#!/bin/bash

cd "$(dirname "$0")"

# Install dependencies if missing
if [ ! -d "node_modules" ]; then
    echo "[Agent] Installing dependencies..."
    npm install
fi

# Check PM2
if ! command -v pm2 &> /dev/null; then
    echo "[Agent] PM2 not found. Installing global PM2..."
    npm install -g pm2
fi

# Stop existing instance
pm2 stop system-monitor-agent 2>/dev/null
pm2 delete system-monitor-agent 2>/dev/null

# Start Agent
echo "[Agent] Starting with PM2..."
pm2 start agent.js --name "system-monitor-agent"
pm2 save

echo "[Agent] Connected to broker defined in agent.config.json"
