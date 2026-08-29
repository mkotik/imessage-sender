import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticDb, type SynthResult } from "../tools/synthetic.js";
import { MessagesDb, validateSchema } from "../src/messages/db.js";
import { MessageQueries } from "../src/messages/queries.js";
import { normalizeMessage, parseAssociatedGuid, reactionFromType } from "../src/messages/normalize.js";
import { ContactIndex } from "../src/contacts/resolver.js";
import { AttachmentReader } from "../src/attachments/reader.js";
import type { NormalizedMessage } from "../src/transport/types.js";

describe("normalize", () => {
  const dir = mkdtempSync(join(tmpdir(), "norm-"));
  let synth: SynthResult;
  let mdb: MessagesDb;
  let q: MessageQueries;
  let all: NormalizedMessage[];
  const contacts = new ContactIndex();
  contacts.add("Alice Example", ["+15550000001"], ["alice@example.com"]);

  before(() => {
    synth = buildSyntheticDb({
      dir,
      startAt: Date.UTC(2024, 0, 1),
      messages: [
        { text: "hi there", handle: "+15550000001" }, // 0
        { text: "hello back", fromMe: true, handle: "+15550000001" }, // 1
        { text: "with attachment", handle: "alice@example.com", attachments: [{ name: "pic.png", mime: "image/png", uti: "public.png", bytes: Buffer.from("png-bytes") }] }, // 2
        { text: "group msg", group: ["+15550000001", "+15550000002"], handle: "+15550000002" }, // 3
        { text: "Loved “hi there”", handle: "+15550000001", reactionTo: { guid: "PLACEHOLDER", type: 2000 } }, // 4
        { text: undefined, handle: "+15550000001", itemType: 3 }, // 5 group event
        { text: "edited later", handle: "+15550000001", editedAt: Date.UTC(2024, 0, 2) }, // 6
        { text: "legacy", handle: "+15550000001", useTextColumn: true }, // 7
        { text: "sms one", handle: "+15550000009", service: "SMS" }, // 8
        { text: "with subject", handle: "+15550000001", subject: "Subj" }, // 9
      ],
    });
    // point the reaction at message 0
    synth.db.prepare("UPDATE message SET associated_message_guid = ? WHERE ROWID = 5").run(`p:0/${synth.guids[0]}`);
    synth.db.close();
    mdb = MessagesDb.open(synth.dbPath);
    q = new MessageQueries(mdb);
    const reader = new AttachmentReader({ attachmentsDir: synth.attachmentsDir, maxBytes: 1_000_000, uploadHidden: false, uploadStickers: true });
    const rows = q.messagesAfter(0, 100);
    const ctx = { contacts, attachments: reader, attachmentRows: q.attachmentsFor(rows.map((r) => r.rowid)), participants: q.participantsFor(rows.map((r) => r.chat_rowid!)) };
    all = rows.map((r) => normalizeMessage(r, ctx).message);
  });
  after(() => {
    mdb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("schema validation passes on the synthetic db (same DDL as the real one)", () => {
    const rep = validateSchema(mdb);
    assert.equal(rep.ok, true);
    assert.deepEqual(rep.optionalMissing, []);
  });

  it("db is read-only", () => {
    assert.throws(() => mdb.db.exec("DELETE FROM message"), /readonly/);
  });

  it("basic incoming message", () => {
    const m = all[0]!;
    assert.equal(m.messageGuid, synth.guids[0]);
    assert.equal(m.sourceRowId, 1);
    assert.equal(m.kind, "message");
    assert.equal(m.text, "hi there");
    assert.equal(m.isFromMe, false);
    assert.equal(m.sender.handle, "+15550000001");
    assert.equal(m.sender.displayName, "Alice Example");
    assert.equal(m.sender.isMe, false);
    assert.equal(m.chat.isGroup, false);
    assert.equal(m.chat.chatGuid, "iMessage;-;+15550000001");
    assert.equal(m.service, "iMessage");
    assert.equal(m.sentAt, "2024-01-01T00:01:00.000Z");
    assert.equal(m.source, "apple_messages");
    assert.equal(m.schemaVersion, 1);
    assert.deepEqual(m.participants, [{ handle: "+15550000001", displayName: "Alice Example" }]);
  });

  it("outgoing message in a 1:1 chat has no sender handle but isMe", () => {
    const m = all[1]!;
    assert.equal(m.isFromMe, true);
    assert.equal(m.sender.isMe, true);
    assert.equal(m.sender.handle, undefined);
    assert.equal(m.participants[0]?.handle, "+15550000001");
  });

  it("attachment metadata is attached and contains no local path", () => {
    const m = all[2]!;
    assert.equal(m.attachments.length, 1);
    const a = m.attachments[0]!;
    assert.equal(a.filename, "pic.png");
    assert.equal(a.mimeType, "image/png");
    assert.equal(a.available, true);
    assert.equal(a.willUpload, true);
    assert.equal(a.sizeBytes, 9);
    assert.equal(a.messageGuid, m.messageGuid);
    assert.ok(!JSON.stringify(a).includes("Attachments") && !JSON.stringify(a).includes("Library"), "no path fragments");
    assert.equal(m.text, "with attachment"); // U+FFFC stripped
    assert.equal(m.sender.displayName, "Alice Example"); // email resolved
  });

  it("group chat", () => {
    const m = all[3]!;
    assert.equal(m.chat.isGroup, true);
    assert.equal(m.chat.displayName, "Synthetic Group");
    assert.equal(m.participants.length, 2);
    assert.equal(m.sender.handle, "+15550000002");
  });

  it("reaction (tapback)", () => {
    const m = all[4]!;
    assert.equal(m.kind, "reaction");
    assert.deepEqual(m.reaction, { type: "love", action: "add", targetMessageGuid: synth.guids[0], targetPart: 0 });
  });

  it("group event has no text and a groupEvent block", () => {
    const m = all[5]!;
    assert.equal(m.kind, "group_event");
    assert.equal(m.text, undefined);
    assert.equal(m.groupEvent?.itemType, 3);
  });

  it("edited message carries editedAt", () => {
    assert.equal(all[6]!.editedAt, "2024-01-02T00:00:00.000Z");
  });

  it("legacy text column fallback", () => {
    assert.equal(all[7]!.text, "legacy");
    assert.equal(all[7]!.flags.bodyDecodeFailed, undefined);
  });

  it("SMS service and unknown contact", () => {
    assert.equal(all[8]!.service, "SMS");
    assert.equal(all[8]!.chat.chatGuid, "SMS;-;+15550000009");
    assert.equal(all[8]!.sender.displayName, undefined);
  });

  it("subject preserved", () => {
    assert.equal(all[9]!.subject, "Subj");
  });

  it("payload serialises to plain JSON without Apple blobs", () => {
    const json = JSON.stringify(all);
    assert.ok(!json.includes("attributedBody"));
    assert.ok(!json.includes("streamtyped"));
    assert.ok(!json.includes("ROWID"));
  });

  it("helpers", () => {
    assert.deepEqual(parseAssociatedGuid("p:1/ABCDEF12-0000-0000-0000-000000000000"), { guid: "ABCDEF12-0000-0000-0000-000000000000", part: 1 });
    assert.deepEqual(parseAssociatedGuid("bp:ABCDEF12-0000-0000-0000-000000000000"), { guid: "ABCDEF12-0000-0000-0000-000000000000" });
    assert.equal(parseAssociatedGuid(null), undefined);
    assert.deepEqual(reactionFromType(2003), { type: "laugh", action: "add" });
    assert.deepEqual(reactionFromType(3001), { type: "like", action: "remove" });
    assert.deepEqual(reactionFromType(2007), { type: "unknown:2007", action: "add" });
    assert.equal(reactionFromType(0), undefined);
  });

  it("queries: edits, counts, single row", () => {
    assert.equal(q.countAll(), 10);
    assert.equal(q.maxRowId(), 10);
    assert.equal(q.countRowsAfter(8), 2);
    assert.equal(q.editedSince(0, 10, 10).length, 1);
    assert.equal(q.editedSince(0, 5, 10).length, 0); // rowid 7 excluded by maxRowId
    assert.equal(q.messageByRowId(3)?.guid, synth.guids[2]);
    assert.equal(q.messagesAfter(10, 5).length, 0);
  });
});
