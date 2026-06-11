#!/bin/bash

# Navigate to script directory
cd "$(dirname "$0")"

# Ensure runtime folders and scripts are ready
mkdir -p logs scripts
chmod +x scripts/check_vnc_5901.sh 2>/dev/null || true

# Install dependencies if not already installed (fast check)
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "PM2 not found. Installing global PM2..."
    npm install -g pm2
fi

# Kill any process occupying port 5020 to avoid EADDRINUSE
PIDS=$(ss -ltnp 2>/dev/null | awk -F 'pid=' '/:5020/ {split($2,a,","); print a[1]}' | sort -u)
if [ -n "$PIDS" ]; then
    echo "Killing processes on 5020: $PIDS"
    kill -9 $PIDS 2>/dev/null || true
fi

# Stop and delete existing process to apply changes cleanly
pm2 stop system-monitor 2>/dev/null
pm2 delete system-monitor 2>/dev/null

# Start the application with PM2
echo "Starting System Monitor with PM2..."
pm2 start server.js --name "system-monitor"

# Save PM2 process list
pm2 save

echo "--------------------------------------------------------"
echo "To enable startup on boot, please run the command printed below by PM2:"
pm2 startup
echo "--------------------------------------------------------"

echo "System Monitor is running on port 5020."
echo "Access it at http://localhost:5020"
