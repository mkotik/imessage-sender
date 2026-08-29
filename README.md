# imessage-sender

A small, privacy-first macOS background service that reads the local Apple Messages database,
normalises every iMessage/SMS (with contact names and attachment metadata), **filters out
one-time codes before anything leaves the Mac**, and streams the result to a remote HTTPS
ingestion receiver — first the full history, then continuously as new messages arrive.

It is the Mac half of a personal-data pipeline for AI agents:

```
Mac Messages database (read-only)
  → imessage-sender (this repo)              ← OTPs filtered here, never transmitted
  → HTTPS
  → VPS ingestion service                    ← separate project, not built yet
  → encrypted message database (SQLCipher)
  → iDrive E2 for encrypted attachments
  → dedicated iMessage MCP
  → Claude / ChatGPT / Cursor / other agents
```

Only the first arrow is implemented here. The receiver contract it speaks is fully specified in
[`docs/receiver-api.md`](docs/receiver-api.md) so the VPS side can be built against it.

- Zero runtime dependencies (Node ≥ 22.13 built-ins only: `node:sqlite`, `fetch`, `node:crypto`).
- Apple's database is opened with SQLite's read-only flag and never written, migrated or checkpointed.
- Resumable, receiver-acknowledged checkpointing; no local copy of your messages is ever kept.
- 255 automated tests, including 150 for the OTP detector alone.

---

## Contents

