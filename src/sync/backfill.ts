import type { Logger } from "../logging/logger.js";
import type { MessageQueries } from "../messages/queries.js";
import type { CheckpointStore } from "./checkpoint.js";
import type { SyncEngine } from "./engine.js";

export interface BackfillResult {
  completed: boolean;
  batches: number;
  sent: number;
  filtered: number;
}

/**
 * Walk from the checkpoint to the ROWID that existed when the backfill began.
 * Resumable: every batch commits its own checkpoint; restarting simply continues.
 */
export async function runBackfill(engine: SyncEngine, store: CheckpointStore, queries: MessageQueries, log: Logger, signal?: AbortSignal): Promise<BackfillResult> {
  let state = store.get();
  if (state.messages.backfillComplete) return { completed: true, batches: 0, sent: 0, filtered: 0 };

  const currentMax = queries.maxRowId();
  if (currentMax < state.messages.lastAckedRowId) {
    throw new Error(
      `chat.db max ROWID (${currentMax}) is below the checkpoint (${state.messages.lastAckedRowId}). The database appears to have been replaced. Refusing to continue; reset state to re-sync.`,
    );
  }

  if (state.messages.backfillTargetRowId === undefined) {
    const target = currentMax;
    state = store.commit((s) => {
      s.messages.backfillTargetRowId = target;
      s.messages.backfillStartedAt = s.messages.backfillStartedAt ?? new Date().toISOString();
      if (s.edits.lastEditScanAppleNs === 0) s.edits.lastEditScanAppleNs = engine.nowAppleNs();
    });
    log.info("backfill_started", { fromRowId: state.messages.lastAckedRowId, targetRowId: target, remaining: queries.countRowsAfter(state.messages.lastAckedRowId) });
  } else {
    log.info("backfill_resumed", { fromRowId: state.messages.lastAckedRowId, targetRowId: state.messages.backfillTargetRowId });
  }

  const target = store.get().messages.backfillTargetRowId!;
  let batches = 0;
  let sent = 0;
  let filtered = 0;
  while (!signal?.aborted && store.get().messages.lastAckedRowId < target) {
    const outcome = await engine.processNextBatch("backfill", signal);
    if (!outcome) break; // aborted or nothing left
    batches++;
    sent += outcome.sent;
    filtered += outcome.filtered;
    if (batches % 10 === 0) {
      log.info("backfill_progress", { lastRowId: outcome.lastRowId ?? null, targetRowId: target, remaining: Math.max(0, queries.countRowsAfter(outcome.lastRowId ?? 0)) });
    }
    // Upload this batch's attachments before moving on so the pending list stays small.
    await engine.drainPendingAttachments(signal);
  }

  const finished = store.get().messages.lastAckedRowId >= target;
  if (finished) {
    store.commit((s) => {
      s.messages.backfillComplete = true;
      s.messages.backfillCompletedAt = new Date().toISOString();
    });
    log.info("backfill_complete", { targetRowId: target, batches, sent, filtered, pendingAttachments: store.get().attachments.pending.length });
  }
  return { completed: finished, batches, sent, filtered };
}
