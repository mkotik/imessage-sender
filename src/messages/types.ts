/** Raw row shapes read from chat.db. Field names mirror Apple's columns on purpose. */

export interface RawMessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  subject: string | null;
  handle_id: number;
  other_handle: number;
  service: string | null;
  date: number | bigint | null;
  date_read: number | bigint | null;
  date_delivered: number | bigint | null;
  date_edited: number | bigint | null;
  date_retracted: number | bigint | null;
  is_from_me: number;
  is_read: number;
  is_sent: number;
  is_delivered: number;
  is_audio_message: number;
  is_spam: number;
  error: number;
  item_type: number;
  group_action_type: number;
  group_title: string | null;
  associated_message_guid: string | null;
  associated_message_type: number;
  balloon_bundle_id: string | null;
  cache_has_attachments: number;
  thread_originator_guid: string | null;
  thread_originator_part: string | null;
  // joined
  sender_handle: string | null; // handle.id for handle_id
  other_handle_id: string | null; // handle.id for other_handle
  chat_rowid: number | null;
  chat_guid: string | null;
  chat_identifier: string | null;
  chat_style: number | null;
  chat_service: string | null;
  chat_display_name: string | null;
}

export interface RawAttachmentRow {
  rowid: number;
  guid: string;
  original_guid: string | null;
  message_rowid: number;
  filename: string | null;
  uti: string | null;
  mime_type: string | null;
  transfer_name: string | null;
  total_bytes: number | bigint | null;
  is_sticker: number;
  hide_attachment: number;
  transfer_state: number;
  is_outgoing: number;
  created_date: number | bigint | null;
}

export interface RawChatParticipant {
  chat_rowid: number;
  handle: string;
}

export const CHAT_STYLE_GROUP = 43;
export const CHAT_STYLE_DIRECT = 45;
