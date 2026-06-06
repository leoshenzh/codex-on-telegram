#!/usr/bin/env bash
# macOS supervisor — launchd-based process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

LABEL_HASH="$(printf '%s' "$SKILL_DIR" | shasum -a 256 | cut -c1-12)"
LAUNCHD_LABEL="com.claude-to-im.bridge.${LABEL_HASH}"
LEGACY_LAUNCHD_LABEL="com.claude-to-im.bridge"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/$LAUNCHD_LABEL.plist"

# ── launchd helpers ──

# Escape XML text nodes for launchd plist output.
xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf '%s' "$value"
}

append_plist_env_entry() {
  local indent="$1"
  local name="$2"
  local val="$3"
  local escaped_name escaped_val
  escaped_name="$(xml_escape "$name")"
  escaped_val="$(xml_escape "$val")"
  printf '%s<key>%s</key>\n%s<string>%s</string>\n' "$indent" "$escaped_name" "$indent" "$escaped_val"
}

# Collect env vars that should be forwarded into the plist.
# Secrets (CTI_*, ANTHROPIC_*, OPENAI_API_KEY, CODEX_API_KEY, CTI_CODEX_*) are
# intentionally NOT forwarded. The daemon reads them at runtime from
# $CTI_HOME/config.env (mode 0600) via loadConfig(). Keeping them out of the
# plist closes a real token-leakage surface — launchd plists in
# ~/Library/LaunchAgents are world-readable by default.
build_env_dict() {
  local indent="            "
  local dict=""

  for var in HOME PATH USER SHELL LANG TMPDIR CTI_HOME; do
    local val="${!var:-}"
    [ -z "$val" ] && continue
    dict+="$(append_plist_env_entry "$indent" "$var" "$val")"
  done

  printf '%s' "$dict"
}

generate_plist() {
  local node_path
  node_path=$(command -v node)

  mkdir -p "$PLIST_DIR"
  local env_dict
  env_dict=$(build_env_dict)

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${node_path}</string>
        <string>${SKILL_DIR}/dist/daemon.mjs</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>

    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
${env_dict}    </dict>
</dict>
</plist>
PLIST
  chmod 600 "$PLIST_FILE"
}

# ── Public interface (called by daemon.sh) ──

supervisor_start() {
  if [ "$LEGACY_LAUNCHD_LABEL" != "$LAUNCHD_LABEL" ]; then
    launchctl bootout "gui/$(id -u)/$LEGACY_LAUNCHD_LABEL" 2>/dev/null || true
    rm -f "$PLIST_DIR/$LEGACY_LAUNCHD_LABEL.plist"
  fi
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  generate_plist
  launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

supervisor_stop() {
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" &>/dev/null
}

supervisor_status_extra() {
  if supervisor_is_managed; then
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    # Extract PID from launchctl as the authoritative source
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      echo "launchd reports PID: $lc_pid"
    fi
  fi
}

read_status_pid_for_supervisor() {
  [ -f "$STATUS_FILE" ] || { echo ""; return 0; }
  node -e 'try { const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); if (s && s.pid) process.stdout.write(String(s.pid)); } catch {}' "$STATUS_FILE" 2>/dev/null || true
}

# Override: on macOS, check launchctl first, then fall back to PID file
supervisor_is_running() {
  # Primary: launchctl knows the process
  if supervisor_is_managed; then
    local lc_pid
    lc_pid=$(launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null | grep -m1 'pid = ' | sed 's/.*pid = //' | tr -d ' ')
    if [ -n "$lc_pid" ] && [ "$lc_pid" != "0" ] && [ "$lc_pid" != "-" ]; then
      return 0
    fi
  fi
  # Fallback: PID file
  local pid
  pid=$(read_pid)
  if pid_alive "$pid"; then
    return 0
  fi

  # Fallback: status.json is written atomically by the daemon and can repair a
  # missing/stale bridge.pid after rebuilds or interrupted shell commands.
  pid=$(read_status_pid_for_supervisor)
  pid_alive "$pid"
}
