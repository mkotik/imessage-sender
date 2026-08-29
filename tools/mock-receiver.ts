/**
 * Mock receiver implementing docs/receiver-api.md. Used by tests and for local end-to-end runs.
 *
 *   npm run mock-receiver -- [--port 8787] [--token secret] [--fail-every 3] [--reject-once] [--slow 2000]
 *
 * Everything is kept in memory. `GET /__stats` returns counts; `GET /__dump` returns received
 * messages (local development only). `POST /__reset` clears. The receiver also runs a naive
 * OTP-leak scan over everything it receives and reports `otpLikeTexts` in stats — that number
 * must stay 0 when the sender is working.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export interface MockReceiverOptions {
  port?: number;
  token?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  /** Fail (503) every Nth batch request. 0 = never. */
  failEvery?: number;
  /** Reject the first batch with this status once (e.g. 400), then behave. */
  rejectOnce?: number;
  /** Hang requests for this many ms (to trigger client timeouts). */
  slowMs?: number;
  /** Return `attachments.wanted` = [] for every batch (receiver "already has everything"). */
  wantNoAttachments?: boolean;
  /** Reject attachments larger than this with 413. */
  maxAttachmentBytes?: number;
  /** Drop the TCP connection instead of answering (simulates network loss). */
  dropConnections?: boolean;
  quiet?: boolean;
}

export interface MockReceiverStats {
  batches: number;
  batchIds: string[];
  messages: number;
  uniqueMessageGuids: number;
  duplicateMessages: number;
  attachments: number;
  attachmentBytes: number;
  heartbeats: number;
  failuresInjected: number;
  otpLikeTexts: number;
  phases: Record<string, number>;
}

const OTP_LEAK_SCAN = /\b(verification|security|login|one[-\s]?time|2fa|otp|passcode)\b|\bG-\d{6}\b|\b\d{6}\b/i;

