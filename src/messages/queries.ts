import type { MessagesDb } from "./db.js";
import type { RawMessageRow, RawAttachmentRow, RawChatParticipant } from "./types.js";

/**
 * All SQL against chat.db lives here. Every statement is a SELECT.
 * Column lists adapt to optional columns discovered at runtime (older macOS versions).
 */
export class MessageQueries {
  private readonly optional: Set<string>;

  constructor(private readonly mdb: MessagesDb) {
    this.optional = new Set(mdb.columns("message"));
  }

  /**
   * Apple stores nanosecond timestamps (~8e17) that exceed Number.MAX_SAFE_INTEGER, so node:sqlite
   * must be told to return BigInts. Everything that fits safely is converted back to a Number.
   */
  private prep(sql: string): { all(...p: unknown[]): Record<string, unknown>[]; get(...p: unknown[]): Record<string, unknown> | undefined } {
    const stmt = this.mdb.db.prepare(sql);
    stmt.setReadBigInts(true);
    return {
      all: (...p: unknown[]) => (stmt.all(...(p as never[])) as Record<string, unknown>[]).map(narrowRow),
      get: (...p: unknown[]) => {
        const r = stmt.get(...(p as never[])) as Record<string, unknown> | undefined;
        return r ? narrowRow(r) : undefined;
      },
    };
  }

  private col(name: string, fallback = "NULL"): string {
    return this.optional.has(name) ? `m.${name}` : `${fallback} AS ${name}`;
  }

  private messageSelect(): string {
    return `
      SELECT
        m.ROWID AS rowid, m.guid, m.text, m.attributedBody,
        ${this.col("subject")}, m.handle_id, ${this.col("other_handle", "0")},
        m.service, m.date, ${this.col("date_read")}, ${this.col("date_delivered")},
        ${this.col("date_edited")}, ${this.col("date_retracted")},
        m.is_from_me, ${this.col("is_read", "0")}, ${this.col("is_sent", "0")}, ${this.col("is_delivered", "0")},
        ${this.col("is_audio_message", "0")}, ${this.col("is_spam", "0")}, ${this.col("error", "0")},
        m.item_type, ${this.col("group_action_type", "0")}, ${this.col("group_title")},
        m.associated_message_guid, m.associated_message_type, ${this.col("balloon_bundle_id")},
        m.cache_has_attachments, ${this.col("thread_originator_guid")}, ${this.col("thread_originator_part")},
        h.id AS sender_handle,
        oh.id AS other_handle_id,
        c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.style AS chat_style,
        c.service_name AS chat_service, c.display_name AS chat_display_name
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN handle oh ON oh.ROWID = ${this.optional.has("other_handle") ? "m.other_handle" : "-1"}
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    `;
  }

  maxRowId(): number {
    const row = this.prep("SELECT COALESCE(MAX(ROWID), 0) AS m FROM message").get() as { m: number };
    return Number(row.m);
  }

  countRowsAfter(rowid: number): number {
    const row = this.prep("SELECT COUNT(*) AS c FROM message WHERE ROWID > ?").get(rowid) as { c: number };
    return Number(row.c);
  }

  countAll(): number {
    const row = this.prep("SELECT COUNT(*) AS c FROM message").get() as { c: number };
    return Number(row.c);
  }

  /** Messages with ROWID in (afterRowId, ...] ascending, at most `limit`. */
  messagesAfter(afterRowId: number, limit: number): RawMessageRow[] {
    const sql = `${this.messageSelect()} WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?`;
    return this.prep(sql).all(afterRowId, limit) as unknown as RawMessageRow[];
  }

  /** Messages edited after `afterAppleNs` whose ROWID is at or below `maxRowId` (already sent). */
  editedSince(afterAppleNs: number, maxRowId: number, limit: number): RawMessageRow[] {
    if (!this.optional.has("date_edited")) return [];
    const sql = `${this.messageSelect()} WHERE m.date_edited > ? AND m.ROWID <= ? ORDER BY m.date_edited ASC, m.ROWID ASC LIMIT ?`;
    return this.prep(sql).all(afterAppleNs, maxRowId, limit) as unknown as RawMessageRow[];
  }

  messageByRowId(rowid: number): RawMessageRow | undefined {
    const sql = `${this.messageSelect()} WHERE m.ROWID = ?`;
    return this.prep(sql).get(rowid) as unknown as RawMessageRow | undefined;
  }

