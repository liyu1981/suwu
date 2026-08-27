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

# PID file stores the process-group leader (see start()). stop() kills that
# group (pnpm -> air) and then sweeps the server binary: air starts its child
# in a separate session, so it survives a plain group kill.
ROOT="$(pwd)"
SERVER_RE="^(/bin/sh -c )?${ROOT}/tmp/suwu( --dev)?$"

stray_server_pids() { pgrep -f "$ROOT/tmp/suwu" || true; }

is_running() {
  [[ -f "$PID" ]] || return 1
  local pid
  pid=$(cat "$PID" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill -0 "-$pid" 2>/dev/null
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
  # Reap leftover server binaries from a crashed/killed previous run before
  # anything else binds the port.
  local strays
  strays=$(stray_server_pids)
  if [[ -n "$strays" ]]; then
    echo "reaping stray server processes: $(echo "$strays" | tr '\n' ' ')"
    pkill -9 -f "$SERVER_RE" 2>/dev/null || true
    sleep 0.3
  fi
  if is_running; then
    echo "already running (pgid $(cat "$PID"))"
    return 0
  fi
  web_build
  rotate
  # setsid: new process group so stop() can signal pnpm, air, and the server
  # (children + grandchildren) with one group kill.
  nohup setsid pnpm dev >>"$LOG" 2>&1 &
  echo $! >"$PID"
  echo "started (pid $!) -> http://${DEMO_HOST}:${DEMO_PORT}"
  echo "log: $LOG"
}

stop() {
  local pid
  if ! is_running && [[ -z "$(stray_server_pids)" ]]; then
    echo "not running"
    return 0
  fi
  pid=$(cat "$PID" 2>/dev/null || echo 0)
  # Escalate gracefully: SIGINT (air is built around Ctrl+C semantics and
  # forwards a graceful shutdown; SIGTERM makes it hang), then SIGTERM,
  # then SIGKILL. The air-spawned server lives in its own session outside
  # the group, so signal the SERVER_RE processes directly as well.
  if [[ "$pid" != 0 ]]; then kill -INT "-$pid" 2>/dev/null || true; fi
  pkill -INT -f "$SERVER_RE" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! (kill -0 "-$pid" 2>/dev/null || pkill -0 -f "$SERVER_RE" 2>/dev/null); then break; fi
    sleep 0.1
  done
  if kill -0 "-$pid" 2>/dev/null || pkill -0 -f "$SERVER_RE" 2>/dev/null; then
    kill -TERM "-$pid" 2>/dev/null || true
    pkill -TERM -f "$SERVER_RE" 2>/dev/null || true
    sleep 1
    if kill -0 "-$pid" 2>/dev/null || pkill -0 -f "$SERVER_RE" 2>/dev/null; then
      echo "graceful stop timed out, forcing"
      kill -9 "-$pid" 2>/dev/null || true
      pkill -9 -f "$SERVER_RE" 2>/dev/null || true
    fi
  fi
  rm -f "$PID"
  echo "stopped"
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
