import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { RawAttachmentRow } from "../messages/types.js";
import type { AttachmentMetadata } from "../transport/types.js";
import { appleTimeToIso } from "../util/time.js";

export interface AttachmentReaderOptions {
  attachmentsDir: string; // ~/Library/Messages/Attachments (expanded)
  maxBytes: number;
  uploadHidden: boolean;
  uploadStickers: boolean;
  homeDir?: string;
}

export interface LocatedAttachment {
  path?: string | undefined;
  exists: boolean;
  sizeBytes?: number;
  isTempFile: boolean;
}

const UTI_MIME: Record<string, string> = {
  "public.heic": "image/heic",
  "public.heif": "image/heif",
  "public.heics": "image/heic-sequence",
  "public.jpeg": "image/jpeg",
  "public.png": "image/png",
  "com.compuserve.gif": "image/gif",
  "public.tiff": "image/tiff",
  "org.webmproject.webp": "image/webp",
  "public.avif": "image/avif",
  "com.apple.quicktime-movie": "video/quicktime",
  "public.mpeg-4": "video/mp4",
  "public.mp4": "video/mp4",
  "com.apple.m4a-audio": "audio/x-m4a",
  "com.apple.coreaudio-format": "audio/x-caf",
  "public.mp3": "audio/mpeg",
  "com.adobe.pdf": "application/pdf",
  "public.zip-archive": "application/zip",
  "public.vcard": "text/vcard",
  "public.plain-text": "text/plain",
  "public.vlocation": "text/x-vlocation",
  "com.microsoft.word.doc": "application/msword",
};

const EXT_MIME: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
  heics: "image/heic-sequence",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  tiff: "image/tiff",
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  m4a: "audio/x-m4a",
  caf: "audio/x-caf",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  wav: "audio/wav",
  pdf: "application/pdf",
  zip: "application/zip",
  vcf: "text/vcard",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pluginpayloadattachment: "application/vnd.apple.messages.plugin-payload",
};

export function guessMime(row: { mime_type: string | null; uti: string | null; filename: string | null; transfer_name: string | null }): string | undefined {
  if (row.mime_type) return row.mime_type;
  if (row.uti && UTI_MIME[row.uti]) return UTI_MIME[row.uti];
  const name = row.transfer_name ?? row.filename ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return ext ? EXT_MIME[ext] : undefined;
}

export class AttachmentReader {
  private readonly home: string;
  private readonly attachmentsDir: string;

  constructor(private readonly opts: AttachmentReaderOptions) {
    this.home = opts.homeDir ?? homedir();
    this.attachmentsDir = resolve(opts.attachmentsDir);
  }

  /**
   * Map Apple's stored filename to a real path. Only paths inside the configured attachments
   * directory are ever opened; anything else (e.g. /var/folders transcoding temp files) is
   * reported as unavailable. This is both a robustness and a containment rule.
   */
  locate(filename: string | null): LocatedAttachment {
    if (!filename) return { exists: false, isTempFile: false };
    let p = filename;
    if (p.startsWith("~/")) p = resolve(this.home, p.slice(2));
    const isTempFile = /^\/(private\/)?var\/folders\//.test(p) || p.startsWith("/private/tmp/");
    const abs = resolve(p);
    // Re-root any "<something>/Library/Messages/Attachments/..." path onto the configured dir
    const marker = `${sep}Library${sep}Messages${sep}Attachments${sep}`;
    const idx = abs.indexOf(marker);
    const candidate = idx >= 0 ? resolve(this.attachmentsDir, abs.slice(idx + marker.length)) : abs;
    if (!candidate.startsWith(this.attachmentsDir + sep)) {
      return { exists: false, isTempFile, path: undefined };
    }
    try {
      const st = statSync(candidate);
      if (!st.isFile()) return { exists: false, isTempFile, path: candidate };
      return { exists: true, sizeBytes: st.size, isTempFile, path: candidate };
    } catch {
      return { exists: false, isTempFile, path: candidate };
    }
  }

  /** Build wire metadata (no local paths). Decides whether bytes will be uploaded. */
  describe(row: RawAttachmentRow, messageGuid: string): AttachmentMetadata & { localPath?: string | undefined } {
    const located = this.locate(row.filename);
    const isSticker = row.is_sticker === 1;
    const isHidden = row.hide_attachment === 1;
    const name = row.transfer_name ?? (row.filename ? basename(row.filename) : undefined);
    const dbSize = row.total_bytes === null || row.total_bytes === undefined ? undefined : Number(row.total_bytes);
    const size = located.sizeBytes ?? (dbSize && dbSize > 0 ? dbSize : undefined);
    const meta: AttachmentMetadata & { localPath?: string | undefined } = {
      attachmentGuid: row.guid,
      sourceRowId: row.rowid,
      messageGuid,
      isSticker,
      isHidden,
      available: located.exists,
      willUpload: false,
    };
    if (name) meta.filename = name;
    const mime = guessMime(row);
    if (mime) meta.mimeType = mime;
    if (row.uti) meta.uti = row.uti;
    if (size !== undefined) meta.sizeBytes = size;
    const created = appleTimeToIso(row.created_date);
    if (created) meta.createdAt = created;

    if (!located.exists) {
      meta.skippedReason = located.isTempFile ? "temp_file" : "missing";
    } else if (isHidden && !this.opts.uploadHidden) {
      meta.skippedReason = "hidden";
    } else if (isSticker && !this.opts.uploadStickers) {
      meta.skippedReason = "sticker";
    } else if (this.opts.maxBytes > 0 && (located.sizeBytes ?? 0) > this.opts.maxBytes) {
      meta.skippedReason = "too_large";
    } else {
      meta.willUpload = true;
      meta.localPath = located.path;
    }
    return meta;
  }

  /** Streaming SHA-256 of a file; never loads it fully into memory. */
  async sha256(path: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(path);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolvePromise(hash.digest("hex")));
    });
  }

  openStream(path: string): NodeJS.ReadableStream {
    return createReadStream(path);
  }
}
