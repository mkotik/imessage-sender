import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AttachmentReader, guessMime } from "../src/attachments/reader.js";
import type { RawAttachmentRow } from "../src/messages/types.js";

function row(over: Partial<RawAttachmentRow>): RawAttachmentRow {
  return {
    rowid: 1,
    guid: "ATT-1",
    original_guid: "ATT-1",
    message_rowid: 10,
    filename: null,
    uti: null,
    mime_type: null,
    transfer_name: null,
    total_bytes: 0,
    is_sticker: 0,
    hide_attachment: 0,
    transfer_state: 5,
    is_outgoing: 0,
    created_date: 0,
    ...over,
  };
}

describe("AttachmentReader", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const attDir = join(home, "Library", "Messages", "Attachments");
  const sub = join(attDir, "ab", "cd", "GUID-1");
  mkdirSync(sub, { recursive: true });
  const bytes = Buffer.alloc(5000, 7);
  writeFileSync(join(sub, "photo.heic"), bytes);
  writeFileSync(join(sub, "big.mov"), Buffer.alloc(20_000, 1));
  after(() => rmSync(home, { recursive: true, force: true }));

  const reader = new AttachmentReader({ attachmentsDir: attDir, maxBytes: 10_000, uploadHidden: false, uploadStickers: true, homeDir: home });

  it("existing attachment: resolves ~ path, sizes, mime, marks for upload", () => {
    const meta = reader.describe(row({ filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/photo.heic", uti: "public.heic", transfer_name: "IMG_1.heic" }), "MSG-1");
    assert.equal(meta.available, true);
    assert.equal(meta.willUpload, true);
    assert.equal(meta.sizeBytes, 5000);
    assert.equal(meta.filename, "IMG_1.heic");
    assert.equal(meta.mimeType, "image/heic");
    assert.equal(meta.uti, "public.heic");
    assert.equal(meta.localPath, join(sub, "photo.heic"));
    assert.equal(meta.messageGuid, "MSG-1");
    assert.equal(meta.skippedReason, undefined);
  });

  it("absolute /Users/... path is re-rooted onto the configured dir", () => {
    const meta = reader.describe(row({ filename: "/Users/someone/Library/Messages/Attachments/ab/cd/GUID-1/photo.heic" }), "M");
    assert.equal(meta.available, true);
  });

  it("missing attachment: metadata only, no crash", () => {
    const meta = reader.describe(row({ filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/gone.jpg", total_bytes: 123 }), "M");
    assert.equal(meta.available, false);
    assert.equal(meta.willUpload, false);
    assert.equal(meta.skippedReason, "missing");
    assert.equal(meta.sizeBytes, 123);
    assert.equal(meta.localPath, undefined);
  });

  it("null filename", () => {
    const meta = reader.describe(row({ filename: null }), "M");
    assert.equal(meta.available, false);
    assert.equal(meta.filename, undefined);
  });

  it("temp transcoding files are reported as temp_file", () => {
    const meta = reader.describe(row({ filename: "/var/folders/zz/T/com.apple.imtranscoding.X/clip.mov" }), "M");
    assert.equal(meta.skippedReason, "temp_file");
  });

  it("paths outside the attachments dir are never opened", () => {
    writeFileSync(join(home, "secret.txt"), "x");
    const meta = reader.describe(row({ filename: join(home, "secret.txt") }), "M");
    assert.equal(meta.available, false);
    const meta2 = reader.describe(row({ filename: "~/Library/Messages/Attachments/../../../secret.txt" }), "M");
    assert.equal(meta2.available, false);
  });

  it("large attachment: metadata sent, bytes skipped", () => {
    const meta = reader.describe(row({ filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/big.mov", uti: "com.apple.quicktime-movie" }), "M");
    assert.equal(meta.available, true);
    assert.equal(meta.willUpload, false);
    assert.equal(meta.skippedReason, "too_large");
    assert.equal(meta.sizeBytes, 20_000);
    assert.equal(meta.mimeType, "video/quicktime");
  });

  it("hidden (plugin payload) attachments are skipped unless enabled", () => {
    writeFileSync(join(sub, "x.pluginPayloadAttachment"), "p");
    const r = row({ filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/x.pluginPayloadAttachment", hide_attachment: 1, uti: "dyn.age81a5dzq7y066dbtf0g82peqf4hk2pdrb00n5xy" });
    assert.equal(reader.describe(r, "M").skippedReason, "hidden");
    const permissive = new AttachmentReader({ attachmentsDir: attDir, maxBytes: 10_000, uploadHidden: true, uploadStickers: true, homeDir: home });
    assert.equal(permissive.describe(r, "M").willUpload, true);
    assert.equal(permissive.describe(r, "M").mimeType, "application/vnd.apple.messages.plugin-payload");
  });

  it("stickers honour the toggle", () => {
    const r = row({ filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/photo.heic", is_sticker: 1 });
    assert.equal(reader.describe(r, "M").isSticker, true);
    assert.equal(reader.describe(r, "M").willUpload, true);
    const noStickers = new AttachmentReader({ attachmentsDir: attDir, maxBytes: 10_000, uploadHidden: false, uploadStickers: false, homeDir: home });
    assert.equal(noStickers.describe(r, "M").skippedReason, "sticker");
  });

  it("unsupported / unknown type still gets metadata", () => {
    writeFileSync(join(sub, "blob.xyz"), "?");
    const meta = reader.describe(row({ filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/blob.xyz" }), "M");
    assert.equal(meta.mimeType, undefined);
    assert.equal(meta.willUpload, true);
  });

  it("mime guessing precedence: column > uti > extension", () => {
    assert.equal(guessMime({ mime_type: "image/webp", uti: "public.png", filename: "a.jpg", transfer_name: null }), "image/webp");
    assert.equal(guessMime({ mime_type: null, uti: "public.png", filename: "a.jpg", transfer_name: null }), "image/png");
    assert.equal(guessMime({ mime_type: null, uti: null, filename: "a.JPG", transfer_name: null }), "image/jpeg");
    assert.equal(guessMime({ mime_type: null, uti: null, filename: null, transfer_name: "Audio Message.caf" }), "audio/x-caf");
    assert.equal(guessMime({ mime_type: null, uti: null, filename: "noext", transfer_name: null }), undefined);
  });

  it("streams sha256", async () => {
    const h = await reader.sha256(join(sub, "photo.heic"));
    assert.equal(h, createHash("sha256").update(bytes).digest("hex"));
  });

  it("multiple attachments per message are independent", () => {
    const rows = [
      row({ rowid: 1, guid: "A", filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/photo.heic" }),
      row({ rowid: 2, guid: "B", filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/gone.jpg" }),
      row({ rowid: 3, guid: "C", filename: "~/Library/Messages/Attachments/ab/cd/GUID-1/big.mov" }),
    ];
    const metas = rows.map((r) => reader.describe(r, "M"));
    assert.deepEqual(
      metas.map((m) => [m.attachmentGuid, m.willUpload, m.skippedReason]),
      [
        ["A", true, undefined],
        ["B", false, "missing"],
        ["C", false, "too_large"],
      ],
    );
  });
});
