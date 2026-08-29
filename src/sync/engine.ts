import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { errorFields } from "../logging/logger.js";
import type { MessageQueries } from "../messages/queries.js";
import type { RawMessageRow } from "../messages/types.js";
import { normalizeMessage } from "../messages/normalize.js";
import type { ContactResolver } from "../contacts/resolver.js";
import type { AttachmentReader } from "../attachments/reader.js";
import { checkOtp } from "../privacy/otp-filter.js";
import { maskHandle, shortGuid } from "../privacy/redact.js";
import { TransportError, type BatchPhase, type BatchRequest, type NormalizedMessage, type ReceiverTransport } from "../transport/types.js";
import type { CheckpointStore, PendingAttachment } from "./checkpoint.js";
import { backoffDelayMs, sleep } from "../util/backoff.js";
import { unixMsToAppleNs } from "../util/time.js";

export interface EngineDeps {
  cfg: Pick<Config, "batchSize" | "blockedHandles" | "filterShortcodeSenders">;
  log: Logger;
  store: CheckpointStore;
  transport: ReceiverTransport;
  queries: MessageQueries;
  contacts: ContactResolver;
  attachments: AttachmentReader;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  backoff?: { baseMs: number; maxMs: number };
}

export interface BatchOutcome {
  rows: number;
  sent: number;
  filtered: number;
  lastRowId: number | undefined;
  attachmentsQueued: number;
}

export interface BuiltBatch {
  batch: BatchRequest;
  uploadPaths: Map<string, string>;
  attachmentsByGuid: Map<string, { messageGuid: string; rowId: number; attachmentRowId: number }>;
  filtered: number;
  firstRowId: number;
  lastRowId: number;
  maxEditedAppleNs: number;
}

const MAX_ATTACHMENT_ATTEMPTS = 25;
const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 5 * 60_000 };
const ATTACHMENT_BACKOFF = { baseMs: 30_000, maxMs: 24 * 60 * 60_000 };

/**
 * The single batch pipeline used by backfill, incremental sync and revision re-sends.
 * Never persists message content. Advances the checkpoint only after an acknowledgement.
 */
export class SyncEngine {
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;
  private readonly backoff: { baseMs: number; maxMs: number };

  constructor(private readonly d: EngineDeps) {
    this.sleepFn = d.sleep ?? sleep;
    this.now = d.now ?? (() => new Date());
    this.backoff = d.backoff ?? DEFAULT_BACKOFF;
  }

  // ------------------------------------------------------------------ building

