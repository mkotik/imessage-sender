# Environment findings (inspected 2026-08-29)

Everything below was gathered read-only. The schema inspection ran against a scratch copy
of `chat.db` (+ `-wal`/`-shm`) inside a sandbox; the copy was discarded afterwards. No query
touched the live database in write mode and no message content was recorded — only
aggregate counts and shapes.

## Machine

| Item | Value |
|---|---|
| Host | MacBook Pro, Apple Silicon (arm64) |
| macOS | 14.8.3 (Sonoma), build 23J220 |
| Node on the Mac | v20.0.0 via nvm (`~/.nvm/versions/node/v20.0.0/bin/node`) — **too old**, see below |
| Messages DB | `~/Library/Messages/chat.db` — 80.8 MB, WAL journal (`chat.db-wal` ≈ 3.7 MB, `chat.db-shm` present) |
| Messages `_ClientVersion` | `17014` |
| Attachments dir | `~/Library/Messages/Attachments/` — 6.9 GB, layout `XX/YY/<UUID>/<file>` |
| Contacts DB | `~/Library/Application Support/AddressBook/AddressBook-v22.abcddb` (+ WAL) and per-account copies under `AddressBook/Sources/<UUID>/AddressBook-v22.abcddb` |

### Node version decision

Node 20 has no built-in SQLite driver; the only options would be a native module
(`better-sqlite3`, compiled C++ handling the most sensitive data on the machine) or upgrading Node.
Node ≥ 22.13 ships `node:sqlite` (bundled SQLite, no third-party code). Verified on 22.23:
`new DatabaseSync(path, { readOnly: true })` opens the WAL database, reads through the WAL
correctly, and any write attempt fails with `attempt to write a readonly database`.

**Decision:** require Node ≥ 22.13 and use `node:sqlite`. Zero runtime dependencies.
`nvm install 22` on the Mac. The LaunchAgent installer resolves the absolute node binary path
and writes it into the plist (launchd does not load nvm shell init).

## chat.db schema (relevant parts)

Tables present: `message`, `chat`, `handle`, `attachment`, `chat_message_join`,
`chat_handle_join`, `message_attachment_join`, `deleted_messages`, `kvtable`,
`recoverable_message_part`, `chat_recoverable_message_join`, `sync_deleted_*`,
`message_processing_task`, `_SqliteDatabaseProperties`. `PRAGMA user_version = 0`.

### `message` (columns we use)

`ROWID`, `guid` (36-char UUID, UNIQUE), `text`, `attributedBody` (BLOB), `handle_id`,
`other_handle`, `subject`, `service` (`iMessage` | `SMS`), `date`, `date_read`,
`date_delivered`, `date_edited`, `date_retracted`, `is_from_me`, `is_read`, `is_sent`,
`is_delivered`, `is_audio_message`, `item_type`, `group_action_type`, `group_title`,
`associated_message_guid`, `associated_message_type`, `balloon_bundle_id`,
`cache_has_attachments`, `reply_to_guid`, `thread_originator_guid`, `thread_originator_part`,
`is_spam`, `error`, `part_count`, `destination_caller_id`.

Sonoma-era columns confirmed present: `is_kt_verified`, `is_sos`, `is_critical`,
`bia_reference_id`, `fallback_hash`, `is_stewie`. Not used.

### Observed data shapes (aggregate only)

