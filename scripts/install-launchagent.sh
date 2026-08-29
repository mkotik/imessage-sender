#!/bin/bash
# Install (or reinstall) the imessage-sender LaunchAgent for the current user. No root needed.
#
#   scripts/install-launchagent.sh            # build, verify, install, start
#   scripts/install-launchagent.sh --no-start # install but do not start
#
# What it does:
#   1. resolves the absolute node binary (launchd does not load your shell profile / nvm)
#   2. checks node >= 22.13
#   3. builds the project (npm ci + npm run build) if dist/ is missing
#   4. copies .env → ~/Library/Application Support/imessage-sender/config.env (mode 600) if not present
#   5. runs `doctor` to confirm Full Disk Access / schema before anything is scheduled
#   6. renders launchd/com.marat.imessage-sender.plist.template → ~/Library/LaunchAgents/
#   7. bootstraps the agent with launchctl
set -euo pipefail

LABEL="com.marat.imessage-sender"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${IMESSAGE_STATE_DIR:-$HOME/Library/Application Support/imessage-sender}"
LOG_DIR="${IMESSAGE_LOG_DIR:-$HOME/Library/Logs/imessage-sender}"
ENV_FILE="$STATE_DIR/config.env"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$REPO_DIR/launchd/$LABEL.plist.template"
START=1
[[ "${1:-}" == "--no-start" ]] && START=0

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "this installer is for macOS"

# 1. node
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || die "node not found in PATH. Install Node 22+ (e.g. 'nvm install 22') or set NODE_BIN=/path/to/node"
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
# resolve symlinks (homebrew) so the FDA grant targets the real binary
if command -v realpath >/dev/null 2>&1; then NODE_BIN="$(realpath "$NODE_BIN")"; fi
NODE_VER="$("$NODE_BIN" -p 'process.versions.node')"
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "node $NODE_VER is too old; need >= 22.13 (node:sqlite). Try: nvm install 22 && nvm use 22"
say "node $NODE_VER at $NODE_BIN"

# 2. build
cd "$REPO_DIR"
if [[ ! -f dist/src/index.js ]]; then
  say "building"
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  npm run build
fi

# 3. config
mkdir -p "$STATE_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE_DIR" "$LOG_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$REPO_DIR/.env" ]]; then
    cp "$REPO_DIR/.env" "$ENV_FILE"
    say "copied .env → $ENV_FILE"
  else
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
    say "created $ENV_FILE from .env.example — EDIT IT (IMESSAGE_INGEST_URL, token) before starting"
  fi
fi
chmod 600 "$ENV_FILE"

# 4. doctor (read-only)
say "running doctor"
if ! "$NODE_BIN" --disable-warning=ExperimentalWarning dist/src/index.js doctor --env-file "$ENV_FILE"; then
  cat <<EOF

Doctor reported problems. The most common one is Full Disk Access:
  System Settings → Privacy & Security → Full Disk Access → "+" → press ⌘⇧G and paste:
    $NODE_BIN
  then re-run this installer. (Grant it to the node binary itself, not Terminal.)
EOF
  exit 1
fi

# 5. render plist
say "installing $PLIST_DST"
sed -e "s|__LABEL__|$LABEL|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__ENV_FILE__|$ENV_FILE|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$TEMPLATE" > "$PLIST_DST"
plutil -lint "$PLIST_DST" >/dev/null

# 6. (re)load
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
if [[ $START -eq 1 ]]; then
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
  launchctl kickstart -k "gui/$UID_NUM/$LABEL"
  sleep 2
  if launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -q "state = running"; then
    say "running. status: scripts/status.sh   logs: $LOG_DIR/imessage-sender.log"
  else
    say "agent loaded but not running yet — check $LOG_DIR/launchd-stderr.log"
  fi
else
  say "installed (not started). Start with: launchctl bootstrap gui/$UID_NUM $PLIST_DST"
fi
