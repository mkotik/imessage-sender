import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createServer, type Server } from "node:http";
import { HttpReceiverClient } from "../src/transport/client.js";
import { TransportError, type BatchRequest } from "../src/transport/types.js";
import { startMockReceiver, type MockReceiver } from "../tools/mock-receiver.js";

function batch(n = 1): BatchRequest {
  return {
    schemaVersion: 1,
    batchId: "b-" + n,
    deviceId: "dev",
    phase: "backfill",
    sentAt: new Date().toISOString(),
    range: { firstRowId: 1, lastRowId: n },
    messages: [],
  };
}

describe("HttpReceiverClient against the mock receiver", () => {
  let mock: MockReceiver;
  let client: HttpReceiverClient;
  before(async () => {
    mock = await startMockReceiver({ token: "tok", quiet: true });
    client = new HttpReceiverClient({ baseUrl: mock.url, token: "tok", deviceId: "dev", version: "t", timeoutMs: 2000, attachmentTimeoutMs: 2000 });
  });
  after(() => mock.close());

  it("success", async () => {
    const res = await client.sendBatch(batch());
    assert.equal(res.ok, true);
    assert.equal(mock.stats().batches, 1);
  });

  it("401 is an http error flagged retryable (config may be fixed) and never silently accepted", async () => {
    const bad = new HttpReceiverClient({ baseUrl: mock.url, token: "wrong", deviceId: "dev", version: "t", timeoutMs: 2000, attachmentTimeoutMs: 2000 });
    await assert.rejects(bad.sendBatch(batch()), (e: TransportError) => e.kind === "http" && e.status === 401 && e.retryable === true);
  });

  it("4xx rejection is non-retryable", async () => {
    mock.setOptions({ rejectOnce: 400 });
    await assert.rejects(client.sendBatch(batch()), (e: TransportError) => e.kind === "http" && e.status === 400 && e.retryable === false);
    mock.setOptions({ rejectOnce: 0 });
  });

  it("5xx is retryable", async () => {
    mock.setOptions({ failEvery: 1 });
    await assert.rejects(client.sendBatch(batch()), (e: TransportError) => e.status === 503 && e.retryable === true);
    mock.setOptions({ failEvery: 0 });
  });

  it("timeout", async () => {
    mock.setOptions({ slowMs: 500 });
    const fast = new HttpReceiverClient({ baseUrl: mock.url, token: "tok", deviceId: "dev", version: "t", timeoutMs: 100, attachmentTimeoutMs: 100 });
    await assert.rejects(fast.sendBatch(batch()), (e: TransportError) => e.kind === "timeout" && e.retryable === true);
    mock.setOptions({ slowMs: 0 });
  });

  it("connection dropped → network error", async () => {
    mock.setOptions({ dropConnections: true });
    await assert.rejects(client.sendBatch(batch()), (e: TransportError) => e.kind === "network" && e.retryable === true);
    mock.setOptions({ dropConnections: false });
  });

  it("network unavailable (nothing listening)", async () => {
    const dead = new HttpReceiverClient({ baseUrl: "http://127.0.0.1:1", deviceId: "dev", version: "t", timeoutMs: 1000, attachmentTimeoutMs: 1000 });
    await assert.rejects(dead.sendBatch(batch()), (e: TransportError) => e.kind === "network");
  });

  it("attachment upload: ok, then 409 exists, HEAD works", async () => {
    const body = Buffer.from("attachment bytes");
    const sha = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    const meta = { attachmentGuid: "ATT-1", messageGuid: "M", filename: "a.bin", sizeBytes: body.length, sha256: sha, isSticker: false, isHidden: false };
    const r1 = await client.uploadAttachment(meta, () => Readable.from([body]));
    assert.deepEqual(r1, { status: "ok" });
    assert.equal(mock.attachments().get("ATT-1")?.sha256, sha);
    assert.deepEqual((mock.attachments().get("ATT-1")?.meta as { filename: string }).filename, "a.bin");
    const r2 = await client.uploadAttachment(meta, () => Readable.from([body]));
    assert.deepEqual(r2, { status: "exists" });
    assert.equal(await client.attachmentExists("ATT-1"), true);
    assert.equal(await client.attachmentExists("nope"), false);
  });

  it("attachment 413 → rejected (permanent)", async () => {
    mock.setOptions({ maxAttachmentBytes: 4 });
    const body = Buffer.from("too big!");
    const r = await client.uploadAttachment({ attachmentGuid: "ATT-2", messageGuid: "M", sizeBytes: body.length, sha256: "x", isSticker: false, isHidden: false }, () => Readable.from([body]));
    assert.deepEqual(r, { status: "rejected", httpStatus: 413 });
    mock.setOptions({ maxAttachmentBytes: 0 });
  });

  it("heartbeat", async () => {
    await client.heartbeat({ deviceId: "dev", version: "t", at: new Date().toISOString(), phase: "idle", lastAckedRowId: 0, pendingAttachments: 0, backfillComplete: false });
    assert.equal(mock.stats().heartbeats, 1);
  });

  it("CF Access service token headers are sent", async () => {
    const cf = await startMockReceiver({ cfAccessClientId: "id1", cfAccessClientSecret: "sec1", quiet: true });
    try {
      const c = new HttpReceiverClient({ baseUrl: cf.url, cfAccessClientId: "id1", cfAccessClientSecret: "sec1", deviceId: "dev", version: "t", timeoutMs: 1000, attachmentTimeoutMs: 1000 });
      assert.equal((await c.sendBatch(batch())).ok, true);
      const wrong = new HttpReceiverClient({ baseUrl: cf.url, cfAccessClientId: "id1", cfAccessClientSecret: "nope", deviceId: "dev", version: "t", timeoutMs: 1000, attachmentTimeoutMs: 1000 });
      await assert.rejects(wrong.sendBatch(batch()), (e: TransportError) => e.status === 401);
    } finally {
      await cf.close();
    }
  });
});

