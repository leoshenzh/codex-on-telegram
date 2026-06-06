#!/usr/bin/env bash
set -euo pipefail
CANONICAL_CTI_HOME="$HOME/.claude-to-im"
CTI_HOME="${CTI_HOME:-$CANONICAL_CTI_HOME}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"

# shellcheck source=config-env.sh
source "$SKILL_DIR/scripts/config-env.sh"

# ── Common helpers ──

ensure_dirs() { mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}; }

newer_than() {
  local search_dir="$1"
  local target_file="$2"
  [ -d "$search_dir" ] || return 1
  find "$search_dir" -type f -newer "$target_file" 2>/dev/null | head -1 | grep -q .
}

ensure_built() {
  local lib_dist_dir="$SKILL_DIR/lib/dist"
  local need_build=0

  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    need_build=1
  else
    # Check if any source file is newer than the bundle
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
    # The daemon bundle depends on the shared library build output.
    if [ "$need_build" = "0" ] && [ -d "$lib_dist_dir" ]; then
      if newer_than "$lib_dist_dir" "$SKILL_DIR/dist/daemon.mjs"; then
        need_build=1
      fi
    fi
  fi
  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

# Clean environment for subprocess isolation.
clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  local runtime
  runtime="$(get_config_value "$CTI_HOME/config.env" CTI_RUNTIME || true)"
  runtime="${runtime:-claude}"

  local mode="${CTI_ENV_ISOLATION:-inherit}"
  if [ "$mode" = "strict" ]; then
    case "$runtime" in
      codex)
        while IFS='=' read -r name _; do
          case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      claude)
        # Keep ANTHROPIC_* (from config.env) — needed for third-party API providers.
        # Strip OPENAI_* to avoid cross-runtime leakage.
        while IFS='=' read -r name _; do
          case "$name" in OPENAI_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      auto)
        # Keep both ANTHROPIC_* and OPENAI_* for auto mode
        ;;
    esac
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || echo ""
}

read_status_pid() {
  [ -f "$STATUS_FILE" ] || { echo ""; return 0; }
  node -e 'try { const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (s && s.pid) process.stdout.write(String(s.pid)); } catch {}' "$STATUS_FILE" 2>/dev/null || true
}

read_runtime_pid() {
  local pid
  pid=$(read_pid)
  if [ -z "$pid" ]; then
    pid=$(read_status_pid)
  fi
  echo "$pid"
}

pid_alive() {
  local pid="$1"
  local err
  [ -n "$pid" ] || return 1
  err=$(kill -0 "$pid" 2>&1) && return 0
  case "$err" in
    *"Operation not permitted"*|*"operation not permitted"*) return 0 ;;
  esac
  ps -p "$pid" >/dev/null 2>&1
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

write_stopped_status() {
  mkdir -p "$(dirname "$STATUS_FILE")"
  node -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({ running: false, lastExitReason: process.argv[2] }, null, 2) + "\n", "utf-8");' \
    "$STATUS_FILE" "${1:-stopped by daemon.sh}"
}

show_failure_help() {
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
  echo ""
  echo "Next steps:"
  echo "  1. Run diagnostics:  bash \"$SKILL_DIR/scripts/doctor.sh\""
  echo "  2. Check full logs:  bash \"$SKILL_DIR/scripts/daemon.sh\" logs 100"
  echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
}

# ── Load platform-specific supervisor ──

case "$(uname -s)" in
  Darwin)
    # shellcheck source=supervisor-macos.sh
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    ;;
  *)
    echo "This trimmed repo only supports macOS launchd."
    exit 1
    ;;
esac

# ── Commands ──

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_built

    # Check if already running (supervisor-aware: launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      EXISTING_PID=$(read_runtime_pid)
      echo "Bridge already running${EXISTING_PID:+ (PID: $EXISTING_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
      exit 1
    fi

    # Load config.env without executing it as shell code.
    load_config_env "$CTI_HOME/config.env"

    clean_env
    echo "Starting bridge..."
    supervisor_start

    # Poll for up to 10 seconds waiting for status.json to report running
    STARTED=false
    for _ in $(seq 1 10); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      # If supervisor process already died, stop waiting
      if ! supervisor_is_running; then
        break
      fi
    done

    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_runtime_pid)
      echo "Bridge started${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  stop)
    if supervisor_is_managed; then
      echo "Stopping bridge..."
      supervisor_stop
      write_stopped_status "stopped by daemon.sh"
      echo "Bridge stopped"
    else
      PID=$(read_runtime_pid)
      if [ -z "$PID" ]; then echo "No bridge running"; exit 0; fi
      if pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
        echo "Bridge stopped"
      else
        echo "Bridge was not running (stale PID file)"
      fi
      rm -f "$PID_FILE"
      write_stopped_status "stopped by daemon.sh"
    fi
    ;;

  status)
    # Platform-specific status info (prints launchd/service state)
    supervisor_status_extra

    # Process status: supervisor-aware (launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      PID=$(read_runtime_pid)
      echo "Bridge process is running${PID:+ (PID: $PID)}"
      # Business status from status.json
      if status_running; then
        echo "Bridge status: running"
      else
        echo "Bridge status: process alive but status.json not reporting running"
      fi
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Bridge is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
      show_last_exit_reason
    fi
    ;;

  logs)
    N="${2:-50}"
    # Mask credentials before printing. Pipes through perl (always installed
    # on macOS) instead of sed because BSD sed does not support \s and the
    # /gi flag is unreliable. Patterns mirror src/logger.ts:MASK_PATTERNS:
    #   1) token/secret/password/api_key = VALUE  (any quoting)
    #   2) Telegram bot tokens (bot<digits>:<35 chars>)
    #   3) Bearer <token>
    tail -n "$N" "$LOG_FILE" 2>/dev/null | perl -pe '
      s/(?i)(token|secret|password|api_key)(["\047]?\s*[:=]\s*["\047]?)[^\s"\047,]+/$1$2*****/g;
      s/bot\d+:[A-Za-z0-9_-]{35}/bot*****REDACTED/g;
      s/Bearer\s+[A-Za-z0-9._-]+/Bearer *****/g;
    '
    ;;

  *)
    echo "Usage: daemon.sh {start|stop|status|logs [N]}"
    ;;
esac
