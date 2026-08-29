# Architecture

```
~/Library/Messages/chat.db (read-only)      ~/Library/Application Support/AddressBook (read-only)
          │                                              │
          ▼                                              ▼
   messages/db.ts ──► messages/queries.ts        contacts/resolver.ts
          │                                              │
          ▼                                              │
   messages/parser.ts  (attributedBody → text)           │
          │                                              │
          ▼                                              │
   messages/normalize.ts  (Apple row → NormalizedMessage) ◄┘
          │
          ▼
   privacy/otp-filter.ts   ──── drop ───►  (nothing persisted, count only in log)
          │ keep
          ▼
   sync/engine.ts  (batch → transport → ack → checkpoint → attachments)
          │                         ▲
          ▼                         │
   transport/client.ts  ── HTTPS ──►  receiver (VPS, separate project)
          │
          ▼
   attachments/reader.ts  (locate, stat, hash, stream)
          │
          ▼
   sync/checkpoint.ts  (~/Library/Application Support/imessage-sender/state.json, atomic)
```

## Process model

One long-running Node process, started by a user LaunchAgent at login and kept alive by launchd.
It has two phases that share one pipeline:

1. **Backfill** — walks `message.ROWID` ascending from the checkpoint to the current max in
   batches. Each batch: query → parse → normalize → OTP-filter → send → wait for ack →
   persist checkpoint → upload that batch's attachments. When the walk reaches the max ROWID
   that existed when the backfill started, `backfillComplete` is persisted.
2. **Incremental** — every `IMESSAGE_POLL_INTERVAL_SECONDS` (default 30): cheap mtime check on
   `chat.db` / `chat.db-wal`; if changed, run the exact same batch pipeline for
   `ROWID > lastAckedRowId`. Also re-scans rows with `date_edited > lastEditScan` (edited
   messages are updated in place by Apple) and re-sends them as revisions. Pending attachment
   uploads are retried on every tick.

There is no separate incremental code path: `incremental.ts` and `backfill.ts` are thin drivers
over `engine.ts`, which is the only place that decides what is pending. Pending work is always
**derived from `chat.db` + the checkpoint**, never from a local queue of message bodies.

## Cursor and checkpoint

- Primary cursor: `message.ROWID` (monotonic AUTOINCREMENT; `date` is not monotonic).
- `state.messages.lastAckedRowId` advances **only** after the receiver returns a successful
  batch acknowledgement. A crash between send and persist re-sends the same batch with the same
  deterministic `batchId`; the receiver deduplicates by `messageGuid`.
- `state.attachments.pending[]` holds `{attachmentGuid, messageGuid, rowId, attempts, nextAttemptAt}`
  for attachments whose message batch was acked but whose bytes have not been confirmed. It is
  written in the same atomic state write as the checkpoint advance, so it can never reference a
  message the receiver has not seen. Entries are removed on success, on `409 exists`, or when
  the local file is permanently unavailable / over the size limit (metadata was already sent in
  the message payload with `available:false` or `skippedReason`).
- Safety check: if `max(ROWID)` in `chat.db` is lower than the checkpoint, the database was
  replaced/restored; the sender refuses to run until the operator resets state.

State writes are `write temp → fsync → rename`, so the file is always either the old or the new
version.

## Failure model

| Condition | Behaviour |
|---|---|
| Receiver 5xx / timeout / DNS / connection refused | exponential backoff with jitter (1 s → 5 min cap), retry forever, checkpoint untouched |
| Receiver 429 / 408 | as above |
| Receiver 401/403 | logged as `auth_error`, retried at the backoff cap (token rotated? config wrong?) — never dropped |
| Receiver other 4xx on a batch | logged as `batch_rejected` with status and `batchId`; retried at the backoff cap. Nothing is skipped automatically because skipping loses data. Operator can inspect `status`. |
| Attachment 413 / 415 / 4xx | permanent: dropped from pending, logged with guid only |
| Attachment file missing | `available:false` in metadata; not queued |
| Attachment over `IMESSAGE_MAX_ATTACHMENT_BYTES` | `skippedReason: "too_large"` in metadata; not queued |
| Mac sleeps / reboots | process resumes from state file; launchd restarts it at login |
| `chat.db` locked / busy | SQLite busy timeout 5 s, then the tick is skipped and retried next poll |
| Parser cannot decode a body | falls back to `text`; if both empty, message is still sent with `bodyDecodeFailed:true` and no text |
| OTP detector uncertain | detector is biased to *filter*: any auth-context phrase alone is enough |

Memory: a batch is at most `IMESSAGE_BATCH_SIZE` normalized messages; attachments are streamed
from disk, never buffered whole. Nothing else accumulates.

## Privacy boundaries

- The OTP filter runs on the normalized message **before** it enters the batch array. Filtered
  messages are not returned, not counted by GUID, and never reach the transport layer.
- Logging goes through one `Logger` whose formatter only accepts structured fields; message
  text, attachment bytes and tokens are never passed to it. Handles are masked
  (`+1•••••••1234`, `j•••@example.com`) by `privacy/redact.ts` before logging.
- The transport client serializes only `NormalizedMessage` objects; it has no access to raw rows.
- Errors thrown by `fetch` are logged by `code`/`status` only; response bodies are truncated to
  200 chars and never logged at `info`, only at `debug`, and only if they are not JSON with a
  `messages` key.

## Why not a local queue

A local queue of outgoing messages would be a second copy of the archive on disk (and a second
place OTPs could leak). Because Apple's DB is the durable source and ROWID is monotonic, the
combination (source DB, checkpoint) already *is* a durable queue.

## Contact resolution

`contacts/resolver.ts` opens every `AddressBook-v22.abcddb` it can find (main + `Sources/*`)
read-only, validates the schema, and builds two maps in memory: normalized phone → name(s) and
lower-cased email → name(s). Phone normalization keeps only digits and matches on the full
E.164 digits first, then on the last 10 digits (NANP) as a fallback. Multiple contacts sharing a
number produce a deterministic, alphabetically first display name and `ambiguous:true`.
The cache is rebuilt when any AddressBook file's mtime changes (checked at most once per poll).

## Transport modularity

`transport/types.ts` defines `ReceiverTransport` (`sendBatch`, `uploadAttachment`,
`attachmentExists?`, `heartbeat?`). `transport/client.ts` is the HTTPS implementation.
Tests use an in-memory implementation and a real mock HTTP server. Swapping the wire format for
the eventual VPS receiver means editing `client.ts` only.

## Future receiver compatibility

- Payloads are plain JSON with ISO-8601 UTC timestamps and no Apple-specific binary blobs.
- `messageGuid` is Apple's UUID; `sourceRowId`, `chatGuid`, `chatRowId` are passed as debugging
  aids but should not be used as identity on the receiver.
- Attachments are streamed as raw bytes with metadata in a header, so the receiver can pipe the
  body straight through an encrypting stream to object storage without buffering.
- Nothing in the sender assumes the receiver stores plaintext.
