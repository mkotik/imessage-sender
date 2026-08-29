import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";

/**
 * Read-only handle on Apple's chat.db.
 *
 * Guarantees:
 *  - opened with SQLite's read-only flag: any write is refused by SQLite itself
 *  - `PRAGMA query_only = 1` as a second guard (a connection-local flag, does not touch the file)
 *  - no journal_mode / checkpoint / vacuum / DDL ever issued
 *  - busy timeout so Messages.app's own writes never surface as errors
 */
export class MessagesDb {
  readonly db: DatabaseSync;

  private constructor(readonly path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.db.exec("PRAGMA query_only = 1");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  static open(path: string): MessagesDb {
    if (!existsSync(path)) {
      throw new Error(`Messages database not found at ${path} (is Full Disk Access granted to this node binary?)`);
    }
    try {
      return new MessagesDb(path);
    } catch (err) {
      const e = err as Error;
      if (/unable to open|authorization denied|EPERM|not permitted/i.test(e.message)) {
        throw new Error(`Cannot open ${path}: ${e.message}. Grant Full Disk Access to the node binary that runs this service.`);
      }
      throw err;
    }
  }

  /** Cheap change signal: mtime of chat.db and its WAL. */
  static changeStamp(path: string): string {
    const parts: string[] = [];
    for (const p of [path, `${path}-wal`]) {
      try {
        const st = statSync(p);
        parts.push(`${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push("-");
      }
    }
    return parts.join("|");
  }

  hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name);
    return !!row;
  }

  columns(table: string): string[] {
    const rows = this.db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

export const REQUIRED_TABLES = ["message", "chat", "handle", "attachment", "chat_message_join", "chat_handle_join", "message_attachment_join"];

export const REQUIRED_MESSAGE_COLUMNS = ["ROWID", "guid", "text", "attributedBody", "handle_id", "service", "date", "is_from_me", "item_type", "associated_message_guid", "associated_message_type", "cache_has_attachments"];

export interface SchemaReport {
  ok: boolean;
  missingTables: string[];
  missingMessageColumns: string[];
  optionalMissing: string[];
}

const OPTIONAL_MESSAGE_COLUMNS = ["date_edited", "date_retracted", "thread_originator_guid", "thread_originator_part", "is_audio_message", "is_spam", "balloon_bundle_id", "group_title", "group_action_type", "other_handle", "subject", "date_read", "date_delivered"];

export function validateSchema(db: MessagesDb): SchemaReport {
  const missingTables = REQUIRED_TABLES.filter((t) => !db.hasTable(t));
  const cols = missingTables.includes("message") ? [] : db.columns("message");
  const missingMessageColumns = REQUIRED_MESSAGE_COLUMNS.filter((c) => !cols.includes(c));
  const optionalMissing = OPTIONAL_MESSAGE_COLUMNS.filter((c) => !cols.includes(c));
  return { ok: missingTables.length === 0 && missingMessageColumns.length === 0, missingTables, missingMessageColumns, optionalMissing };
}
