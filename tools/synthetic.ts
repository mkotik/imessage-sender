/**
 * Synthetic chat.db builder — mirrors the real schema shape (docs/findings.md) with
 * fabricated content. Used by tests and by `npm run synthetic-db`. Never contains real data.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unixMsToAppleNs } from "../src/util/time.js";

/** Build an attributedBody blob exactly like Apple's typedstream layout for a plain string. */
export function encodeAttributedBody(text: string): Buffer {
  const header = Buffer.from("040b73747265616d747970656481e80384014084848419", "hex"); // \x04\x0bstreamtyped …
  const cls = Buffer.from("NSMutableString\x01\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1");
  const payload = Buffer.from(text, "utf8");
  let len: Buffer;
  if (payload.length < 0x80) len = Buffer.from([payload.length]);
  else if (payload.length <= 0xffff) {
    len = Buffer.alloc(3);
    len[0] = 0x81;
    len.writeUInt16LE(payload.length, 1);
  } else {
    len = Buffer.alloc(5);
    len[0] = 0x82;
    len.writeUInt32LE(payload.length, 1);
  }
  const trailer = Buffer.from("\x86\x84\x02iI\x01\x0b\x92\x84\x84\x84\x0cNSDictionary\x00\x84\x84\x08NSObject\x00\x85\x84\x01i\x01\x92\x84\x84\x84\x08NSNumber\x00\x84\x84\x07NSValue\x00\x94\x84\x01*\x84\x99\x99\x01\x86\x86", "latin1");
  return Buffer.concat([header, cls, len, payload, trailer]);
}

export const SCHEMA_SQL = `
CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key));
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER, engram_id TEXT, server_change_token TEXT, ck_sync_state INTEGER DEFAULT 0, original_group_id TEXT, last_read_message_timestamp INTEGER DEFAULT 0, cloudkit_record_id TEXT, last_addressed_sim_id TEXT, is_blackholed INTEGER DEFAULT 0, syndication_date INTEGER DEFAULT 0, syndication_type INTEGER DEFAULT 0, is_recovered INTEGER DEFAULT 0, is_deleting_incoming_messages INTEGER DEFAULT 0);
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0, is_forward INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0, is_archive INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT, was_data_detected INTEGER DEFAULT 0, was_deduplicated INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, date_played INTEGER, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0, message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0, associated_message_range_length INTEGER DEFAULT 0, time_expressive_send_played INTEGER, message_summary_info BLOB, ck_sync_state INTEGER DEFAULT 0, ck_record_id TEXT, ck_record_change_tag TEXT, destination_caller_id TEXT, is_corrupt INTEGER DEFAULT 0, reply_to_guid TEXT, sort_id INTEGER, is_spam INTEGER DEFAULT 0, has_unseen_mention INTEGER DEFAULT 0, thread_originator_guid TEXT, thread_originator_part TEXT, syndication_ranges TEXT, synced_syndication_ranges TEXT, was_delivered_quietly INTEGER DEFAULT 0, did_notify_recipient INTEGER DEFAULT 0, date_retracted INTEGER, date_edited INTEGER, was_detonated INTEGER DEFAULT 0, part_count INTEGER, is_stewie INTEGER DEFAULT 0, is_kt_verified INTEGER DEFAULT 0, is_sos INTEGER DEFAULT 0, is_critical INTEGER DEFAULT 0, bia_reference_id TEXT DEFAULT NULL, fallback_hash TEXT DEFAULT NULL);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB, attribution_info BLOB, hide_attachment INTEGER DEFAULT 0, ck_sync_state INTEGER DEFAULT 0, ck_server_change_token_blob BLOB, ck_record_id TEXT, original_guid TEXT UNIQUE NOT NULL, is_commsafety_sensitive INTEGER DEFAULT 0);
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
CREATE TABLE deleted_messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, guid TEXT NOT NULL);
`;

