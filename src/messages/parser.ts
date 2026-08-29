/**
 * Extract the plain-text body from Apple's `attributedBody` blob.
 *
 * The blob is a NeXT "typedstream" (`\x04\x0bstreamtyped`) serialisation of an
 * NSMutableAttributedString. The string payload is an NSString/NSMutableString object whose
 * bytes follow a `+` (0x2B) type marker and a typedstream integer length:
 *   0x00–0x7F        → that byte is the length
 *   0x81 LL LL       → uint16 little-endian
 *   0x82 LL LL LL LL → uint32 little-endian
 *
 * Verified against 50,115 / 50,115 rows on the target machine (docs/findings.md). If anything
 * about the layout is unexpected the function returns undefined so the caller can fall back to
 * the `text` column and flag the row — nothing is guessed.
 */

const STREAM_MAGIC = Buffer.from("streamtyped", "latin1");
const MARKERS = [Buffer.from("NSMutableString", "latin1"), Buffer.from("NSString", "latin1")];

export interface ParsedBody {
  text: string;
}

export function decodeAttributedBody(blob: Uint8Array | Buffer | null | undefined): ParsedBody | undefined {
  if (!blob || blob.length < 16) return undefined;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (buf.indexOf(STREAM_MAGIC, 0) < 0) return undefined;

  let classPos = -1;
  let classLen = 0;
  for (const m of MARKERS) {
    const idx = buf.indexOf(m);
    if (idx >= 0 && (classPos < 0 || idx < classPos)) {
      classPos = idx;
      classLen = m.length;
    }
  }
  if (classPos < 0) return undefined;

  // The '+' type marker follows the class record within a few bytes.
  const searchStart = classPos + classLen;
  const plus = buf.indexOf(0x2b, searchStart);
  if (plus < 0 || plus - searchStart > 64) return undefined;

  let pos = plus + 1;
  if (pos >= buf.length) return undefined;
  let length: number;
  const first = buf[pos]!;
  if (first === 0x81) {
    if (pos + 3 > buf.length) return undefined;
    length = buf.readUInt16LE(pos + 1);
    pos += 3;
  } else if (first === 0x82) {
    if (pos + 5 > buf.length) return undefined;
    length = buf.readUInt32LE(pos + 1);
    pos += 5;
  } else if (first < 0x80) {
    length = first;
    pos += 1;
  } else {
    return undefined;
  }
  if (pos + length > buf.length) return undefined;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(pos, pos + length));
    return { text };
  } catch {
    return undefined;
  }
}

/** U+FFFC object replacement characters mark attachment positions; they are noise for consumers. */
export function stripAttachmentPlaceholders(text: string): string {
  return text.replace(/￼/g, "").replace(/�/g, "").trim();
}

export interface BodyResult {
  text: string | undefined;
  decodeFailed: boolean;
}

/** Choose the best available body: attributedBody first, `text` column as fallback. */
export function resolveBody(text: string | null | undefined, attributedBody: Uint8Array | null | undefined): BodyResult {
  const decoded = attributedBody ? decodeAttributedBody(attributedBody) : undefined;
  if (decoded) {
    const cleaned = stripAttachmentPlaceholders(decoded.text);
    return { text: cleaned.length > 0 ? cleaned : undefined, decodeFailed: false };
  }
  const decodeFailed = !!attributedBody && attributedBody.length > 0;
  if (text && text.trim().length > 0) {
    const cleaned = stripAttachmentPlaceholders(text);
    return { text: cleaned.length > 0 ? cleaned : undefined, decodeFailed };
  }
  return { text: undefined, decodeFailed };
}
