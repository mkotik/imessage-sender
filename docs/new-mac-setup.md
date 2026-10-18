# Setting up imessage-sender on a new Mac

Prerequisites: the Mac is signed into your iCloud account with **Messages in iCloud** enabled
(so `~/Library/Messages/chat.db` fills up), `nvm` and `gh` (or an SSH key for GitHub) are
installed, and you have the four receiver credentials from the VPS
(`/etc/imessage-server/secrets.env` and `~/mac-sender-credentials.txt` there).

## 1. Node 22

```bash
nvm install 22 && nvm use 22 && nvm alias default 22
```

## 2. Clone and build

```bash
git clone git@github.com:mkotik/imessage-sender.git ~/Documents/Code/imessage-sender
cd ~/Documents/Code/imessage-sender
npm ci && npm run build
```

## 3. Configure

```bash
cp .env.example .env.local && chmod 600 .env.local
```

Edit `.env.local` and set:

```env
IMESSAGE_INGEST_URL=https://imessage-ingest.example.com
IMESSAGE_INGEST_TOKEN=<from secrets.env on the VPS>
IMESSAGE_CF_ACCESS_CLIENT_ID=<from mac-sender-credentials.txt>     # 39 chars, ends in .access
IMESSAGE_CF_ACCESS_CLIENT_SECRET=<from mac-sender-credentials.txt> # exactly 64 hex chars
IMESSAGE_DRY_RUN=false
```

Quick check the secret pasted cleanly:

```bash
awk -F= '/CLIENT_SECRET/{print length($2)}' .env.local   # must print 64
```

## 4. Full Disk Access

System Settings → Privacy & Security → **Full Disk Access**, then:

1. Toggle on **Terminal** (needed for the manual commands below). Quit and reopen Terminal.
2. Click **+**, press ⌘⇧G, paste the output of `node -p process.execPath`
   (e.g. `/Users/you/.nvm/versions/node/v22.x.y/bin/node`) → Open. This is what the
   LaunchAgent runs as.

No other permissions are needed (no Contacts prompt, no root).

## 5. Verify

```bash
npm run doctor        # expect "All checks passed." with a contacts count
npm run -s dry-run    # optional rehearsal: parses the whole history, sends nothing
```

## 6. Install the LaunchAgent

```bash
scripts/install-launchagent.sh
scripts/status.sh
```

The installer copies `.env.local` to `~/Library/Application Support/imessage-sender/config.env`,
re-runs `doctor`, renders `~/Library/LaunchAgents/com.marat.imessage-sender.plist` with the
absolute node path, and starts it. It runs at login, stays running, and restarts itself if it dies.

The first run backfills the full local history (messages: a few minutes; attachments: bounded by
upload bandwidth, ~7 GB ≈ 20–60 min). A new Mac starts from ROWID 0 — that's safe, the receiver
dedupes on `messageGuid` and skips attachments it already has. Watch progress with
`scripts/status.sh` or `tail -f ~/Library/Logs/imessage-sender/imessage-sender.log`.

## 7. Retire the old Mac

Only one Mac should run the sender. On the old machine:

```bash
cd ~/Documents/Code/imessage-sender && scripts/uninstall-launchagent.sh --purge
```

and remove its node binary from Full Disk Access. Never copy `state.json` between Macs —
ROWIDs are per-database.

## Day-to-day

| Task | Command |
|---|---|
| status / health | `scripts/status.sh` |
| stop | `launchctl bootout gui/$(id -u)/com.marat.imessage-sender` |
| start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.marat.imessage-sender.plist` |
| restart | `launchctl kickstart -k gui/$(id -u)/com.marat.imessage-sender` |
| after changing config.env | restart (above) |
| after `nvm install` of a newer Node | re-run `scripts/install-launchagent.sh`, re-grant FDA to the new binary |
| logs | `~/Library/Logs/imessage-sender/` |
| service-token rotation | ~Aug 2027 (calendar reminder set) — update `config.env`, restart |
