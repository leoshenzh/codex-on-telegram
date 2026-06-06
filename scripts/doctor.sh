#!/usr/bin/env bash
set -euo pipefail

CANONICAL_CTI_HOME="$HOME/.claude-to-im"
CTI_HOME="${CTI_HOME:-$CANONICAL_CTI_HOME}"
CONFIG_FILE="$CTI_HOME/config.env"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck source=config-env.sh
source "$SKILL_DIR/scripts/config-env.sh"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

read_status_pid() {
  [ -f "$STATUS_FILE" ] || { echo ""; return 0; }
  node -e 'try { const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (s && s.pid) process.stdout.write(String(s.pid)); } catch {}' "$STATUS_FILE" 2>/dev/null || true
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
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

current_run_error_count() {
  node - "$STATUS_FILE" "$LOG_FILE" <<'NODE'
const fs = require('node:fs');

const statusPath = process.argv[2];
const logPath = process.argv[3];

let startedAt = null;
try {
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
  if (status && status.running === true && typeof status.startedAt === 'string') {
    startedAt = status.startedAt;
  }
} catch {
  // ignore malformed or missing status
}

if (!fs.existsSync(logPath)) {
  console.log(0);
  process.exit(0);
}

const lines = fs.readFileSync(logPath, 'utf-8')
  .split('\n')
  .filter(Boolean);

if (!startedAt) {
  console.log(0);
  process.exit(0);
}

const count = lines.filter((line) => {
  const match = line.match(/^\[([^\]]+)\]/);
  if (!match || match[1] < startedAt) {
    return false;
  }
  return /\[(ERROR|FATAL)\]/i.test(line);
}).length;

console.log(count);
NODE
}

runtime_state_clean() {
  node - "$CTI_HOME/data/sessions.json" "$CTI_HOME/data/bindings.json" <<'NODE'
const fs = require('node:fs');

const markers = [
  /d567d2b4-cbb4-4e2f-b0a2-6f8b0297a1e7/,
  /sdk-123/,
  /"chatId"\s*:\s*"tg-1"/,
  /"display_name"\s*:\s*"test"/,
];

for (const filePath of process.argv.slice(2)) {
  if (!fs.existsSync(filePath)) continue;
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (markers.some((marker) => marker.test(raw))) {
    process.exit(1);
  }
}
NODE
}

claude_runtime_ok() {
  cd "$SKILL_DIR" && node --import tsx --input-type=module - <<'NODE'
import { preflightCheck, resolveClaudeCliPath } from './src/llm-provider.ts';

const cliPath = resolveClaudeCliPath();
if (!cliPath) {
  process.exit(1);
}

const check = preflightCheck(cliPath);
if (!check.ok) {
  process.exit(1);
}
NODE
}

codex_runtime_ok() {
  cd "$SKILL_DIR" && node --import tsx --input-type=module - <<'NODE'
import { preflightCodexProvider } from './src/codex-provider.ts';

try {
  await preflightCodexProvider();
} catch {
  process.exit(1);
}
NODE
}

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20" 0
  else
    check "Node.js >= 20" 1
  fi
else
  check "Node.js installed" 1
fi

if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
  load_config_env "$CONFIG_FILE"
else
  check "config.env exists" 1
fi

CTI_RUNTIME=$(get_config_value "$CONFIG_FILE" CTI_RUNTIME)
CTI_RUNTIME="${CTI_RUNTIME:-claude}"
CTI_CHANNELS=$(get_config_value "$CONFIG_FILE" CTI_ENABLED_CHANNELS)
CTI_TG_BOT_TOKEN=$(get_config_value "$CONFIG_FILE" CTI_TG_BOT_TOKEN)

if [ -z "$CTI_CHANNELS" ]; then
  CTI_CHANNELS="telegram"
fi

case ",$CTI_CHANNELS," in
  *,telegram,*)
    check "Telegram channel config" 0
    ;;
  *)
    check "Telegram channel config" 1
    ;;
esac

case ",$CTI_CHANNELS," in
  *,telegram,*)
    if [ -n "$CTI_TG_BOT_TOKEN" ]; then
      check "Telegram bot token configured" 0
    else
      check "Telegram bot token configured" 1
    fi
    ;;
  *)
    check "Telegram bot token configured (telegram disabled)" 0
    ;;
esac

if [ "$CTI_RUNTIME" = "claude" ]; then
  if claude_runtime_ok; then
    check "Claude runtime preflight" 0
  else
    check "Claude runtime preflight" 1
  fi
fi

if [ "$CTI_RUNTIME" = "codex" ]; then
  if codex_runtime_ok; then
    check "Codex runtime preflight" 0
  else
    check "Codex runtime preflight" 1
  fi
fi

if [ "$CTI_RUNTIME" = "auto" ]; then
  if claude_runtime_ok; then
    check "Claude runtime preflight" 0
  else
    echo "Claude runtime preflight failed; checking Codex fallback."
    if codex_runtime_ok; then
      check "Codex runtime preflight (auto fallback)" 0
    else
      check "Codex runtime preflight (auto fallback)" 1
    fi
  fi
fi

if [ -f "$SKILL_DIR/dist/daemon.mjs" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' ! -path '*/__tests__/*' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
  STALE_LIB_DIST=$(find "$SKILL_DIR/lib/dist" -type f -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
  if [ -z "$STALE_SRC" ] && [ -z "$STALE_LIB_DIST" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is up to date" 1
  fi
else
  check "dist/daemon.mjs exists" 1
fi

if [ -d "$CTI_HOME/logs" ] && [ -w "$CTI_HOME/logs" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable" 1
fi

if runtime_state_clean; then
  check "Runtime data not test-contaminated" 0
else
  check "Runtime data not test-contaminated" 1
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if pid_alive "$PID"; then
    check "PID file consistent" 0
  else
    check "PID file consistent" 1
  fi
else
  STATUS_PID=$(read_status_pid)
  if status_running && pid_alive "$STATUS_PID"; then
    check "Status PID consistent (bridge.pid missing)" 0
  elif status_running; then
    check "Status PID consistent (bridge.pid missing)" 1
  else
    check "PID file consistency (no PID file)" 0
  fi
fi

if [ -f "$LOG_FILE" ]; then
  ERROR_COUNT=$(current_run_error_count)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No current-run errors in log" 0
  else
    check "No current-run errors in log" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  1. Build again: cd $SKILL_DIR && npm run build"
  echo "  2. Check Telegram config in $CONFIG_FILE"
  echo "  3. Restart daemon: bash $SKILL_DIR/scripts/daemon.sh stop && bash $SKILL_DIR/scripts/daemon.sh start"
  exit 1
fi
