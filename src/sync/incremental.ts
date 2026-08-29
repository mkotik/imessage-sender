import type { Logger } from "../logging/logger.js";
import { MessagesDb } from "../messages/db.js";
import type { MessageQueries } from "../messages/queries.js";
import type { CheckpointStore } from "./checkpoint.js";
import type { SyncEngine } from "./engine.js";

export interface IncrementalTickResult {
  changed: boolean;
  batches: number;
  sent: number;
  filtered: number;
  revisions: number;
}

/**
 * One incremental pass: drain everything after the checkpoint, then re-send edits, then
 * retry pending attachments. Cheap when nothing changed (single stat() + one COUNT).
 */
export class IncrementalSync {
  private lastStamp = "";

  constructor(
    private readonly engine: SyncEngine,
    private readonly store: CheckpointStore,
    private readonly queries: MessageQueries,
    private readonly chatDbPath: string,
    private readonly log: Logger,
  ) {}

  async tick(signal?: AbortSignal, force = false): Promise<IncrementalTickResult> {
    const result: IncrementalTickResult = { changed: false, batches: 0, sent: 0, filtered: 0, revisions: 0 };
    const stamp = MessagesDb.changeStamp(this.chatDbPath);
    const pendingBefore = this.store.get().attachments.pending.length;
    if (!force && stamp === this.lastStamp && pendingBefore === 0) return result;
    this.lastStamp = stamp;

    const max = this.queries.maxRowId();
    const checkpoint = this.store.get().messages.lastAckedRowId;
    if (max < checkpoint) {
      throw new Error(`chat.db max ROWID (${max}) is below the checkpoint (${checkpoint}); database replaced? Refusing to continue.`);
    }

    while (!signal?.aborted) {
      const outcome = await this.engine.processNextBatch("incremental", signal);
      if (!outcome) break;
      result.changed = true;
      result.batches++;
      result.sent += outcome.sent;
      result.filtered += outcome.filtered;
    }

    const revisions = await this.engine.processEdits(signal);
    if (revisions > 0) {
      result.changed = true;
      result.revisions = revisions;
    }

    const att = await this.engine.drainPendingAttachments(signal);
    if (att.uploaded || att.dropped) result.changed = true;

    if (result.changed) {
      this.log.info("incremental_tick", { batches: result.batches, sent: result.sent, filtered: result.filtered, revisions: result.revisions, attachmentsUploaded: att.uploaded, attachmentsDeferred: att.deferred });
    }
    return result;
  }
}
