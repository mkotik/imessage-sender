import type { RawMessageRow, RawAttachmentRow } from "./types.js";
import { CHAT_STYLE_GROUP } from "./types.js";
import { resolveBody } from "./parser.js";
import { appleTimeToIso } from "../util/time.js";
import type { ContactResolver } from "../contacts/resolver.js";
import type { AttachmentReader } from "../attachments/reader.js";
import type { AttachmentMetadata, NormalizedMessage, MessageKind } from "../transport/types.js";
import { SCHEMA_VERSION } from "../transport/types.js";

export interface NormalizeContext {
  contacts: ContactResolver;
  attachments: AttachmentReader;
  attachmentRows: Map<number, RawAttachmentRow[]>; // by message rowid
  participants: Map<number, string[]>; // by chat rowid
}

export interface NormalizedWithLocal {
  message: NormalizedMessage;
  /** attachmentGuid → local path for the ones we intend to upload. Never serialised. */
  uploadPaths: Map<string, string>;
}

const REACTION_TYPES: Record<number, string> = {
  0: "love",
  1: "like",
  2: "dislike",
  3: "laugh",
  4: "emphasize",
  5: "question",
};

export function parseAssociatedGuid(value: string | null): { guid: string; part?: number } | undefined {
  if (!value) return undefined;
  // forms: "p:0/GUID", "bp:GUID", "GUID"
  const m = /^(?:p:(\d+)\/|bp:)?([0-9A-Fa-f-]{36}|[^/]+)$/.exec(value.trim());
  if (!m) return undefined;
  const out: { guid: string; part?: number } = { guid: m[2]! };
  if (m[1] !== undefined) out.part = Number(m[1]);
  return out;
}

export function reactionFromType(assocType: number): { type: string; action: "add" | "remove" } | undefined {
  if (assocType >= 2000 && assocType < 3000) {
    const t = REACTION_TYPES[assocType - 2000];
    return { type: t ?? `unknown:${assocType}`, action: "add" };
  }
  if (assocType >= 3000 && assocType < 4000) {
    const t = REACTION_TYPES[assocType - 3000];
    return { type: t ?? `unknown:${assocType}`, action: "remove" };
  }
  if (assocType === 1000) return { type: "sticker", action: "add" };
  return undefined;
}

function classify(row: RawMessageRow): MessageKind {
  if (row.item_type !== 0) return row.item_type === 1 || row.item_type === 3 ? "group_event" : "system";
  if (reactionFromType(row.associated_message_type)) return "reaction";
  return "message";
}

export function normalizeMessage(row: RawMessageRow, ctx: NormalizeContext): NormalizedWithLocal {
  const kind = classify(row);
  const isGroup = row.chat_style === CHAT_STYLE_GROUP;
  const chatParticipants = row.chat_rowid !== null ? (ctx.participants.get(row.chat_rowid) ?? []) : [];
  const body = resolveBody(row.text, row.attributedBody);

  // Sender: for outgoing rows handle_id is 0. In a 1:1 chat the peer is the single participant.
  let senderHandle: string | undefined = row.sender_handle ?? undefined;
  if (!senderHandle && !row.is_from_me && !isGroup && chatParticipants.length === 1) senderHandle = chatParticipants[0];

  const senderName = senderHandle ? ctx.contacts.resolve(senderHandle)?.displayName : undefined;

  const participants = chatParticipants.map((h) => {
    const name = ctx.contacts.resolve(h)?.displayName;
    return name ? { handle: h, displayName: name } : { handle: h };
  });

  const uploadPaths = new Map<string, string>();
  const attachments: AttachmentMetadata[] = [];
  for (const a of ctx.attachmentRows.get(row.rowid) ?? []) {
    const { localPath, ...meta } = ctx.attachments.describe(a, row.guid);
    attachments.push(meta);
    if (meta.willUpload && localPath) uploadPaths.set(meta.attachmentGuid, localPath);
  }

  const service = row.service ?? row.chat_service ?? "unknown";
  const msg: NormalizedMessage = {
    schemaVersion: SCHEMA_VERSION,
    source: "apple_messages",
    messageGuid: row.guid,
    sourceRowId: row.rowid,
    kind,
    chat: {
      chatGuid: row.chat_guid ?? `unknown;-;${row.rowid}`,
      chatRowId: row.chat_rowid ?? -1,
      identifier: row.chat_identifier ?? "",
      isGroup,
      service: row.chat_service ?? service,
    },
    sender: { isMe: row.is_from_me === 1 },
    participants,
    sentAt: appleTimeToIso(row.date) ?? new Date(0).toISOString(),
    isFromMe: row.is_from_me === 1,
    service,
    isAudioMessage: row.is_audio_message === 1,
    attachments,
    flags: {},
  };
  if (row.chat_display_name) msg.chat.displayName = row.chat_display_name;
  if (senderHandle) msg.sender.handle = senderHandle;
  if (senderName) msg.sender.displayName = senderName;
  const delivered = appleTimeToIso(row.date_delivered);
  if (delivered) msg.deliveredAt = delivered;
  const read = appleTimeToIso(row.date_read);
  if (read) msg.readAt = read;
  const edited = appleTimeToIso(row.date_edited);
  if (edited) msg.editedAt = edited;
  if (body.text !== undefined) msg.text = body.text;
  if (row.subject && row.subject.trim()) msg.subject = row.subject.trim();
  if (body.decodeFailed) msg.flags.bodyDecodeFailed = true;
  if (row.is_spam === 1) msg.flags.isSpam = true;
  if (row.error) msg.flags.error = row.error;
  if (row.balloon_bundle_id) msg.balloonBundleId = row.balloon_bundle_id;

  if (kind === "reaction") {
    const r = reactionFromType(row.associated_message_type)!;
    const target = parseAssociatedGuid(row.associated_message_guid);
    msg.reaction = { type: r.type, action: r.action, targetMessageGuid: target?.guid ?? "" };
    if (target?.part !== undefined) msg.reaction.targetPart = target.part;
  }
  if (row.thread_originator_guid) {
    msg.reply = { threadOriginatorGuid: row.thread_originator_guid };
    if (row.thread_originator_part) msg.reply.part = row.thread_originator_part;
  }
  if (kind === "group_event" || kind === "system") {
    msg.groupEvent = { itemType: row.item_type, actionType: row.group_action_type };
    if (row.group_title) msg.groupEvent.title = row.group_title;
    if (row.other_handle_id) msg.groupEvent.otherHandle = row.other_handle_id;
  }
  return { message: msg, uploadPaths };
}
