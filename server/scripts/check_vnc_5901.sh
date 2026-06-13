#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$BASE_DIR/logs"
LOG_FILE="$LOG_DIR/check_vnc_5901.log"
PORT=5901
DISPLAY_NUM=1
VNC_MODE="${VNC_MODE:-xtigervnc}"
XTIGERVNC_BIN="/usr/bin/vncserver"
X11VNC="/usr/bin/x11vnc"
PASS_FILE="/home/cc/.vnc/passwd"
OUT_LOG="$LOG_DIR/xtigervnc_5901.log"

mkdir -p "$LOG_DIR"

timestamp() {
  date '+%F %T'
}

check_listen() {
  ss -ltn 2>/dev/null | grep -q ":${PORT}"
}

port_owner() {
  ss -ltnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {print $0}' | head -1
}

is_x11vnc_owner() {
  local owner
  owner="$(port_owner)"
  [ -n "$owner" ] && echo "$owner" | grep -qi 'x11vnc'
}

is_xtigervnc_owner() {
  local owner
  owner="$(port_owner)"
  [ -n "$owner" ] && echo "$owner" | grep -qi 'Xtigervnc'
}

is_expected_owner() {
  if [ "$VNC_MODE" = "x11vnc" ]; then
    is_x11vnc_owner
    return
  fi
  is_xtigervnc_owner
}

find_pids() {
  local pids
  pids=$(ps aux | awk '/[x]11vnc/ && /5901/ {print $2}' 2>/dev/null) || true
  if [ -z "${pids}" ] && command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -t -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)
  fi
  echo "${pids}"
}

resolve_display() {
  if [ -n "${DISPLAY:-}" ]; then
    echo "$DISPLAY"
    return
  fi

  # Prefer active logged-in graphical display (e.g. :1, :2).
  local active
  active=$(who 2>/dev/null | sed -n 's/.*(\(:[0-9]\+\)).*/\1/p' | head -1)
  if [ -n "$active" ]; then
    echo "$active"
    return
  fi

  # Fallback to discovered X sockets.
  local sock
  sock=$(ls /tmp/.X11-unix/X* 2>/dev/null | sed 's#.*/X##' | sort -n | tail -1)
  if [ -n "$sock" ]; then
    echo ":$sock"
    return
  fi

  echo ":0"
}

resolve_auth() {
  local auth
  if [ -n "${XAUTHORITY:-}" ]; then
    echo "$XAUTHORITY"
    return
  fi

  auth=$(ps aux | sed -n 's#.*-auth \([^ ]\+\).*#\1#p' | head -1)
  if [ -n "$auth" ]; then
    echo "$auth"
    return
  fi

  echo "/run/user/$(id -u)/gdm/Xauthority"
}

if [ "$VNC_MODE" = "x11vnc" ]; then
  DISPLAY_NUM="$(resolve_display)"
  AUTH_FILE="$(resolve_auth)"
  OUT_LOG="$LOG_DIR/x11vnc_5901.log"
else
  DISPLAY_NUM="1"
  AUTH_FILE=""
  OUT_LOG="$LOG_DIR/xtigervnc_5901.log"
fi

start_xtigervnc() {
  if [ ! -x "$XTIGERVNC_BIN" ]; then
    echo "$(timestamp) - restart FAILED: vncserver not found at $XTIGERVNC_BIN" >> "$LOG_FILE"
    return 1
  fi

  if [ ! -x "$HOME/.vnc/xstartup" ]; then
    echo "$(timestamp) - restart FAILED: xstartup missing or not executable at $HOME/.vnc/xstartup" >> "$LOG_FILE"
    return 1
  fi

  "$XTIGERVNC_BIN" -kill ":${DISPLAY_NUM}" >/dev/null 2>&1 || true
  sleep 1

  "$XTIGERVNC_BIN" ":${DISPLAY_NUM}" -localhost yes -geometry "${VNC_GEOMETRY:-1920x1080}" -depth "${VNC_DEPTH:-24}" >> "$OUT_LOG" 2>&1
}

start_x11vnc() {
  if [ ! -x "$X11VNC" ]; then
    echo "$(timestamp) - restart FAILED: x11vnc not found at $X11VNC" >> "$LOG_FILE"
    return 1
  fi

  if [ ! -f "$PASS_FILE" ]; then
    echo "$(timestamp) - restart FAILED: passwd file missing at $PASS_FILE" >> "$LOG_FILE"
    return 1
  fi

  local pids
  pids="$(find_pids)"
  if [ -n "$pids" ]; then
    echo "$(timestamp) - killing pids: ${pids}" >> "$LOG_FILE"
    kill ${pids} 2>/dev/null || kill -9 ${pids} 2>/dev/null || true
    sleep 1
  fi

  nohup "$X11VNC" \
    -display "$DISPLAY_NUM" \
    -auth "$AUTH_FILE" \
    -rfbport ${PORT} \
    -forever \
    -shared \
    -rfbauth "$PASS_FILE" \
    -o "$OUT_LOG" \
    >/dev/null 2>&1 &
}

echo "$(timestamp) - checking port ${PORT}" >> "$LOG_FILE"

if check_listen; then
  if is_expected_owner; then
    echo "$(timestamp) - port ${PORT} LISTEN by expected owner (${VNC_MODE}) OK" >> "$LOG_FILE"
    exit 0
  fi

  echo "$(timestamp) - port ${PORT} LISTEN by unexpected owner (${VNC_MODE} expected): $(port_owner)" >> "$LOG_FILE"
  exit 1
fi

echo "$(timestamp) - port ${PORT} NOT LISTEN, attempting restart (${VNC_MODE})" >> "$LOG_FILE"

if [ "$VNC_MODE" = "x11vnc" ]; then
  start_x11vnc || exit 1
else
  start_xtigervnc || exit 1
fi

sleep 2

if check_listen && is_expected_owner; then
  echo "$(timestamp) - restart succeeded (${VNC_MODE}) with display ${DISPLAY_NUM}" >> "$LOG_FILE"
  exit 0
fi

echo "$(timestamp) - restart FAILED (mode=${VNC_MODE} display=${DISPLAY_NUM} auth=${AUTH_FILE} owner=$(port_owner))" >> "$LOG_FILE"
exit 1