export interface MockReceiver {
  server: Server;
  url: string;
  port: number;
  stats(): MockReceiverStats;
  messages(): Map<string, unknown>;
  attachments(): Map<string, { bytes: number; sha256: string; meta: unknown }>;
  reset(): void;
  setOptions(patch: Partial<MockReceiverOptions>): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

export async function startMockReceiver(options: MockReceiverOptions = {}): Promise<MockReceiver> {
  let opts = { ...options };
  const messages = new Map<string, unknown>();
  const attachments = new Map<string, { bytes: number; sha256: string; meta: unknown }>();
  const stats: MockReceiverStats = { batches: 0, batchIds: [], messages: 0, uniqueMessageGuids: 0, duplicateMessages: 0, attachments: 0, attachmentBytes: 0, heartbeats: 0, failuresInjected: 0, otpLikeTexts: 0, phases: {} };
  let batchCounter = 0;
  let rejectedOnce = false;
  const reset = () => {
    messages.clear();
    attachments.clear();
    batchCounter = 0;
    rejectedOnce = false;
    Object.assign(stats, { batches: 0, batchIds: [], messages: 0, uniqueMessageGuids: 0, duplicateMessages: 0, attachments: 0, attachmentBytes: 0, heartbeats: 0, failuresInjected: 0, otpLikeTexts: 0, phases: {} });
  };
  const log = (s: string) => {
    if (!opts.quiet) process.stdout.write(`[mock-receiver] ${s}\n`);
  };

  const authorized = (req: IncomingMessage): boolean => {
    if (opts.token) {
      if (req.headers.authorization !== `Bearer ${opts.token}`) return false;
    }
    if (opts.cfAccessClientId) {
      if (req.headers["cf-access-client-id"] !== opts.cfAccessClientId || req.headers["cf-access-client-secret"] !== opts.cfAccessClientSecret) return false;
    }
    return true;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // control endpoints (no auth)
      if (path === "/__stats") return json(res, 200, stats);
      if (path === "/__dump") return json(res, 200, { messages: [...messages.values()], attachments: [...attachments.entries()] });
      if (path === "/__reset" && req.method === "POST") {
        reset();
        return json(res, 200, { ok: true });
      }

      if (opts.dropConnections) {
        stats.failuresInjected++;
        req.socket.destroy();
        return;
      }
      if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

      if (path === "/v1/messages/batch" && req.method === "POST") {
        batchCounter++;
        if (opts.rejectOnce && !rejectedOnce) {
          rejectedOnce = true;
          stats.failuresInjected++;
          await readBody(req);
          return json(res, opts.rejectOnce, { error: "injected rejection" });
        }
        if (opts.failEvery && batchCounter % opts.failEvery === 0) {
          stats.failuresInjected++;
          await readBody(req);
          return json(res, 503, { error: "injected failure" });
        }
        const body = JSON.parse((await readBody(req)).toString("utf8")) as { batchId: string; phase: string; messages: Array<{ messageGuid: string; text?: string; attachments?: Array<{ attachmentGuid: string; willUpload: boolean }> }> };
        stats.batches++;
        stats.batchIds.push(body.batchId);
        stats.phases[body.phase] = (stats.phases[body.phase] ?? 0) + 1;
        const wanted: string[] = [];
        for (const m of body.messages) {
          stats.messages++;
          if (messages.has(m.messageGuid)) stats.duplicateMessages++;
          messages.set(m.messageGuid, m);
          if (m.text && OTP_LEAK_SCAN.test(m.text)) stats.otpLikeTexts++;
          for (const a of m.attachments ?? []) if (a.willUpload && !attachments.has(a.attachmentGuid)) wanted.push(a.attachmentGuid);
        }
        stats.uniqueMessageGuids = messages.size;
        log(`batch ${body.batchId.slice(0, 8)} phase=${body.phase} messages=${body.messages.length} wanted=${wanted.length}`);
        return json(res, 200, { ok: true, received: body.messages.length, attachments: { wanted: opts.wantNoAttachments ? [] : wanted } });
      }

      const attMatch = /^\/v1\/attachments\/([^/]+)$/.exec(path);
      if (attMatch) {
        const guid = decodeURIComponent(attMatch[1]!);
        if (req.method === "HEAD") {
          res.writeHead(attachments.has(guid) ? 200 : 404);
          return res.end();
        }
        if (req.method === "PUT") {
          const metaHeader = req.headers["x-attachment-meta"];
          const meta = typeof metaHeader === "string" ? JSON.parse(Buffer.from(metaHeader, "base64").toString("utf8")) : undefined;
          const body = await readBody(req);
          if (opts.maxAttachmentBytes && body.length > opts.maxAttachmentBytes) return json(res, 413, { error: "too large" });
          if (attachments.has(guid)) return json(res, 409, { error: "exists" });
          const sha256 = createHash("sha256").update(body).digest("hex");
          const declared = req.headers["x-content-sha256"];
          if (declared && declared !== sha256) return json(res, 400, { error: "sha256 mismatch" });
          attachments.set(guid, { bytes: body.length, sha256, meta });
          stats.attachments++;
          stats.attachmentBytes += body.length;
          log(`attachment ${guid.slice(0, 8)} ${body.length} bytes`);
          return json(res, 201, { ok: true, sha256 });
        }
      }

      if (path === "/v1/heartbeat" && req.method === "POST") {
        await readBody(req);
        stats.heartbeats++;
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  log(`listening on ${url}`);
  return {
    server,
    url,
    port,
    stats: () => stats,
    messages: () => messages,
    attachments: () => attachments,
    reset,
    setOptions: (patch) => {
      opts = { ...opts, ...patch };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const val = (flag: string) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  const opts: MockReceiverOptions = { port: Number(val("--port") ?? 8787) };
  const tok = val("--token");
  if (tok) opts.token = tok;
  if (val("--fail-every")) opts.failEvery = Number(val("--fail-every"));
  if (val("--reject-once")) opts.rejectOnce = Number(val("--reject-once"));
  if (val("--slow")) opts.slowMs = Number(val("--slow"));
  if (a.includes("--drop")) opts.dropConnections = true;
  startMockReceiver(opts).then((r) => {
    process.stdout.write(`mock receiver ready at ${r.url}\n  stats: ${r.url}/__stats\n`);
  });
}
