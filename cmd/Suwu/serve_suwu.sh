#!/usr/bin/env bash
# serve_suwu.sh — manage the Suwu server (embedded, executed by 'suwu daemon').
#
# Usage: suwu daemon {start|stop|restart|status|logs}
#
# Expects the binary at ~/.local/bin/suwu (override with SUWU_BIN).
# PID and logs live in ~/.suwu/ (override with SUWU_VAR).
# Config resolution: shell env → ~/.config/suwu/.env → defaults.
set -euo pipefail

CMD="${1:-start}"

BIN="${SUWU_BIN:-$HOME/.local/bin/suwu}"
VAR="${SUWU_VAR:-$HOME/.suwu}"
LOG="$VAR/suwu.log"
PID="$VAR/suwu.pid"
MAX_LOG_BYTES="${MAX_LOG_BYTES:-5242880}"

GLOBAL_CFG="${SUWU_CONFIG_DIR:-$HOME/.config/suwu}"

# ---------------------------------------------------------------------------
# Env resolution — mirrors the binary's precedence chain
# ---------------------------------------------------------------------------

env_file_value() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$file" 2>/dev/null | head -n 1) || return 0
  line=${line#*=}
  line="${line#\"}"; line="${line%\"}"
  line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

env_value() {
  local key="$1" v
  v=$(env_file_value "$GLOBAL_CFG/.env" "$key")
  printf '%s' "$v"
}

# Effective host: shell env beats ~/.config/suwu/.env, then production default.
if [[ -n "${HOST:-}" ]]; then
  RESOLVED_HOST="$HOST"
else
  RESOLVED_HOST="$(env_value HOST)"
  RESOLVED_HOST="${RESOLVED_HOST:-127.0.0.1}"
fi

# Effective port: shell env beats ~/.config/suwu/.env, then production default.
if [[ -n "${PORT:-}" ]]; then
  RESOLVED_PORT="$PORT"
else
  RESOLVED_PORT="$(env_value PORT)"
  RESOLVED_PORT="${RESOLVED_PORT:-8080}"
fi

# TLS scheme mirrors the server's resolveTLS.
TLS_CERT_FILE="${TLS_CERT_FILE:-$(env_value TLS_CERT_FILE)}"
TLS_KEY_FILE="${TLS_KEY_FILE:-$(env_value TLS_KEY_FILE)}"
if [[ -z "$TLS_CERT_FILE" && -z "$TLS_KEY_FILE" ]] \
   && [[ -f "$GLOBAL_CFG/tls-cert.pem" && -f "$GLOBAL_CFG/tls-key.pem" ]]; then
  TLS_CERT_FILE="$GLOBAL_CFG/tls-cert.pem"
  TLS_KEY_FILE="$GLOBAL_CFG/tls-key.pem"
fi
SCHEME=https
[[ -z "$TLS_CERT_FILE" || -z "$TLS_KEY_FILE" ]] && SCHEME=http

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

url() { printf '%s://%s:%s%s' "$SCHEME" "$DISPLAY_HOST" "$RESOLVED_PORT" "$BIND_NOTE"; }

# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

SERVER_RE="^${BIN} serve$"

stray_pids() { pgrep -f "$SERVER_RE" 2>/dev/null || true; }

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

start() {
  if [[ ! -x "$BIN" ]]; then
    echo "error: suwu binary not found at $BIN" >&2
    echo "hint: install with 'go install ./cmd/Suwu@latest' or build and copy manually" >&2
    exit 1
  fi
  # Ensure the data directory exists.
  if [[ ! -d "$VAR" ]]; then
    mkdir -p "$VAR" || { echo "error: cannot create $VAR" >&2; exit 1; }
  fi

  # Reap leftover server binaries from a crashed/killed previous run before
  # anything else binds the port.
  local strays
  strays=$(stray_pids)
  if [[ -n "$strays" ]]; then
    echo "reaping stray server processes: $(echo "$strays" | tr '\n' ' ')"
    pkill -9 -f "$SERVER_RE" 2>/dev/null || true
    sleep 0.3
  fi
  if is_running; then
    echo "already running (pgid $(cat "$PID"))"
    return 0
  fi
  rotate
  # setsid: new process group so stop() can signal the server cleanly.
  nohup setsid "$BIN" serve >>"$LOG" 2>&1 &
  echo $! >"$PID"
  echo "started (pid $!) -> $(url)"
  echo "log: $LOG"
}

stop() {
  local pid
  if ! is_running && [[ -z "$(stray_pids)" ]]; then
    echo "not running"
    return 0
  fi
  pid=$(cat "$PID" 2>/dev/null || echo 0)
  # Graceful: SIGINT → server prints "Shutting down..." and drains.
  if [[ "$pid" != 0 ]]; then kill -INT "-$pid" 2>/dev/null || true; fi
  pkill -INT -f "$SERVER_RE" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! (kill -0 "-$pid" 2>/dev/null) && ! (pkill -0 -f "$SERVER_RE" 2>/dev/null); then
      break
    fi
    sleep 0.1
  done
  if kill -0 "-$pid" 2>/dev/null || pkill -0 -f "$SERVER_RE" 2>/dev/null; then
    echo "graceful stop timed out, forcing"
    kill -TERM "-$pid" 2>/dev/null || true
    pkill -TERM -f "$SERVER_RE" 2>/dev/null || true
    sleep 1
    if kill -0 "-$pid" 2>/dev/null || pkill -0 -f "$SERVER_RE" 2>/dev/null; then
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
  *)       echo "usage: $0 {start|stop|restart|status|logs}"; exit 2 ;;
esac