| Fact | Value |
|---|---|
| Messages | 50,142 rows, ROWID 1..50,201 (gaps exist — deletions) |
| Service | 49,983 iMessage, 159 SMS |
| `text` NULL | **50,108 of 50,142** — the `text` column is essentially unused on this OS |
| `attributedBody` NULL | 27 (these are item_type≠0 / system rows) |
| `attributedBody` decode | 50,115 / 50,115 decoded; 34 rows have both `text` and body and all 34 matched exactly |
| Bodies containing U+FFFC | 2,364 (object-replacement placeholder marking attachment position) |
| `date` magnitude | ~8.1e17 → **nanoseconds since 2001-01-01** (Apple Cocoa epoch) |
| ROWID vs date | 71 adjacent-ROWID pairs are out of date order → ROWID is the safe cursor, `date` is not |
| `item_type` | 0 = normal (50,126); 1,2,3,5,6 = group/system events (16 total) |
| `associated_message_type` | 0 normal; 2000–2005 tapback add (~1,516); 3001–3004 tapback remove; 1000 sticker/other (32) |
| `associated_message_guid` | prefixes `p:<part>/<GUID>` (1,525) and `bp:<GUID>` (27) |
| `date_edited > 0` | 241 (edited messages; edit history lives in `message_summary_info` plist) |
| `date_retracted > 0` | 0 |
| `reply_to_guid` set | 35,260 (this is NOT "reply thread"; Apple sets it broadly). `thread_originator_guid` set: 888 — that is the real inline-reply marker |
| `balloon_bundle_id` | 1,192 `URLBalloonProvider` (link previews), a few FindMy/Business/Photos/DigitalTouch/Handwriting |
| `handle_id = 0` | 1,104 rows — 1,102 of them `is_from_me = 1` (sender is me; 1:1 chat peer must come from the chat) |
| Every message joins exactly one chat | 0 orphans, 0 multi-chat |
| Deleted messages table | empty |

### `attributedBody` format

All 50,115 bodies start with `04 0b 73 74 72 65 61 6d 74 79 70 65 64 81 e8 03`
(`\x04\x0bstreamtyped`, NeXT typedstream v4). The string is an `NSString`/`NSMutableString`
object whose UTF-8 payload follows a `+` (0x2B) marker and a length prefix:
one byte for < 0x81, `0x81 <u16 LE>` for ≤ 0xFFFF, `0x82 <u32 LE>` above. A decoder that
locates `NSString`, then the first `+` after it, then reads the length-prefixed UTF-8 string,
decoded 100% of rows on this machine. The parser falls back to the `text` column when the body
is absent or malformed, and marks `bodyDecodeFailed` so nothing is silently lost.

### `chat`

`ROWID`, `guid` (`iMessage;-;+1555…` for 1:1, `iMessage;+;chat123…` for groups), `style`
(**45 = 1:1** (251 chats, always exactly 1 handle), **43 = group** (31 chats, 2–5 handles)),
`chat_identifier`, `service_name`, `display_name` (set on only 4 group chats), `room_name`,
`is_archived`, `group_id`. 282 chats: 242 iMessage, 40 SMS.

### `handle`

272 rows. `id` shapes: `+1XXXXXXXXXX` (242), email (12), `+XXXXXXXXXXXX` 12-digit
international (9), 5-digit short codes (6), 6-digit short code (1), `urn:biz:<uuid>` business
chat (2). `country` is `US`/`us`. `uncanonicalized_id` set on 20 rows (raw dialed form,
e.g. 10 digits without `+1`). `person_centric_id` is never populated — cannot be used for
contact identity. `UNIQUE(id, service)` → the same person can have two handle rows
(iMessage + SMS) with the same `id`.

### `attachment`

5,068 rows. Columns used: `ROWID`, `guid`, `original_guid`, `filename`, `uti`, `mime_type`,
`transfer_name`, `total_bytes`, `is_sticker`, `hide_attachment`, `transfer_state`,
`is_outgoing`, `created_date`.

