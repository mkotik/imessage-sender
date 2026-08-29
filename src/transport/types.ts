/**
 * Wire types shared with the (future) receiver. Keep this file free of Apple internals beyond
 * the explicitly documented `source*` debugging fields. See docs/receiver-api.md.
 */

export const SCHEMA_VERSION = 1 as const;

export type MessageKind = "message" | "reaction" | "group_event" | "system";

export interface Participant {
  handle: string;
  displayName?: string;
}

export interface AttachmentMetadata {
  attachmentGuid: string;
  sourceRowId: number;
  messageGuid: string;
  filename?: string;
  mimeType?: string;
  uti?: string;
  sizeBytes?: number;
  sha256?: string;
  isSticker: boolean;
  isHidden: boolean;
  available: boolean;
  willUpload: boolean;
  skippedReason?: "missing" | "too_large" | "hidden" | "temp_file" | "sticker";
  createdAt?: string;
}

export interface NormalizedMessage {
  schemaVersion: typeof SCHEMA_VERSION;
  source: "apple_messages";
  messageGuid: string;
  sourceRowId: number;
  kind: MessageKind;
  chat: {
    chatGuid: string;
    chatRowId: number;
    identifier: string;
    isGroup: boolean;
    displayName?: string;
    service: string;
  };
  sender: { handle?: string; displayName?: string; isMe: boolean };
  participants: Participant[];
  sentAt: string;
  deliveredAt?: string;
  readAt?: string;
  editedAt?: string;
  text?: string;
  subject?: string;
  isFromMe: boolean;
  service: string;
  isAudioMessage: boolean;
  attachments: AttachmentMetadata[];
  reaction?: { type: string; action: "add" | "remove"; targetMessageGuid: string; targetPart?: number };
  reply?: { threadOriginatorGuid: string; part?: string };
  groupEvent?: { itemType: number; actionType: number; title?: string; otherHandle?: string };
  balloonBundleId?: string;
  flags: { bodyDecodeFailed?: boolean; isSpam?: boolean; error?: number };
}

export type BatchPhase = "backfill" | "incremental" | "revision";

export interface BatchRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  batchId: string;
  deviceId: string;
  phase: BatchPhase;
  sentAt: string;
  range: { firstRowId: number; lastRowId: number };
  messages: NormalizedMessage[];
}

export interface BatchResponse {
  ok: boolean;
  received?: number;
  attachments?: { wanted?: string[] };
}

export interface AttachmentUploadMeta {
  attachmentGuid: string;
  messageGuid: string;
  filename?: string;
  mimeType?: string;
  uti?: string;
  sizeBytes: number;
  sha256: string;
  isSticker: boolean;
  isHidden: boolean;
}

export type AttachmentUploadResult = { status: "ok" } | { status: "exists" } | { status: "rejected"; httpStatus: number };

export interface HeartbeatPayload {
  deviceId: string;
  version: string;
  at: string;
  phase: BatchPhase | "idle";
  lastAckedRowId: number;
  pendingAttachments: number;
  backfillComplete: boolean;
}

/** Transport abstraction — the sync engine only ever talks to this. */
export interface ReceiverTransport {
  sendBatch(batch: BatchRequest, signal?: AbortSignal): Promise<BatchResponse>;
  uploadAttachment(meta: AttachmentUploadMeta, body: () => NodeJS.ReadableStream, signal?: AbortSignal): Promise<AttachmentUploadResult>;
  attachmentExists?(attachmentGuid: string, signal?: AbortSignal): Promise<boolean | undefined>;
  heartbeat?(payload: HeartbeatPayload, signal?: AbortSignal): Promise<void>;
}

/** Thrown by the HTTP client; the engine decides retry vs. permanent based on `kind`. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "http",
    readonly status?: number,
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "TransportError";
  }
}
