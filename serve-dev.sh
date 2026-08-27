#!/usr/bin/env bash
# Start the Suwu dev server with live reload.
#
# Usage: ./serve-dev.sh {start|stop|restart|status|logs|build|web}
#
# Env overrides (optional):
#   DEMO_HOST       bind host        (default 127.0.0.1)
#   DEMO_PORT       listen port      (default 8000)
#   MAX_LOG_BYTES   rotate threshold (default 5242880 = 5 MiB)
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-start}"

export DEMO_HOST="${DEMO_HOST:-127.0.0.1}"
export DEMO_PORT="${DEMO_PORT:-8000}"
MAX_LOG_BYTES="${MAX_LOG_BYTES:-5242880}"

VAR=./var
LOG="$VAR/suwu.log"
PID="$VAR/suwu.pid"

is_running() {
  [[ -f "$PID" ]] || return 1
  local pid
  pid=$(cat "$PID" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

rotate() {
  [[ -f "$LOG" ]] || return 0
  local size
  size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  (( size < MAX_LOG_BYTES )) && return 0
  [[ -f "$LOG.1" ]] && mv -f "$LOG.1" "$LOG.2" 2>/dev/null || true
  mv -f "$LOG" "$LOG.1"
  echo "rotated $LOG -> $LOG.1"
}

web_build() {
  if [[ -d frontend/node_modules ]]; then
    echo "building web assets -> pkg/assets/web"
    pnpm build:web
  else
    echo "frontend dependencies not installed; run 'pnpm install' first" >&2
    echo "(starting server without embedded UI)" >&2
  fi
}

start() {
  if is_running; then
    echo "already running (pid $(cat "$PID"))"
    return 0
  fi
  web_build
  rotate
  nohup pnpm dev >>"$LOG" 2>&1 &
  echo $! >"$PID"
  echo "started (pid $!) -> http://${DEMO_HOST}:${DEMO_PORT}"
  echo "log: $LOG"
}

stop() {
  if ! is_running; then
    echo "not running"
    return 0
  fi
  local pid
  pid=$(cat "$PID")
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "graceful stop timed out, forcing"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID"
  echo "stopped (pid $pid)"
}

status() {
  if is_running; then
    echo "Suwu server: running (pid $(cat "$PID")) -> http://${DEMO_HOST}:${DEMO_PORT}"
    echo "log: $LOG"
  else
    echo "Suwu server: not running"
  fi
}

case "$CMD" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    tail -f "$LOG" ;;
  build)   web_build ;;
  web)     web_build ;;
  *)       echo "usage: $0 {start|stop|restart|status|logs|build|web}"; exit 2 ;;
esac