| Fact | Value |
|---|---|
| `mime_type` NULL | 2,355 (nearly all of them are the hidden plugin payloads below) |
| Hidden (`hide_attachment = 1`) | 2,352 — 2,346 are `.pluginPayloadAttachment` (link-preview / balloon payloads, UTI `dyn.age81…`), 6 are `.png` |
| Visible types | heic 1,329 · png 663 · jpeg/jpg 411 · mov 146 · gif 83 · pdf 27 · zip 15 · vcf 12 · caf 7 · heics 7 · m4a 6 · mp4 4 · doc 1 · no-extension 2 |
| Stickers | 41 |
| `transfer_state` | 5 = complete (5,006), 6 (51, files missing), -1 (7, missing), 0 (4, missing) |
| Files present on disk | 2,713 / 2,716 visible; 2,293 / 2,352 hidden. Everything with `transfer_state = 5` exists |
| `filename` forms | `~/Library/Messages/Attachments/XX/YY/<UUID>/<name>` (must expand `~`), and 58 rows pointing at `/var/folders/…/T/com.apple.imtranscoding…` temp files (transient outgoing transcodes — treated as unavailable) |
| Largest | 55.9 MB; mean 790 KB |
| Messages with attachments | 3,488 (`cache_has_attachments`); 1,036 messages have > 1 attachment |

## WAL / read-only safety

- Messages.app keeps `chat.db` in WAL mode and writes continuously while running.
- Opening with SQLite's read-only flag gives a consistent snapshot per read transaction and
  never writes to the main file. SQLite may touch the `-shm` shared-memory index as any WAL
  reader does; that is by design and does not alter database content.
- We never run `PRAGMA journal_mode`, `wal_checkpoint`, `VACUUM`, or any DDL/DML.
- `PRAGMA query_only = 1` is set as a second guard in the connection.
- Busy timeouts are set so a concurrent Messages.app write never surfaces as an error.

## Contacts data source

Apple exposes no supported, dependency-free API for a Node process. Options considered:

1. `Contacts.framework` via a compiled Swift helper — extra toolchain, extra TCC prompt, extra binary to trust.
2. AppleScript/JXA `Application("Contacts")` — needs Automation permission, launches Contacts.app, slow.
3. Read the AddressBook SQLite store read-only — same Full Disk Access grant we already need for `chat.db`, no new binaries, fast.

**Decision:** option 3, with the schema validated at runtime (`ZABCDRECORD`, `ZABCDPHONENUMBER`,
`ZABCDEMAILADDRESS`) and graceful degradation: if the store is missing, unreadable, or the
schema does not match, the sender runs with raw handles only and logs one warning.
The schema on this Mac could not be inspected from the sandbox (the folder cannot be bridged), so
`imessage-sender doctor` prints the discovered tables/columns for confirmation on first run.

## Permissions required on this Mac

| Permission | Why | Granted to |
|---|---|---|
| Full Disk Access | read `~/Library/Messages/chat.db` and `Attachments/`; read the AddressBook store | the **exact node binary** that launchd runs (e.g. `~/.nvm/versions/node/v22.x.y/bin/node`). Re-grant after upgrading node. |
| Contacts (TCC) | *not* required when reading the AddressBook SQLite store under Full Disk Access | — |
| Automation / Accessibility | not required | — |
| Root | not required — user LaunchAgent, user-owned state and logs | — |

Full Disk Access is also what the Claude desktop app was granted during this inspection.

## Verification against the real database (2026-08-29, read-only, nothing transmitted)

`imessage-sender doctor` and `imessage-sender dry-run` (`IMESSAGE_DRY_RUN=true`, no network
transport instantiated) were run against the live `chat.db` through a read-only mount:

| Check | Result |
|---|---|
| Schema validation | all required tables/columns present, no optional columns missing |
| Rows walked | 50,144 (ROWID 1 … 50,203) in 101 batches of 500, ~20 s |
| `attributedBody` decode failures | 0 |
| Normalised and "sent" to the dry-run transport | 49,947 |
| Withheld by the OTP filter | 197 (0.4 %) — reasons: strong_phrase 80, bare_code 56, sender_shortcode 25, auth_link 20, code_with_context 15, pin_context 3 (a message can match several) |
| Attachments in the newest 500 rows present on disk | 47 / 49 |
| Crashes / errors | none |

The dry run's state file lived in a sandbox scratch directory and was deleted afterwards.
Contact resolution was disabled for this run because the AddressBook store cannot be bridged
into the sandbox; `doctor` on the Mac itself will report the discovered schema.