  buildBatch(rows: RawMessageRow[], phase: BatchPhase): BuiltBatch | undefined {
    if (rows.length === 0) return undefined;
    const rowIds = rows.map((r) => r.rowid);
    const chatIds = rows.map((r) => r.chat_rowid).filter((c): c is number => c !== null);
    const attachmentRows = this.d.queries.attachmentsFor(rowIds);
    const participants = this.d.queries.participantsFor(chatIds);
    const ctx = { contacts: this.d.contacts, attachments: this.d.attachments, attachmentRows, participants };

    const messages: NormalizedMessage[] = [];
    const uploadPaths = new Map<string, string>();
    const attachmentsByGuid = new Map<string, { messageGuid: string; rowId: number; attachmentRowId: number }>();
    let filtered = 0;
    let maxEditedAppleNs = 0;
    const reasonCounts = new Map<string, number>();

    for (const row of rows) {
      const edited = row.date_edited === null || row.date_edited === undefined ? 0 : Number(row.date_edited);
      if (edited > maxEditedAppleNs) maxEditedAppleNs = edited;

      const { message, uploadPaths: paths } = normalizeMessage(row, ctx);
      const verdict = checkOtp(
        {
          text: message.text,
          subject: message.subject,
          senderHandle: message.sender.handle,
          counterpartHandles: message.participants.map((p) => p.handle),
          isFromMe: message.isFromMe,
        },
        { blockedHandles: this.d.cfg.blockedHandles, filterShortcodeSenders: this.d.cfg.filterShortcodeSenders },
      );
      if (verdict.filtered) {
        filtered++;
        for (const r of verdict.reasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
        // Deliberately nothing else: not the guid, not the handle, not the length.
        continue;
      }
      messages.push(message);
      for (const [guid, p] of paths) {
        uploadPaths.set(guid, p);
        const a = message.attachments.find((x) => x.attachmentGuid === guid)!;
        attachmentsByGuid.set(guid, { messageGuid: message.messageGuid, rowId: row.rowid, attachmentRowId: a.sourceRowId });
      }
    }

    if (filtered > 0) {
      const fields: Record<string, number> = {};
      for (const [k, v] of reasonCounts) fields[`reason_${k}`] = v;
      this.d.log.debug("filter_reasons", fields);
    }

    const firstRowId = rows[0]!.rowid;
    const lastRowId = rows[rows.length - 1]!.rowid;
    const batchId = createHash("sha256")
      .update(`${this.d.store.get().deviceId}|${phase}|${firstRowId}|${lastRowId}|${messages.map((m) => m.messageGuid).join(",")}`)
      .digest("hex")
      .slice(0, 32);
    const batch: BatchRequest = {
      schemaVersion: 1,
      batchId,
      deviceId: this.d.store.get().deviceId,
      phase,
      sentAt: this.now().toISOString(),
      range: { firstRowId, lastRowId },
      messages,
    };
    return { batch, uploadPaths, attachmentsByGuid, filtered, firstRowId, lastRowId, maxEditedAppleNs };
  }

  // ------------------------------------------------------------------ sending

  /** Send until acknowledged. Retries forever with backoff; only an abort returns early (undefined). */
  async sendWithRetry(batch: BatchRequest, signal?: AbortSignal): Promise<Awaited<ReturnType<ReceiverTransport["sendBatch"]>> | undefined> {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) return undefined;
      try {
        const res = await this.d.transport.sendBatch(batch, signal);
        if (attempt > 0) this.d.log.info("batch_recovered", { batchId: batch.batchId, attempts: attempt + 1 });
        return res;
      } catch (err) {
        if (signal?.aborted) return undefined;
        if (!(err instanceof TransportError)) throw err;
        const delay = err.retryable ? backoffDelayMs(attempt, this.backoff) : this.backoff.maxMs;
        const level = err.status === 401 || err.status === 403 ? "error" : err.retryable ? "warn" : "error";
        this.d.log[level](err.retryable ? "batch_send_failed" : "batch_rejected", {
          batchId: batch.batchId,
          phase: batch.phase,
          kind: err.kind,
          status: err.status ?? null,
          attempt: attempt + 1,
          retryInMs: delay,
          messages: batch.messages.length,
        });
        attempt++;
        await this.sleepFn(delay, signal);
      }
    }
  }

  // ------------------------------------------------------------------ pipeline

  /**
   * Query the next batch after the checkpoint, send it, commit. Returns undefined when there is
   * nothing after the checkpoint or the run was aborted before commit.
   */
  async processNextBatch(phase: "backfill" | "incremental", signal?: AbortSignal): Promise<BatchOutcome | undefined> {
    const state = this.d.store.get();
    const rows = this.d.queries.messagesAfter(state.messages.lastAckedRowId, this.d.cfg.batchSize);
    if (rows.length === 0) return undefined;
    this.d.contacts.refreshIfChanged();
    const built = this.buildBatch(rows, phase)!;

    const res = await this.sendWithRetry(built.batch, signal);
    if (!res) return undefined; // aborted; nothing committed

    const wanted = res.attachments?.wanted;
    const toQueue: PendingAttachment[] = [];
    for (const [guid, info] of built.attachmentsByGuid) {
      if (wanted && !wanted.includes(guid)) continue;
      toQueue.push({ attachmentGuid: guid, messageGuid: info.messageGuid, rowId: info.rowId, attachmentRowId: info.attachmentRowId, attempts: 0, nextAttemptAt: this.now().toISOString() });
    }

    this.d.store.commit((s) => {
      s.messages.lastAckedRowId = built.lastRowId;
      s.counters.batches++;
      s.counters.sentMessages += built.batch.messages.length;
      s.counters.filteredMessages += built.filtered;
      const existing = new Set(s.attachments.pending.map((p) => p.attachmentGuid));
      for (const p of toQueue) if (!existing.has(p.attachmentGuid)) s.attachments.pending.push(p);
    });

    this.d.log.info("batch_acked", {
      phase,
      batchId: built.batch.batchId,
      rows: rows.length,
      sent: built.batch.messages.length,
      filtered: built.filtered,
      attachmentsQueued: toQueue.length,
      firstRowId: built.firstRowId,
      lastRowId: built.lastRowId,
    });
    return { rows: rows.length, sent: built.batch.messages.length, filtered: built.filtered, lastRowId: built.lastRowId, attachmentsQueued: toQueue.length };
  }

  /** Re-send messages edited since the last edit scan (Apple updates rows in place). */
  async processEdits(signal?: AbortSignal): Promise<number> {
    const state = this.d.store.get();
    if (!state.messages.backfillComplete) return 0;
    const rows = this.d.queries.editedSince(state.edits.lastEditScanAppleNs, state.messages.lastAckedRowId, this.d.cfg.batchSize);
    if (rows.length === 0) return 0;
    const built = this.buildBatch(rows, "revision")!;
    const res = await this.sendWithRetry(built.batch, signal);
    if (!res) return 0;
    this.d.store.commit((s) => {
      // +10µs guards against double rounding of the ~8e17 ns value re-matching the same row forever.
      s.edits.lastEditScanAppleNs = Math.max(s.edits.lastEditScanAppleNs, built.maxEditedAppleNs + 10_000);
      s.counters.batches++;
    });
    this.d.log.info("revisions_acked", { rows: rows.length, sent: built.batch.messages.length, filtered: built.filtered });
    return rows.length;
  }

  // ------------------------------------------------------------------ attachments

  /** Upload due pending attachments. Returns number confirmed this pass. */
  async drainPendingAttachments(signal?: AbortSignal, maxPerPass = 50): Promise<{ uploaded: number; deferred: number; dropped: number }> {
    let uploaded = 0;
    let deferred = 0;
    let dropped = 0;
    const nowIso = this.now().toISOString();
    const due = this.d.store
      .get()
      .attachments.pending.filter((p) => p.nextAttemptAt <= nowIso)
      .slice(0, maxPerPass);

    for (const item of due) {
      if (signal?.aborted) break;
      const result = await this.uploadOne(item, signal);
      if (result === "aborted") break;
      if (result === "ok") {
        uploaded++;
        this.d.store.commit((s) => {
          s.attachments.pending = s.attachments.pending.filter((p) => p.attachmentGuid !== item.attachmentGuid);
          s.counters.uploadedAttachments++;
        });
      } else if (result === "drop") {
        dropped++;
        this.d.store.commit((s) => {
          s.attachments.pending = s.attachments.pending.filter((p) => p.attachmentGuid !== item.attachmentGuid);
          s.counters.droppedAttachments++;
        });
      } else {
        deferred++;
        const attempts = item.attempts + 1;
        const delay = backoffDelayMs(attempts, ATTACHMENT_BACKOFF);
        const next = new Date(this.now().getTime() + delay).toISOString();
        this.d.store.commit((s) => {
          const p = s.attachments.pending.find((x) => x.attachmentGuid === item.attachmentGuid);
          if (p) {
            p.attempts = attempts;
            p.nextAttemptAt = next;
          }
        });
        if (attempts >= MAX_ATTACHMENT_ATTEMPTS) {
          this.d.log.warn("attachment_retry_ceiling", { attachment: shortGuid(item.attachmentGuid), attempts });
        }
      }
    }
    if (uploaded || deferred || dropped) this.d.log.info("attachments_pass", { uploaded, deferred, dropped, pending: this.d.store.get().attachments.pending.length });
    return { uploaded, deferred, dropped };
  }

  private async uploadOne(item: PendingAttachment, signal?: AbortSignal): Promise<"ok" | "drop" | "retry" | "aborted"> {
    const row = this.d.queries.attachmentByRowId(item.attachmentRowId, item.rowId);
    if (!row) {
      this.d.log.warn("attachment_row_gone", { attachment: shortGuid(item.attachmentGuid) });
      return "drop";
    }
    const { localPath, ...meta } = this.d.attachments.describe(row, item.messageGuid);
    if (!meta.willUpload || !localPath) {
      this.d.log.info("attachment_skipped", { attachment: shortGuid(item.attachmentGuid), reason: meta.skippedReason ?? "unknown" });
      return "drop";
    }
    try {
      if (item.attempts > 0 && this.d.transport.attachmentExists) {
        const exists = await this.d.transport.attachmentExists(item.attachmentGuid, signal);
        if (exists === true) return "ok";
      }
      const sha256 = await this.d.attachments.sha256(localPath);
      const uploadMeta = {
        attachmentGuid: meta.attachmentGuid,
        messageGuid: meta.messageGuid,
        sizeBytes: meta.sizeBytes ?? 0,
        sha256,
        isSticker: meta.isSticker,
        isHidden: meta.isHidden,
        ...(meta.filename ? { filename: meta.filename } : {}),
        ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
        ...(meta.uti ? { uti: meta.uti } : {}),
      };
      const res = await this.d.transport.uploadAttachment(uploadMeta, () => this.d.attachments.openStream(localPath), signal);
      if (res.status === "ok" || res.status === "exists") return "ok";
      this.d.log.warn("attachment_rejected", { attachment: shortGuid(item.attachmentGuid), status: res.httpStatus });
      return "drop";
    } catch (err) {
      if (signal?.aborted) return "aborted";
      if (err instanceof TransportError) {
        this.d.log.warn("attachment_upload_failed", { attachment: shortGuid(item.attachmentGuid), kind: err.kind, status: err.status ?? null, attempt: item.attempts + 1 });
        return "retry";
      }
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EPERM") {
        this.d.log.warn("attachment_unreadable", { attachment: shortGuid(item.attachmentGuid), errCode: e.code });
        return "drop";
      }
      this.d.log.error("attachment_upload_error", { attachment: shortGuid(item.attachmentGuid), ...errorFields(err) });
      return "retry";
    }
  }

  // ------------------------------------------------------------------ helpers

  nowAppleNs(): number {
    return unixMsToAppleNs(this.now().getTime());
  }

  describeSender(m: NormalizedMessage): string {
    return maskHandle(m.sender.handle);
  }
}