1. [Architecture](#architecture)
2. [Privacy model](#privacy-model)
3. [OTP filtering](#otp-filtering)
4. [How Messages data is accessed](#how-messages-data-is-accessed)
5. [Required macOS permissions](#required-macos-permissions)
6. [Installation](#installation)
7. [Configuration](#configuration)
8. [LaunchAgent](#launchagent)
9. [Initial backfill](#initial-backfill)
10. [Incremental syncing](#incremental-syncing)
11. [Development](#development)
12. [Receiver API contract](#receiver-api-contract)
13. [Troubleshooting](#troubleshooting)
14. [Security considerations](#security-considerations)
15. [Complete uninstall](#complete-uninstall)

---

## Architecture

```
src/
  index.ts              CLI: run | once | dry-run | doctor | status | otp-check | reset-state
  service.ts            wires everything together; the forever loop
  config.ts             env-driven configuration (https enforced, secrets never logged)
  messages/
    db.ts               read-only node:sqlite handle on chat.db, schema validation
    queries.ts          every SELECT we run (adapts to optional columns)
    parser.ts           attributedBody (typedstream) → text
    normalize.ts        Apple row → NormalizedMessage (docs/receiver-api.md)
    types.ts            raw row shapes
  contacts/
    phone.ts            phone/email normalisation
    resolver.ts         AddressBook SQLite store → handle → display name (read-only, cached)
  privacy/
    otp-filter.ts       the OTP / auth-code detector (pure, heavily tested)
    redact.ts           masking for logs
  attachments/
    reader.ts           locate, stat, classify, hash and stream attachment files
  sync/
    checkpoint.ts       durable state (~/Library/Application Support/imessage-sender/state.json)
    engine.ts           the single batch pipeline: query → normalise → filter → send → ack → commit
    backfill.ts         walk history from checkpoint to the ROWID present at start
    incremental.ts      poll for new rows, edits, and pending attachment uploads
  transport/
    types.ts            wire types + ReceiverTransport interface
    client.ts           HTTPS implementation (fetch, no redirects, bearer and/or CF Access headers)
  logging/logger.ts     structured JSON logger that refuses content-like fields
  util/                 atomic writes, backoff, Apple time, .env parsing
tools/
  synthetic.ts          fabricates a chat.db with the real schema (tests & local runs)
  mock-receiver.ts      in-memory receiver implementing the contract, with fault injection
launchd/                LaunchAgent plist template
scripts/                install / uninstall / status
docs/                   findings.md (this Mac's real schema), architecture.md, receiver-api.md
tests/                  node:test suites
```

The long version, including the cursor/checkpoint model and failure matrix, is in
[`docs/architecture.md`](docs/architecture.md). What was actually found on this Mac (schema,
column usage, attachment layout) is in [`docs/findings.md`](docs/findings.md).

## Privacy model

| Data | Where it goes |
|---|---|
| Message text | To the configured receiver only, over HTTPS, after the OTP filter. Never to disk, never to logs. |
| OTP / auth-code messages | Dropped on the Mac. Not transmitted, not logged (only counted), not queued, not persisted. |
| Attachments | Streamed to the receiver (`PUT`) after their message batch is acknowledged. Metadata (name, type, size, sha256) travels with the message. Never copied locally. |
| Contact names | Resolved from the local AddressBook store at send time and included in payloads. Not cached to disk. |
| Local state | `state.json`: device id, last acknowledged ROWID, edit-scan cursor, a list of pending attachment *identifiers*, counters. Mode 0600. |
| Logs | Structured JSON: event names, counts, ROWID ranges, batch ids, HTTP status codes, masked handles. The logger drops any field named `text`, `body`, `token`, … by construction. |
| Secrets | Read from `config.env` (mode 0600) or the environment. Never written anywhere else. |

The sender opens exactly one outbound destination (`IMESSAGE_INGEST_URL`), refuses redirects,
and requires `https://` unless you explicitly opt into plain HTTP for a local mock.

## OTP filtering

`src/privacy/otp-filter.ts` is a pure function `checkOtp({ text, subject, senderHandle, … })
→ { filtered, reasons }`. It runs on every normalised message before it is added to a batch.
It is deliberately biased toward false positives: losing "the gate code is 4471" is acceptable;
leaking "your bank code is 4471" is not.

Any of these withholds the message:

1. **Sender** is a numeric short code (3–8 digits) or an alphanumeric SMS sender id (`AMAZON`,
   `VERIFY`), or is on your `IMESSAGE_BLOCKED_HANDLES` list (also applies to your replies in that
   conversation).
2. **Strong phrases** — verification/security/authentication/login/sign-in/access/confirmation
   code, one-time password/passcode, OTP, 2FA, MFA, two-factor, passcode, "do not share this
   code", "your … code is", "enter/use this code", "code to verify/log in", "reset your
   password", "magic link", "login attempt", plus vendor names near "code" (Apple, Google,
   Microsoft, WhatsApp, Uber, Venmo, PayPal, Chase, …) and the same wording in Spanish, French,
   German, Italian, Portuguese, Russian, Japanese, Chinese and Korean.
3. **PIN in an authentication context** ("your PIN is", "enter PIN", "temporary PIN"), but not
   "bowling pin" or "pin the message".
4. **Known templates** — Android `<#>` SMS-retriever prefix, Google `G-123456`, "Use 123456 as…",
   "123-456 is your…", "expires in 10 minutes", trailing `@domain #123456` hashes.
5. **A code token plus weak context** — a 4–8 digit (or letter+digit) token together with words
   like verify, confirm, login, account, security, password, expires, valid, request. Times
   (10:30), money ($1,200), percentages, distances and bare years are excluded unless code words
   are present.
6. **Auth-bearing links** — URLs with `?code=`, `?token=`, `?otp=`, `/verify/`, `/magic-link`,
   `/reset-password`, ….
7. **Bare codes** — the whole message is a 4–8 digit or alphanumeric code (someone forwarding one).

Reactions quoting a filtered message ("Liked ‘Your code is …’") are caught by the same rules.
Try it interactively:

```bash
printf 'Your Uber code is 4412\nsee you at 7\n' | npm run -s otp-check
```

Tests: `tests/otp-filter.test.ts` (must-filter corpus, must-allow corpus, sender rules, edge
cases). The mock receiver also runs an independent leak scan on everything it receives and the
end-to-end tests assert it finds nothing.

## How Messages data is accessed

- `~/Library/Messages/chat.db` is opened with `node:sqlite`'s `readOnly: true`. SQLite itself
  refuses writes on such a connection (verified: `attempt to write a readonly database`).
  `PRAGMA query_only = 1` is set as a second guard. No `journal_mode`, checkpoint, `VACUUM`,
  DDL or DML is ever issued; the WAL is read the way any concurrent reader reads it.
- Message text lives in the `attributedBody` blob (the `text` column is NULL on 99.9 % of rows on
  this Mac). The blob is a NeXT typedstream; the decoder extracts the `NSString` payload and
  falls back to `text` if anything looks unexpected (flagging `bodyDecodeFailed`).
- Timestamps are nanoseconds since 2001-01-01 and exceed 2^53, so statements read BigInts.
- Attachments are located from `attachment.filename` (with `~` expanded) and only ever opened if
  the resolved path is inside `IMESSAGE_ATTACHMENTS_DIR`. Missing files, transient
  `/var/folders/…` transcodes, hidden link-preview payloads and oversize files are reported as
  metadata only.
- Contacts come from `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` and every
  `Sources/*/AddressBook-v22.abcddb`, opened read-only; the schema is validated at runtime and the
  service degrades to raw handles if it does not match.

`imessage-sender doctor` prints all of this (counts only, no content) for the current machine.

## Required macOS permissions

| Permission | Needed for | Grant to |
|---|---|---|
| **Full Disk Access** | reading `chat.db`, `Attachments/`, and the AddressBook store | the **node binary** that launchd runs — the installer prints its absolute path (e.g. `~/.nvm/versions/node/v22.x.y/bin/node`) |
| Contacts | not needed (the AddressBook store is readable under Full Disk Access) | — |
| Automation / Accessibility / Screen Recording | not needed | — |
| Root / sudo | not needed | — |

Steps: System Settings → Privacy & Security → Full Disk Access → **+** → press ⌘⇧G → paste the
node path → Open → make sure the toggle is on. If you upgrade Node to a new version directory the
grant must be repeated for the new binary (the installer will tell you via `doctor`).

## Installation

Requirements: macOS 13+ (developed on 14.8.3 / Apple Silicon), Node ≥ 22.13
(`nvm install 22 && nvm use 22`), git.

```bash
git clone git@github.com:<you>/imessage-sender.git ~/code/imessage-sender
cd ~/code/imessage-sender
npm install
npm run build
npm test                                # 255 tests, synthetic data only

cp .env.example .env.local              # fill in IMESSAGE_INGEST_URL and the token(s)
npm run doctor                          # read-only checks: permissions, schema, contacts, config
npm run -s dry-run                      # full parse + filter of your real history, nothing sent
scripts/install-launchagent.sh          # installs + starts the LaunchAgent
scripts/status.sh
```

`dry-run` is the recommended first real run: it walks the entire history through the parser and
the OTP filter with the network disabled, and reports counts. Nothing is transmitted. It keeps its
checkpoint in a separate `dry-run/` state subdirectory, so it never affects the real backfill.

> Until the VPS receiver exists, point `IMESSAGE_INGEST_URL` at the local mock
> (`npm run mock-receiver -- --token devtoken`, then `IMESSAGE_INGEST_URL=http://127.0.0.1:8787`
> with `IMESSAGE_ALLOW_INSECURE_HTTP=true`) or keep `IMESSAGE_DRY_RUN=true`.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the full list with
defaults. Precedence: real environment → `--env-file <path>` → `./.env.local` → `./.env` →
`~/Library/Application Support/imessage-sender/config.env`.

| Variable | Purpose |
|---|---|
| `IMESSAGE_INGEST_URL` | receiver base URL, `https://` required |
| `IMESSAGE_INGEST_TOKEN` | bearer token (optional) |
| `IMESSAGE_CF_ACCESS_CLIENT_ID` / `_SECRET` | Cloudflare Access service token (optional; both or neither) |
| `IMESSAGE_DRY_RUN` | `true` → never open a network connection |
| `IMESSAGE_BATCH_SIZE` | messages per batch (default 200) |
| `IMESSAGE_POLL_INTERVAL_SECONDS` | incremental poll (default 30) |
| `IMESSAGE_MAX_ATTACHMENT_BYTES` | larger files send metadata only (default 100 MB) |
| `IMESSAGE_UPLOAD_HIDDEN_ATTACHMENTS` | link-preview payloads (default false) |
| `IMESSAGE_BLOCKED_HANDLES` | comma-separated handles that never sync |
| `IMESSAGE_FILTER_SHORTCODE_SENDERS` | drop everything from short-code senders (default true) |
| `IMESSAGE_LOG_LEVEL` | debug / info / warn / error |

## LaunchAgent

`scripts/install-launchagent.sh` renders `launchd/com.marat.imessage-sender.plist.template` with
the absolute node path, repo path and env-file path, installs it to
`~/Library/LaunchAgents/com.marat.imessage-sender.plist`, and bootstraps it into your user
session. It runs at login, is kept alive by launchd (restart throttled to 30 s), runs at
background priority with low I/O priority, and needs no root.

| Action | Command |
|---|---|
| install / reinstall / start | `scripts/install-launchagent.sh` |
| status | `scripts/status.sh` or `npm run status` |
| stop | `launchctl bootout gui/$(id -u)/com.marat.imessage-sender` |
| start | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.marat.imessage-sender.plist` |
| restart | `launchctl kickstart -k gui/$(id -u)/com.marat.imessage-sender` |
| uninstall | `scripts/uninstall-launchagent.sh` (`--purge` also removes state + logs) |

Logs: `~/Library/Logs/imessage-sender/imessage-sender.log` (JSON lines, rotated at 20 MB),
plus `launchd-stdout.log` / `launchd-stderr.log` in the same directory.
State: `~/Library/Application Support/imessage-sender/state.json` and `config.env`.

## Initial backfill

On first run the service records the current max `message.ROWID` as the backfill target and
walks from ROWID 0 upward in batches of `IMESSAGE_BATCH_SIZE`:

```
query rows after checkpoint → decode + normalise → OTP filter (drop) → POST /v1/messages/batch
→ receiver acks → write state.json (checkpoint = last ROWID of the range, pending attachments)
→ PUT each attachment the receiver wants → repeat
```

The checkpoint moves **only** after the acknowledgement. Kill the process at any point and the
restart continues from the last acked batch; a batch that was acked but not yet checkpointed is
re-sent with the same deterministic `batchId` and the receiver deduplicates by `messageGuid`.
Filtered messages advance the checkpoint like any other row (their ROWIDs are inside the range)
without ever being serialised. `backfill_progress` log lines report the remaining count every
10 batches; `backfill_complete` marks the transition.

On this Mac: ~50k messages, ~5k attachments (6.9 GB). Expect the message part to take minutes and
the attachment part to be bounded by upload bandwidth.

## Incremental syncing

After backfill the loop sleeps `IMESSAGE_POLL_INTERVAL_SECONDS`, then checks the mtime/size of
`chat.db` and `chat.db-wal`. Only if they changed (or attachments are pending) does it query
`ROWID > checkpoint` and run the same pipeline with `phase: "incremental"`. It also re-sends rows
whose `date_edited` moved past the edit cursor (`phase: "revision"`, receiver upserts) and
retries pending attachment uploads with their own backoff. Idle cost is one `stat()` per poll.

Polling was chosen over FSEvents on purpose: it needs no native module, tolerates sleep/wake and
network changes trivially, and 30 s latency is fine for this use case.

## Development

```bash
npm run build         # tsc → dist/
npm test              # build + node --test (synthetic fixtures only; never touches ~/Library)
npm run synthetic-db -- --dir ./tmp/synthetic --count 2000   # fabricated chat.db + Attachments/
npm run mock-receiver -- --port 8787 --token devtoken [--fail-every 3] [--slow 500] [--drop]
```

Run the sender against the two:

```bash
IMESSAGE_INGEST_URL=http://127.0.0.1:8787 IMESSAGE_ALLOW_INSECURE_HTTP=true IMESSAGE_INGEST_TOKEN=devtoken \
IMESSAGE_CHAT_DB_PATH=./tmp/synthetic/chat.db IMESSAGE_ATTACHMENTS_DIR=./tmp/synthetic/Attachments \
IMESSAGE_STATE_DIR=./tmp/state IMESSAGE_LOG_DIR=./tmp/logs IMESSAGE_RESOLVE_CONTACTS=false \
node dist/src/index.js once
curl -s localhost:8787/__stats     # otpLikeTexts must be 0
```

Test suites: `otp-filter` (150 cases), `parser` (typedstream, time), `normalize` (rows →
payloads against a synthetic DB with the real DDL), `contacts` (phone normalisation, AddressBook
store, ambiguity), `attachments` (present/missing/temp/hidden/large/multiple, containment),
`checkpoint` (atomicity, corruption, permissions, config), `transport` (success, 4xx, 5xx,
timeout, dropped connection, nothing listening, redirects refused, CF Access headers),
`sync` (full backfill, injected 5xx/4xx, abort, crash-after-ack, crash-before-checkpoint,
DB-replaced guard, incremental, edits, attachment retry, log privacy).

## Receiver API contract

See [`docs/receiver-api.md`](docs/receiver-api.md). Summary:

- `POST /v1/messages/batch` — JSON `{ batchId, deviceId, phase, range, messages[] }`,
  `Idempotency-Key: <batchId>`. Reply `{ ok: true, attachments?: { wanted?: [guid] } }`.
  Dedupe/upsert on `messageGuid`.
- `PUT /v1/attachments/{attachmentGuid}` — raw bytes, `X-Attachment-Meta` (base64 JSON),
  `X-Content-Sha256`. `2xx` ok, `409` already stored, other `4xx` permanent, `5xx` retry.
- `HEAD /v1/attachments/{guid}` (optional) and `POST /v1/heartbeat` (optional).
- Auth: `Authorization: Bearer` and/or `CF-Access-Client-Id/Secret`.

Message and attachment bodies are separate on purpose: batches stay small and fast to ack, and
large files stream straight through the receiver into encrypted object storage.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `doctor` says "cannot open … Full Disk Access" or `EPERM` | Grant FDA to the exact node binary printed by the installer, then restart the agent. |
| `node:sqlite` not found / `ERR_UNKNOWN_BUILTIN_MODULE` | Node < 22.13. `nvm install 22`, re-run the installer (it rewrites the plist with the new path) and re-grant FDA. |
| Agent restarts every 30 s | `~/Library/Logs/imessage-sender/launchd-stderr.log` has the fatal error. Config errors and the "database replaced" guard exit on purpose. |
| `batch_send_failed` repeating with `kind: network` | receiver down / no internet / VPN. It keeps retrying with backoff up to 5 min; nothing is lost. |
| `batch_send_failed` with status 401/403 | token or CF Access credentials wrong/expired. Fix `config.env`, restart. |
| `batch_rejected` (4xx) | receiver refused the batch; it is retried every 5 min and never skipped. Check the receiver's logs with the `batchId`. |
| "chat.db max ROWID … below the checkpoint … replaced" | Messages was restored/re-synced and ROWIDs reset. Decide, then `imessage-sender reset-state --yes`. |
| Contacts show as raw numbers | `doctor` → Contacts section. AddressBook schema mismatch or store missing; sync continues without names. |
| An OTP-looking message you actually wanted | Adjust in `otp-filter.ts` with a test, or accept it — the bias is intentional. |
| Something that *is* an OTP got through | Please add it (fabricated wording) to `tests/otp-filter.test.ts` and tighten the detector. |
| Re-send everything | `imessage-sender reset-state --yes` (keeps the device id; receiver dedupes). |

`IMESSAGE_LOG_LEVEL=debug` adds per-batch filter reason counts and heartbeat failures — still no content.

## Security considerations

1. **Apple's DB is read-only** — enforced by SQLite's open flag, `query_only`, and the absence of
   any write statement in the code (`grep -rn "INSERT\|UPDATE\|DELETE" src/` finds nothing).
2. **OTPs never leave the Mac** — filtered before batching, counted only, defense in depth in the
   logger and a leak scanner in the mock receiver used by the tests.
3. **No secrets in git** — `.gitignore` excludes `.env*`, keys, state, logs, databases and media;
   `.env.example` has placeholders only.
4. **TLS** — `https://` enforced; HTTP only with an explicit override for the local mock.
5. **No inbound listener** — the sender only makes outbound requests.
6. **Minimal persistence** — one small state file; no message text on disk anywhere.
7. **No sensitive bodies in logs** — structured logger with forbidden-key filtering and masking.
8. **Fail safe** — undecodable bodies are flagged not guessed; uncertain filter → filtered.
9. **Acks drive checkpoints** — nothing is marked done until the receiver says so.
10. **Attachments are sensitive** — streamed only after their message was accepted, never copied,
    only from inside the Attachments directory (path containment check).
11. **Single destination** — one configured base URL, redirects refused.
12. **No third-party runtime code** — everything sensitive runs on Node built-ins.

Known residual risks: the OTP detector is heuristic (English-centric, though multilingual for the
common phrases); anyone with Full Disk Access on this Mac can already read the same data; the
receiver is trusted with plaintext in transit (TLS) and must encrypt at rest; the node binary
granted FDA must be kept from tampering (it lives in your user directory under nvm).

## Complete uninstall

```bash
cd ~/code/imessage-sender
scripts/uninstall-launchagent.sh --purge      # stops agent, removes plist, state, config.env, logs
cd ~ && rm -rf ~/code/imessage-sender          # remove the code
# System Settings → Privacy & Security → Full Disk Access → remove the node binary entry
```

Nothing else is written anywhere on the Mac. The receiver keeps whatever was already sent; wiping
that is the receiver project's job.
