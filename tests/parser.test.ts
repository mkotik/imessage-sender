import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeAttributedBody, resolveBody, stripAttachmentPlaceholders } from "../src/messages/parser.js";
import { encodeAttributedBody } from "../tools/synthetic.js";
import { appleTimeToIso, appleTimeToUnixMs, unixMsToAppleNs, APPLE_EPOCH_MS } from "../src/util/time.js";

describe("attributedBody decoder", () => {
  it("decodes a short string", () => {
    assert.equal(decodeAttributedBody(encodeAttributedBody("hello"))?.text, "hello");
  });
  it("decodes an empty string", () => {
    assert.equal(decodeAttributedBody(encodeAttributedBody(""))?.text, "");
  });
  it("decodes unicode / emoji", () => {
    const s = "héllo 👋 — “quotes” 日本語";
    assert.equal(decodeAttributedBody(encodeAttributedBody(s))?.text, s);
  });
  it("decodes a 0x81 (uint16) length", () => {
    const s = "x".repeat(300);
    assert.equal(decodeAttributedBody(encodeAttributedBody(s))?.text, s);
  });
  it("decodes a 0x82 (uint32) length", () => {
    const s = "y".repeat(70_000);
    assert.equal(decodeAttributedBody(encodeAttributedBody(s))?.text, s);
  });
  it("decodes exactly 127 and 128 byte payloads (length-encoding boundary)", () => {
    for (const n of [127, 128, 255, 256]) {
      const s = "z".repeat(n);
      assert.equal(decodeAttributedBody(encodeAttributedBody(s))?.text, s, `len ${n}`);
    }
  });
  it("returns undefined for garbage", () => {
    assert.equal(decodeAttributedBody(Buffer.from("definitely not a typedstream, just text")), undefined);
    assert.equal(decodeAttributedBody(Buffer.alloc(0)), undefined);
    assert.equal(decodeAttributedBody(null), undefined);
  });
  it("returns undefined when the length overruns the buffer", () => {
    const b = encodeAttributedBody("hello world");
    const truncated = b.subarray(0, b.indexOf(Buffer.from("hello")) + 3);
    assert.equal(decodeAttributedBody(truncated), undefined);
  });
  it("returns undefined on invalid UTF-8 instead of guessing", () => {
    const b = Buffer.from(encodeAttributedBody("abcd"));
    const i = b.indexOf(Buffer.from("abcd"));
    b[i] = 0xff;
    b[i + 1] = 0xfe;
    assert.equal(decodeAttributedBody(b), undefined);
  });
});

describe("resolveBody", () => {
  it("prefers attributedBody", () => {
    const r = resolveBody("column text", encodeAttributedBody("body text"));
    assert.equal(r.text, "body text");
    assert.equal(r.decodeFailed, false);
  });
  it("falls back to the text column when body missing", () => {
    assert.deepEqual(resolveBody("column text", null), { text: "column text", decodeFailed: false });
  });
  it("flags decode failure and falls back", () => {
    const r = resolveBody("column text", Buffer.from("garbage garbage garbage"));
    assert.equal(r.text, "column text");
    assert.equal(r.decodeFailed, true);
  });
  it("strips U+FFFC placeholders and yields undefined for attachment-only messages", () => {
    assert.equal(stripAttachmentPlaceholders("￼"), "");
    assert.equal(stripAttachmentPlaceholders("￼ caption"), "caption");
    assert.equal(resolveBody(null, encodeAttributedBody("￼")).text, undefined);
  });
  it("both empty → undefined text, not flagged", () => {
    assert.deepEqual(resolveBody(null, null), { text: undefined, decodeFailed: false });
  });
});

describe("Apple time conversion", () => {
  it("converts nanoseconds since 2001", () => {
    const unix = Date.UTC(2024, 5, 1, 12, 0, 0);
    assert.equal(appleTimeToUnixMs(unixMsToAppleNs(unix)), unix);
    assert.equal(appleTimeToIso(unixMsToAppleNs(unix)), "2024-06-01T12:00:00.000Z");
  });
  it("accepts BigInt", () => {
    const unix = Date.UTC(2024, 5, 1);
    assert.equal(appleTimeToUnixMs(BigInt(unixMsToAppleNs(unix))), unix);
  });
  it("handles legacy seconds", () => {
    assert.equal(appleTimeToUnixMs(0), undefined);
    assert.equal(appleTimeToUnixMs(86400), APPLE_EPOCH_MS + 86_400_000);
  });
  it("0/null → undefined", () => {
    assert.equal(appleTimeToIso(null), undefined);
    assert.equal(appleTimeToIso(0), undefined);
  });
});