describe("HttpReceiverClient safety", () => {
  let server: Server;
  let url: string;
  let seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      if (req.url === "/v1/messages/batch") {
        res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
        return res.end();
      }
      if (req.url === "/v1/heartbeat") {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json{");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());

  it("refuses redirects (only ever talks to the configured host)", async () => {
    const c = new HttpReceiverClient({ baseUrl: url, token: "t", deviceId: "dev", version: "t", timeoutMs: 1000, attachmentTimeoutMs: 1000 });
    await assert.rejects(c.sendBatch(batch()), (e: TransportError) => e.kind === "network");
    assert.ok(seen.every((s) => !s.url.includes("elsewhere")));
  });

  it("heartbeat 404 disables further heartbeats", async () => {
    seen = [];
    const c = new HttpReceiverClient({ baseUrl: url, deviceId: "dev", version: "t", timeoutMs: 1000, attachmentTimeoutMs: 1000 });
    const hb = { deviceId: "dev", version: "t", at: "", phase: "idle" as const, lastAckedRowId: 0, pendingAttachments: 0, backfillComplete: false };
    await c.heartbeat(hb);
    await c.heartbeat(hb);
    assert.equal(seen.filter((s) => s.url === "/v1/heartbeat").length, 1);
  });

  it("sends identifying headers and the idempotency key, never a token when none configured", async () => {
    seen = [];
    const c = new HttpReceiverClient({ baseUrl: url, deviceId: "dev-123", version: "9.9", timeoutMs: 1000, attachmentTimeoutMs: 1000 });
    await c.sendBatch(batch(7)).catch(() => undefined);
    const h = seen[0]!.headers;
    assert.equal(h["x-sender-device"], "dev-123");
    assert.equal(h["idempotency-key"], "b-7");
    assert.equal(h["user-agent"], "imessage-sender/9.9");
    assert.equal(h.authorization, undefined);
  });
});
