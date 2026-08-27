#!/usr/bin/env bash
# Start the Suwu dev server with live reload.
#
# Usage: ./serve-dev.sh {start|stop|restart|status|logs|build|web}
#
# The displayed URL mirrors what the server binary actually binds, resolving
# host/port exactly like cmd/Suwu does:
#   1. shell environment HOST/PORT (always win — the binary loads .env only
#      for variables not already set)
#   2. ./.env (first occurrence of a key wins, like envfile.Load)
#   3. dev defaults: 127.0.0.1:8000 (air runs the server with --dev)
# RESOLVED_HOST/RESOLVED_PORT and DEMO_HOST/DEMO_PORT are exported for child
# processes (e.g. vite.config.ts proxies to DEMO_PORT).
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-start}"

MAX_LOG_BYTES="${MAX_LOG_BYTES:-5242880}"

VAR=./var
LOG="$VAR/suwu.log"
PID="$VAR/suwu.pid"

# Print the value of KEY from ./.env (first occurrence, quotes stripped), or
# nothing when the file/key is missing. Mirrors envfile.Load parsing.
env_file_value() {
  local key="$1" line
  [[ -f .env ]] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" .env 2>/dev/null | head -n 1) || return 0
  line=${line#*=}
  line="${line#\"}"; line="${line%\"}"
  line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

# Effective host: shell env beats .env, then the dev default.
if [[ -n "${HOST:-}" ]]; then
  RESOLVED_HOST="$HOST"
else
  RESOLVED_HOST="$(env_file_value HOST)"
  RESOLVED_HOST="${RESOLVED_HOST:-127.0.0.1}"
fi

# Effective port: shell env beats .env, then the dev default (8000, since
# air starts the server with --dev).
if [[ -n "${PORT:-}" ]]; then
  RESOLVED_PORT="$PORT"
else
  RESOLVED_PORT="$(env_file_value PORT)"
  RESOLVED_PORT="${RESOLVED_PORT:-8000}"
fi

# Wildcard binds are reachable via loopback; display a clickable URL but
# note the actual bind address.
DISPLAY_HOST="$RESOLVED_HOST"
BIND_NOTE=""
case "$RESOLVED_HOST" in
  0.0.0.0|::|'*'|'')
    [[ -n "$RESOLVED_HOST" ]] && BIND_NOTE=" (bound to $RESOLVED_HOST)"
    DISPLAY_HOST="127.0.0.1"
    ;;
esac
export DEMO_HOST="$RESOLVED_HOST" DEMO_PORT="$RESOLVED_PORT"

url() { printf 'http://%s:%s%s' "$DISPLAY_HOST" "$RESOLVED_PORT" "$BIND_NOTE"; }

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
  echo "started (pid $!) -> $(url)"
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
    echo "Suwu server: running (pid $(cat "$PID")) -> $(url)"
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