  /** Attachments for a set of message ROWIDs, keyed by message ROWID. */
  attachmentsFor(messageRowIds: number[]): Map<number, RawAttachmentRow[]> {
    const out = new Map<number, RawAttachmentRow[]>();
    if (messageRowIds.length === 0) return out;
    const attCols = new Set(this.mdb.columns("attachment"));
    const opt = (n: string, fb = "NULL") => (attCols.has(n) ? `a.${n}` : `${fb} AS ${n}`);
    // chunk to stay well under SQLite's variable limit
    for (let i = 0; i < messageRowIds.length; i += 500) {
      const chunk = messageRowIds.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const sql = `
        SELECT a.ROWID AS rowid, a.guid, ${opt("original_guid")}, maj.message_id AS message_rowid,
               a.filename, a.uti, a.mime_type, a.transfer_name, a.total_bytes,
               ${opt("is_sticker", "0")}, ${opt("hide_attachment", "0")}, ${opt("transfer_state", "0")},
               ${opt("is_outgoing", "0")}, ${opt("created_date")}
        FROM message_attachment_join maj
        JOIN attachment a ON a.ROWID = maj.attachment_id
        WHERE maj.message_id IN (${placeholders})
        ORDER BY maj.message_id ASC, a.ROWID ASC`;
      const rows = this.prep(sql).all(...chunk) as unknown as RawAttachmentRow[];
      for (const r of rows) {
        const list = out.get(r.message_rowid) ?? [];
        list.push(r);
        out.set(r.message_rowid, list);
      }
    }
    return out;
  }

  attachmentByRowId(attachmentRowId: number, messageRowId: number): RawAttachmentRow | undefined {
    const attCols = new Set(this.mdb.columns("attachment"));
    const opt = (n: string, fb = "NULL") => (attCols.has(n) ? `a.${n}` : `${fb} AS ${n}`);
    const sql = `
      SELECT a.ROWID AS rowid, a.guid, ${opt("original_guid")}, ? AS message_rowid,
             a.filename, a.uti, a.mime_type, a.transfer_name, a.total_bytes,
             ${opt("is_sticker", "0")}, ${opt("hide_attachment", "0")}, ${opt("transfer_state", "0")},
             ${opt("is_outgoing", "0")}, ${opt("created_date")}
      FROM attachment a WHERE a.ROWID = ?`;
    return this.prep(sql).get(messageRowId, attachmentRowId) as unknown as RawAttachmentRow | undefined;
  }

  /** Participants (handle ids) of chats, keyed by chat ROWID. */
  participantsFor(chatRowIds: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    const ids = [...new Set(chatRowIds)];
    if (ids.length === 0) return out;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.mdb.db
        .prepare(
          `SELECT chj.chat_id AS chat_rowid, h.id AS handle
           FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
           WHERE chj.chat_id IN (${placeholders}) ORDER BY chj.chat_id, h.ROWID`,
        )
        .all(...chunk) as unknown as RawChatParticipant[];
      for (const r of rows) {
        const list = out.get(r.chat_rowid) ?? [];
        if (!list.includes(r.handle)) list.push(r.handle);
        out.set(r.chat_rowid, list);
      }
    }
    return out;
  }

  /** Aggregate, content-free statistics for `doctor`. */
  stats(): Record<string, number> {
    const one = (sql: string) => Number((this.prep(sql).get() as { v: number }).v);
    return {
      messages: one("SELECT COUNT(*) AS v FROM message"),
      maxRowId: one("SELECT COALESCE(MAX(ROWID),0) AS v FROM message"),
      chats: one("SELECT COUNT(*) AS v FROM chat"),
      handles: one("SELECT COUNT(*) AS v FROM handle"),
      attachments: one("SELECT COUNT(*) AS v FROM attachment"),
      textNull: one("SELECT COUNT(*) AS v FROM message WHERE text IS NULL"),
      bodyNull: one("SELECT COUNT(*) AS v FROM message WHERE attributedBody IS NULL"),
      withAttachments: one("SELECT COUNT(*) AS v FROM message WHERE cache_has_attachments = 1"),
    };
  }
}

function narrowRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(-Number.MAX_SAFE_INTEGER)) row[k] = Number(v);
  }
  return row;
}
