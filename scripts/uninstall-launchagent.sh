#!/bin/bash
# Stop and remove the LaunchAgent. Keeps local state/logs unless --purge is given.
#
#   scripts/uninstall-launchagent.sh          # stop + remove plist
#   scripts/uninstall-launchagent.sh --purge  # also delete state (checkpoint, config.env) and logs
set -euo pipefail
LABEL="com.marat.imessage-sender"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="${IMESSAGE_STATE_DIR:-$HOME/Library/Application Support/imessage-sender}"
LOG_DIR="${IMESSAGE_LOG_DIR:-$HOME/Library/Logs/imessage-sender}"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null && echo "stopped $LABEL" || echo "$LABEL was not loaded"
if [[ -f "$PLIST" ]]; then rm -f "$PLIST"; echo "removed $PLIST"; fi

if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "$STATE_DIR" "$LOG_DIR"
  echo "removed $STATE_DIR and $LOG_DIR"
else
  echo "kept state in $STATE_DIR and logs in $LOG_DIR (use --purge to delete them)"
fi
echo
echo "Remaining manual step if you want a full uninstall: remove the node binary from"
echo "System Settings → Privacy & Security → Full Disk Access, and delete the repo directory."
