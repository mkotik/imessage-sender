import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFileSync } from "../util/atomic-write.js";

export const STATE_VERSION = 1;

export interface PendingAttachment {
  attachmentGuid: string;
  messageGuid: string;
  rowId: number; // message rowid, to re-derive the local path from chat.db on retry
  attachmentRowId: number;
  attempts: number;
  nextAttemptAt: string; // ISO
}

export interface SenderState {
  version: typeof STATE_VERSION;
  deviceId: string;
  createdAt: string;
  updatedAt: string;
  messages: {
    lastAckedRowId: number;
    backfillComplete: boolean;
    backfillStartedAt?: string;
    backfillCompletedAt?: string;
    backfillTargetRowId?: number;
  };
  edits: {
    /** Apple ns timestamp of the newest date_edited we have re-sent. */
    lastEditScanAppleNs: number;
  };
  attachments: {
    pending: PendingAttachment[];
  };
  counters: {
    sentMessages: number;
    filteredMessages: number;
    uploadedAttachments: number;
    droppedAttachments: number;
    batches: number;
  };
}

export function emptyState(deviceId?: string): SenderState {
  const id = deviceId ?? randomUUID();
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    deviceId: id,
    createdAt: now,
    updatedAt: now,
    messages: { lastAckedRowId: 0, backfillComplete: false },
    edits: { lastEditScanAppleNs: 0 },
    attachments: { pending: [] },
    counters: { sentMessages: 0, filteredMessages: 0, uploadedAttachments: 0, droppedAttachments: 0, batches: 0 },
  };
}

/**
 * Durable checkpoint store. One JSON file, atomic replace on every save.
 * The in-memory copy is the source of truth between saves; `save()` is the commit point and
 * callers must only invoke it after the receiver acknowledged the corresponding work.
 */
export class CheckpointStore {
  readonly path: string;
  private state: SenderState;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "state.json");
    this.state = this.load();
  }

  private load(): SenderState {
    if (!existsSync(this.path)) return emptyState();
    const raw = readFileSync(this.path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`State file ${this.path} is corrupt (invalid JSON). Refusing to guess; restore or delete it.`);
    }
    return migrate(parsed);
  }

  get(): Readonly<SenderState> {
    return this.state;
  }

  /** Mutate-and-commit in one step. The mutation is applied to a clone; a throwing mutator commits nothing. */
  commit(mutate: (s: SenderState) => void): SenderState {
    const next = structuredClone(this.state);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    atomicWriteFileSync(this.path, JSON.stringify(next, null, 2) + "\n");
    this.state = next;
    return next;
  }

  reload(): SenderState {
    this.state = this.load();
    return this.state;
  }
}

function migrate(parsed: unknown): SenderState {
  if (!parsed || typeof parsed !== "object") throw new Error("State file has unexpected shape");
  const s = parsed as Partial<SenderState> & { version?: number };
  if (s.version !== STATE_VERSION) throw new Error(`State file version ${String(s.version)} is not supported by this build (${STATE_VERSION})`);
  const base = emptyState(s.deviceId);
  return {
    ...base,
    ...s,
    version: STATE_VERSION,
    messages: { ...base.messages, ...(s.messages ?? {}) },
    edits: { ...base.edits, ...(s.edits ?? {}) },
    attachments: { pending: Array.isArray(s.attachments?.pending) ? s.attachments.pending : [] },
    counters: { ...base.counters, ...(s.counters ?? {}) },
  };
}