export interface SynthMessage {
  text?: string | undefined;
  fromMe?: boolean;
  handle?: string; // sender or 1:1 peer
  chat?: string; // chat key, defaults to handle
  group?: string[]; // group members → group chat
  at?: number; // unix ms
  service?: "iMessage" | "SMS";
  attachments?: Array<{ name: string; bytes?: Buffer; mime?: string | null; uti?: string | null; hidden?: boolean; sticker?: boolean; missing?: boolean; tempPath?: boolean; size?: number }>;
  reactionTo?: { guid: string; type: number };
  itemType?: number;
  editedAt?: number;
  useTextColumn?: boolean;
  guid?: string;
  subject?: string;
}

export interface SynthOptions {
  dir: string; // where chat.db and Attachments/ go
  messages: SynthMessage[];
  startAt?: number;
}

export interface SynthResult {
  dbPath: string;
  attachmentsDir: string;
  guids: string[];
  db: DatabaseSync;
}

/** Create (or extend) a synthetic Messages database. Returns GUIDs in insertion order. */
export function buildSyntheticDb(opts: SynthOptions): SynthResult {
  mkdirSync(opts.dir, { recursive: true });
  const dbPath = join(opts.dir, "chat.db");
  const attachmentsDir = join(opts.dir, "Attachments");
  mkdirSync(attachmentsDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  const fresh = !(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name='message'").get() as unknown);
  if (fresh) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO _SqliteDatabaseProperties (key, value) VALUES ('_ClientVersion', '17014')").run();
  }
  const guids = appendMessages(db, attachmentsDir, opts.messages, opts.startAt ?? Date.UTC(2020, 0, 1));
  return { dbPath, attachmentsDir, guids, db };
}

export function appendMessages(db: DatabaseSync, attachmentsDir: string, messages: SynthMessage[], startAt: number): string[] {
  const guids: string[] = [];
  const handleId = (id: string, service: string) => {
    const row = db.prepare("SELECT ROWID AS r FROM handle WHERE id = ? AND service = ?").get(id, service) as { r: number } | undefined;
    if (row) return row.r;
    db.prepare("INSERT INTO handle (id, country, service) VALUES (?, 'us', ?)").run(id, service);
    return Number((db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r);
  };
  const chatId = (key: string, members: string[], service: string, isGroup: boolean) => {
    const guid = `${service};${isGroup ? "+" : "-"};${key}`;
    const row = db.prepare("SELECT ROWID AS r FROM chat WHERE guid = ?").get(guid) as { r: number } | undefined;
    if (row) return row.r;
    db.prepare("INSERT INTO chat (guid, style, state, chat_identifier, service_name, display_name) VALUES (?, ?, 3, ?, ?, ?)").run(guid, isGroup ? 43 : 45, key, service, isGroup ? "Synthetic Group" : null);
    const cid = Number((db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r);
    for (const m of members) db.prepare("INSERT OR IGNORE INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(cid, handleId(m, service));
    return cid;
  };

  let t = startAt;
  let i = 0;
  for (const m of messages) {
    i++;
    const service = m.service ?? "iMessage";
    const fromMe = m.fromMe ? 1 : 0;
    const peer = m.handle ?? "+15550000001";
    const members = m.group ?? [peer];
    const isGroup = !!m.group;
    const cid = chatId(m.chat ?? (isGroup ? `chat${members.join("").replace(/\D/g, "").slice(-8)}` : peer), members, service, isGroup);
    const hid = fromMe ? 0 : handleId(peer, service);
    const at = m.at ?? (t += 60_000);
    const guid = m.guid ?? randomUUID().toUpperCase();
    guids.push(guid);
    const body = m.text === undefined ? null : m.useTextColumn ? null : encodeAttributedBody(m.attachments?.length ? `￼${m.text}` : m.text);
    const textCol = m.useTextColumn ? (m.text ?? null) : null;
    db.prepare(
      `INSERT INTO message (guid, text, attributedBody, subject, handle_id, service, date, is_from_me, is_read, item_type, associated_message_guid, associated_message_type, cache_has_attachments, date_edited, reply_to_guid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      guid,
      textCol,
      body,
      m.subject ?? null,
      hid,
      service,
      unixMsToAppleNs(at),
      fromMe,
      fromMe ? 0 : 1,
      m.itemType ?? 0,
      m.reactionTo ? `p:0/${m.reactionTo.guid}` : null,
      m.reactionTo ? m.reactionTo.type : 0,
      m.attachments?.length ? 1 : 0,
      m.editedAt ? unixMsToAppleNs(m.editedAt) : 0,
    );
    const mid = Number((db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r);
    db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)").run(cid, mid, unixMsToAppleNs(at));

    for (const a of m.attachments ?? []) {
      const aguid = randomUUID().toUpperCase();
      const sub = join(attachmentsDir, aguid.slice(0, 2).toLowerCase(), aguid.slice(2, 4).toLowerCase(), aguid);
      let filename: string;
      if (a.tempPath) {
        filename = `/var/folders/zz/abc/T/com.apple.imtranscoding.${aguid}/${a.name}`;
      } else {
        filename = `~/Library/Messages/Attachments/${aguid.slice(0, 2).toLowerCase()}/${aguid.slice(2, 4).toLowerCase()}/${aguid}/${a.name}`;
        if (!a.missing) {
          mkdirSync(sub, { recursive: true });
          writeFileSync(join(sub, a.name), a.bytes ?? Buffer.from(`synthetic-${aguid}-${i}`));
        }
      }
      const bytes = a.size ?? a.bytes?.length ?? 0;
      db.prepare(
        `INSERT INTO attachment (guid, original_guid, created_date, filename, uti, mime_type, transfer_state, is_outgoing, transfer_name, total_bytes, is_sticker, hide_attachment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(aguid, aguid, unixMsToAppleNs(at), filename, a.uti === undefined ? null : a.uti, a.mime === undefined ? null : a.mime, a.missing || a.tempPath ? 6 : 5, fromMe, a.name, bytes, a.sticker ? 1 : 0, a.hidden ? 1 : 0);
      const aid = Number((db.prepare("SELECT last_insert_rowid() AS r").get() as { r: number }).r);
      db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)").run(mid, aid);
    }
  }
  return guids;
}

/** A representative fixture used by several tests and the demo. All content fabricated. */
export function sampleMessages(): SynthMessage[] {
  return [
    { text: "hey, are we still on for dinner tomorrow?", handle: "+15550000001" },
    { text: "yes! 7pm at the usual place", fromMe: true, handle: "+15550000001" },
    { text: "Your verification code is 483920. Do not share this code.", handle: "22395" },
    { text: "G-728172 is your Google verification code.", handle: "+18005550199" },
    { text: "Use 559102 as Microsoft account security code", handle: "+18885550123" },
    { text: "can you send me the photos from saturday", fromMe: true, handle: "alice@example.com" },
    { text: "here you go", handle: "alice@example.com", attachments: [{ name: "IMG_0001.heic", mime: "image/heic", uti: "public.heic" }, { name: "IMG_0002.heic", mime: "image/heic", uti: "public.heic" }] },
    { text: "https://example.com/article", handle: "+15550000002", attachments: [{ name: "abc.pluginPayloadAttachment", mime: null, uti: "dyn.age81a5dzq7y066dbtf0g82peqf4hk2pdrb00n5xy", hidden: true }] },
    { text: "old video", handle: "+15550000002", attachments: [{ name: "clip.mov", mime: "video/quicktime", uti: "com.apple.quicktime-movie", missing: true, size: 1234567 }] },
    { text: "group lunch friday?", group: ["+15550000001", "+15550000002", "+15550000003"], handle: "+15550000003" },
    { text: "in!", fromMe: true, group: ["+15550000001", "+15550000002", "+15550000003"] },
    { text: "the gate code for the airbnb is 4471", handle: "+15550000001" },
    { text: "meet at 10:30, bring $1,200 for the deposit", fromMe: true, handle: "+15550000001" },
    { text: "call me at 555-0100 when you land", handle: "+15550000002" },
    { text: "Your Apple ID Code is: 128 733. Don't share it with anyone.", handle: "+14155550100" },
    { text: "voice memo", handle: "+15550000003", attachments: [{ name: "Audio Message.caf", mime: null, uti: "com.apple.coreaudio-format" }] },
    { text: "sms from android friend", handle: "+15550000004", service: "SMS" },
    { text: "legacy text column row", handle: "+15550000004", useTextColumn: true },
    { text: "Ambiguous: what year did we go to the concert, 2019?", handle: "+15550000001" },
    { text: "thx", fromMe: true, handle: "+15550000004", service: "SMS" },
  ];
}
