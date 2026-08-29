import { Readable } from "node:stream";
import type { Config } from "../config.js";
import type { Logger } from "../logging/logger.js";
import {
  TransportError,
  type AttachmentUploadMeta,
  type AttachmentUploadResult,
  type BatchRequest,
  type BatchResponse,
  type HeartbeatPayload,
  type ReceiverTransport,
} from "./types.js";

export interface HttpClientOptions {
  baseUrl: string;
  token?: string | undefined;
  cfAccessClientId?: string | undefined;
  cfAccessClientSecret?: string | undefined;
  deviceId: string;
  version: string;
  timeoutMs: number;
  attachmentTimeoutMs: number;
  fetchImpl?: typeof fetch | undefined;
  log?: Logger | undefined;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * HTTPS transport for the receiver contract in docs/receiver-api.md.
 *
 * - Only ever contacts `baseUrl`; redirects are refused (`redirect: "error"`).
 * - Response bodies are never logged.
 * - Auth headers are attached per request and never stored anywhere else.
 */
export class HttpReceiverClient implements ReceiverTransport {
  private readonly fetchImpl: typeof fetch;
  private heartbeatDisabled = false;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static fromConfig(cfg: Config, deviceId: string, version: string, log?: Logger): HttpReceiverClient {
    return new HttpReceiverClient({
      baseUrl: cfg.ingestUrl,
      token: cfg.ingestToken,
      cfAccessClientId: cfg.cfAccessClientId,
      cfAccessClientSecret: cfg.cfAccessClientSecret,
      deviceId,
      version,
      timeoutMs: cfg.httpTimeoutMs,
      attachmentTimeoutMs: cfg.attachmentHttpTimeoutMs,
      log,
    });
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": `imessage-sender/${this.opts.version}`,
      "X-Sender-Device": this.opts.deviceId,
      "X-Sender-Version": this.opts.version,
      Accept: "application/json",
      ...extra,
    };
    if (this.opts.token) h.Authorization = `Bearer ${this.opts.token}`;
    if (this.opts.cfAccessClientId && this.opts.cfAccessClientSecret) {
      h["CF-Access-Client-Id"] = this.opts.cfAccessClientId;
      h["CF-Access-Client-Secret"] = this.opts.cfAccessClientSecret;
    }
    return h;
  }

  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const url = `${this.opts.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (controller.signal.aborted && !signal?.aborted) {
        throw new TransportError("request timed out", "timeout");
      }
      if (signal?.aborted) throw new TransportError("aborted", "network", undefined, true);
      const code = e.cause?.code ?? (e as { code?: string }).code;
      throw new TransportError(`network error${code ? ` (${code})` : ""}: ${e.message.slice(0, 120)}`, "network");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private static httpError(res: Response, what: string): TransportError {
    const retryable = RETRYABLE_STATUS.has(res.status) || res.status === 401 || res.status === 403;
    return new TransportError(`${what}: HTTP ${res.status}`, "http", res.status, retryable);
  }

  async sendBatch(batch: BatchRequest, signal?: AbortSignal): Promise<BatchResponse> {
    const res = await this.request(
      "/v1/messages/batch",
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", "Idempotency-Key": batch.batchId }),
        body: JSON.stringify(batch),
      },
      this.opts.timeoutMs,
      signal,
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw HttpReceiverClient.httpError(res, "batch rejected");
    }
    let parsed: BatchResponse | undefined;
    try {
      const text = await res.text();
      parsed = text.trim() ? (JSON.parse(text) as BatchResponse) : { ok: true };
    } catch {
      throw new TransportError("batch response was not valid JSON", "http", res.status, true);
    }
    if (parsed.ok === false) throw new TransportError("receiver reported ok:false", "http", res.status, true);
    return { ...parsed, ok: true };
  }

  async uploadAttachment(meta: AttachmentUploadMeta, body: () => NodeJS.ReadableStream, signal?: AbortSignal): Promise<AttachmentUploadResult> {
    const encodedMeta = Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
    const stream = Readable.toWeb(Readable.from(body())) as unknown as ReadableStream;
    const res = await this.request(
      `/v1/attachments/${encodeURIComponent(meta.attachmentGuid)}`,
      {
        method: "PUT",
        headers: this.headers({
          "Content-Type": meta.mimeType ?? "application/octet-stream",
          "Content-Length": String(meta.sizeBytes),
          "X-Attachment-Meta": encodedMeta,
          "X-Content-Sha256": meta.sha256,
        }),
        body: stream,
        duplex: "half",
      },
      this.opts.attachmentTimeoutMs,
      signal,
    );
    await res.body?.cancel().catch(() => undefined);
    if (res.ok) return { status: "ok" };
    if (res.status === 409) return { status: "exists" };
    if (RETRYABLE_STATUS.has(res.status) || res.status === 401 || res.status === 403) {
      throw HttpReceiverClient.httpError(res, "attachment upload failed");
    }
    return { status: "rejected", httpStatus: res.status };
  }

  async attachmentExists(attachmentGuid: string, signal?: AbortSignal): Promise<boolean | undefined> {
    try {
      const res = await this.request(`/v1/attachments/${encodeURIComponent(attachmentGuid)}`, { method: "HEAD", headers: this.headers() }, this.opts.timeoutMs, signal);
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) return true;
      if (res.status === 404) return false;
      return undefined;
    } catch {
      return undefined;
    }
  }

  async heartbeat(payload: HeartbeatPayload, signal?: AbortSignal): Promise<void> {
    if (this.heartbeatDisabled) return;
    const res = await this.request(
      "/v1/heartbeat",
      { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: JSON.stringify(payload) },
      this.opts.timeoutMs,
      signal,
    );
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404 || res.status === 405) {
      this.heartbeatDisabled = true;
      this.opts.log?.info("heartbeat_unsupported", { status: res.status });
      return;
    }
    if (!res.ok) throw HttpReceiverClient.httpError(res, "heartbeat failed");
  }
}

/** Transport that refuses to send anything; used for IMESSAGE_DRY_RUN. */
export class DryRunTransport implements ReceiverTransport {
  sent = 0;
  uploaded = 0;
  async sendBatch(batch: BatchRequest): Promise<BatchResponse> {
    this.sent += batch.messages.length;
    return { ok: true, received: batch.messages.length, attachments: { wanted: [] } };
  }
  async uploadAttachment(): Promise<AttachmentUploadResult> {
    this.uploaded++;
    return { status: "ok" };
  }
}
