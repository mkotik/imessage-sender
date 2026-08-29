# Receiver API contract (v1)

This is the contract the Mac sender speaks. The VPS receiver does not exist yet; this document
is the spec it must implement. Everything is versioned under `/v1`; the base URL is
`IMESSAGE_INGEST_URL` (e.g. `https://messages.example.com`).

## Authentication

Every request carries whichever of these the sender is configured with (both may be present):

| Header | Source |
|---|---|
| `Authorization: Bearer <token>` | `IMESSAGE_INGEST_TOKEN` |
| `CF-Access-Client-Id` / `CF-Access-Client-Secret` | `IMESSAGE_CF_ACCESS_CLIENT_ID` / `_SECRET` (Cloudflare Access service token; Cloudflare validates it at the edge and forwards a `Cf-Access-Jwt-Assertion` the receiver should verify) |
| `X-Sender-Device` | stable per-install UUID from the state file |
| `X-Sender-Version` | package version |
| `User-Agent` | `imessage-sender/<version>` |

The sender only ever talks to the configured base URL. Redirects are **not** followed.

## Endpoints

### `POST /v1/messages/batch`

Content-Type `application/json`. Header `Idempotency-Key: <batchId>`; the same batch retried
after a failure carries the same key and identical content.

```jsonc
{
  "schemaVersion": 1,
  "batchId": "b1f2…",                 // sha256 of device + rowid range + guids (deterministic)
  "deviceId": "8b4a…",                 // per-install UUID
  "phase": "backfill" | "incremental" | "revision",
  "sentAt": "2026-08-29T20:15:03.120Z",
  "range": { "firstRowId": 1, "lastRowId": 200 },
  "messages": [ NormalizedMessage, … ] // ≤ IMESSAGE_BATCH_SIZE, ROWID ascending
}
```

Success: `200`/`201`/`202` with

```jsonc
{
  "ok": true,
  "received": 198,                     // informational
  "attachments": {                     // optional. Omitted ⇒ sender uploads every available attachment in this batch
    "wanted": ["<attachmentGuid>", …]  // only these are uploaded (receiver already has the rest)
  }
}
```

Any non-2xx is a failure; the sender does not advance its checkpoint.
The receiver MUST deduplicate on `messageGuid` and treat a second delivery of the same
`messageGuid` as an upsert (later `revision` batches carry edited messages).

A batch can be empty (`messages: []`) when every message in the ROWID range was filtered
locally. The receiver should still return `ok:true` so the sender can advance past the range.

### `PUT /v1/attachments/{attachmentGuid}`

Body: raw file bytes (`Content-Type` = detected MIME or `application/octet-stream`,
`Content-Length` set). Header `X-Attachment-Meta`: base64 of

```jsonc
{
  "attachmentGuid": "…",
  "messageGuid": "…",
  "filename": "IMG_0001.heic",
  "mimeType": "image/heic",
  "uti": "public.heic",
  "sizeBytes": 1234567,
  "sha256": "…",
  "isSticker": false,
  "isHidden": false
}
```

| Status | Sender behaviour |
|---|---|
| 200 / 201 / 204 | success |
| 409 | already stored — success |
| 413, 415, other 4xx (except 401/403/408/429) | permanent failure, dropped, logged by guid |
| 401 / 403 / 408 / 429 / 5xx / network | retried with backoff |

### `HEAD /v1/attachments/{attachmentGuid}` (optional)

`200` ⇒ sender skips the upload. `404` ⇒ upload. Any other status ⇒ upload anyway.
If the receiver does not implement it, return `404` or `405`.

### `POST /v1/heartbeat` (optional)

```jsonc
{ "deviceId": "…", "version": "0.1.0", "at": "…", "phase": "incremental",
  "lastAckedRowId": 50201, "pendingAttachments": 0, "backfillComplete": true }
```

Any response is ignored except for logging. `404` disables heartbeats for the process lifetime.

## NormalizedMessage

```ts
interface NormalizedMessage {
  schemaVersion: 1;
  source: "apple_messages";
  messageGuid: string;              // Apple message UUID — the identity key
  sourceRowId: number;              // chat.db message.ROWID (debugging only)
  kind: "message" | "reaction" | "group_event" | "system";
  chat: {
    chatGuid: string;               // e.g. "iMessage;-;+15551234567"
    chatRowId: number;
    identifier: string;             // chat_identifier
    isGroup: boolean;
    displayName?: string;           // group name if set
    service: string;                // iMessage | SMS
  };
  sender: { handle?: string; displayName?: string; isMe: boolean };
  participants: Array<{ handle: string; displayName?: string }>; // chat members excluding me
  sentAt: string;                   // ISO-8601 UTC
  deliveredAt?: string; readAt?: string; editedAt?: string;
  text?: string;                    // absent when empty after stripping placeholders
  subject?: string;
  isFromMe: boolean;
  service: string;                  // iMessage | SMS
  isAudioMessage: boolean;
  attachments: AttachmentMetadata[];
  reaction?: { type: string; action: "add" | "remove"; targetMessageGuid: string; targetPart?: number };
  reply?: { threadOriginatorGuid: string; part?: string };
  groupEvent?: { itemType: number; actionType: number; title?: string; otherHandle?: string };
  balloonBundleId?: string;         // e.g. com.apple.messages.URLBalloonProvider
  flags: { bodyDecodeFailed?: boolean; isSpam?: boolean; error?: number };
}

interface AttachmentMetadata {
  attachmentGuid: string;
  sourceRowId: number;
  messageGuid: string;
  filename?: string;                // basename only — never the local path
  mimeType?: string;
  uti?: string;
  sizeBytes?: number;
  sha256?: string;                  // present only when the file is available and within limit
  isSticker: boolean;
  isHidden: boolean;                // Apple hide_attachment (link-preview payloads etc.)
  available: boolean;               // file exists locally at scan time
  willUpload: boolean;              // sender intends to PUT the bytes
  skippedReason?: "missing" | "too_large" | "hidden" | "temp_file";
  createdAt?: string;
}
```

Reaction `type` values: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`,
`sticker`, or `unknown:<n>`.

## Ordering and idempotency guarantees

- Batches from one device arrive in non-decreasing `range.lastRowId` order, except `revision`
  batches, which may reference any earlier ROWID.
- A batch may be delivered more than once (crash after send, before checkpoint write). Same
  `batchId`, same content.
- Attachment uploads may be repeated; `409` or an idempotent overwrite are both fine.
- Attachments always arrive **after** the batch containing their message metadata was acked.
