#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${PURETEXT_WORKER_DIR:-/workspace/puretext-render-worker}"
STATE_DIR="${PURETEXT_WORKER_STATE_DIR:-/workspace/.puretext-render-worker}"
PID_FILE="$STATE_DIR/worker.pid"
LOG_FILE="$STATE_DIR/worker.log"

mkdir -p "$STATE_DIR"

is_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

case "${1:-status}" in
  start)
    if is_running; then
      echo "Worker is already running (PID $(cat "$PID_FILE"))."
      exit 0
    fi
    : "${PURETEXT_API_BASE:?PURETEXT_API_BASE must be set}"
    : "${RENDER_WORKER_TOKEN:?RENDER_WORKER_TOKEN must be set}"
    cd "$INSTALL_DIR"
    nohup /usr/bin/tini -- node --enable-source-maps dist/src/index.js >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    sleep 2
    if ! is_running; then
      echo "Worker failed to start. Last log lines:" >&2
      tail -n 80 "$LOG_FILE" >&2 || true
      exit 1
    fi
    echo "Worker started (PID $(cat "$PID_FILE"))."
    ;;
  stop)
    if ! is_running; then
      rm -f "$PID_FILE"
      echo "Worker is not running."
      exit 0
    fi
    kill "$(cat "$PID_FILE")"
    for _ in $(seq 1 20); do
      is_running || break
      sleep 0.5
    done
    is_running && kill -9 "$(cat "$PID_FILE")"
    rm -f "$PID_FILE"
    echo "Worker stopped."
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if is_running; then
      echo "Worker is running (PID $(cat "$PID_FILE"))."
      curl -fsS "http://127.0.0.1:${HEALTH_PORT:-8080}/health" || true
      echo
    else
      echo "Worker is not running."
      exit 1
    fi
    ;;
  logs)
    touch "$LOG_FILE"
    tail -n 200 -f "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac

