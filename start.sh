#!/bin/bash

# Navigate to project root
cd "$(dirname "$0")"

echo "========================================"
echo "System Monitor - One-Click Start"
echo "========================================"

# Start Server
echo ""
echo "[1/2] Starting Server..."
bash server/start.sh

# Start Client (Agent)
echo ""
echo "[2/2] Starting Agent..."
bash client/start.sh

echo ""
echo "========================================"
echo "All services started."
echo "Web:    http://localhost:5020"
echo "MQTT:   mqtt://localhost:1883"
echo ""
echo "PM2 process list:"
pm2 list
echo "========================================"
