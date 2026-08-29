#!/bin/bash
# Health / status overview: launchd state, checkpoint, recent log events.
set -uo pipefail
LABEL="com.marat.imessage-sender"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${IMESSAGE_STATE_DIR:-$HOME/Library/Application Support/imessage-sender}"
LOG_DIR="${IMESSAGE_LOG_DIR:-$HOME/Library/Logs/imessage-sender}"
UID_NUM="$(id -u)"

echo "== launchd"
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  launchctl print "gui/$UID_NUM/$LABEL" | grep -E "state =|pid =|last exit code|runs =" | sed 's/^/  /'
else
  echo "  not loaded"
fi

echo "== checkpoint"
NODE_BIN="$(plutil -extract ProgramArguments.0 raw -o - "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || command -v node)"
if [[ -n "$NODE_BIN" && -f "$REPO_DIR/dist/src/index.js" ]]; then
  "$NODE_BIN" --disable-warning=ExperimentalWarning "$REPO_DIR/dist/src/index.js" status --env-file "$STATE_DIR/config.env" 2>&1 | sed 's/^/  /'
else
  echo "  (build missing or node not found)"
fi

echo "== last 15 log events"
if [[ -f "$LOG_DIR/imessage-sender.log" ]]; then
  tail -n 15 "$LOG_DIR/imessage-sender.log" | sed 's/^/  /'
else
  echo "  no log yet at $LOG_DIR/imessage-sender.log"
fi
if [[ -s "$LOG_DIR/launchd-stderr.log" ]]; then
  echo "== launchd stderr (tail)"
  tail -n 5 "$LOG_DIR/launchd-stderr.log" | sed 's/^/  /'
fi
