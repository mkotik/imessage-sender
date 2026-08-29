import { describe, it, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSyntheticDb, appendMessages, sampleMessages, type SynthResult } from "../tools/synthetic.js";
import { startMockReceiver, type MockReceiver } from "../tools/mock-receiver.js";
import { MessagesDb } from "../src/messages/db.js";
import { MessageQueries } from "../src/messages/queries.js";
import { CheckpointStore } from "../src/sync/checkpoint.js";
import { SyncEngine } from "../src/sync/engine.js";
import { runBackfill } from "../src/sync/backfill.js";
import { IncrementalSync } from "../src/sync/incremental.js";
import { HttpReceiverClient } from "../src/transport/client.js";
import { Logger } from "../src/logging/logger.js";
import { AttachmentReader } from "../src/attachments/reader.js";
import { ContactIndex } from "../src/contacts/resolver.js";
import type { BatchRequest, BatchResponse, ReceiverTransport } from "../src/transport/types.js";

const OTP_TEXTS = ["483920", "728172", "559102", "128 733", "login code"];

interface Harness {
  dir: string;
  synth: SynthResult;
  mock: MockReceiver;
  logDir: string;
  stateDir: string;
  make(opts?: { transport?: ReceiverTransport; batchSize?: number }): { engine: SyncEngine; store: CheckpointStore; queries: MessageQueries; log: Logger; incremental: IncrementalSync; close(): void };
}

async function harness(extraFiller = 0): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "sync-"));
  const messages = sampleMessages();
  for (let i = 0; i < extraFiller; i++) messages.push({ text: `filler ${i}`, handle: "+15550000001", fromMe: i % 2 === 0 });
  const synth = buildSyntheticDb({ dir: join(dir, "msgs"), messages, startAt: Date.UTC(2023, 0, 1) });
  synth.db.close();
  const mock = await startMockReceiver({ token: "tok", quiet: true });
  const logDir = join(dir, "logs");
  const stateDir = join(dir, "state");
  const contacts = new ContactIndex();
  contacts.add("Alice Example", ["+15550000001"], ["alice@example.com"]);
  return {
    dir,
    synth,
    mock,
    logDir,
    stateDir,
    make(opts = {}) {
      const log = new Logger({ level: "debug", logDir, stdout: false });
      const mdb = MessagesDb.open(synth.dbPath);
      const queries = new MessageQueries(mdb);
      const store = new CheckpointStore(stateDir);
      const transport = opts.transport ?? new HttpReceiverClient({ baseUrl: mock.url, token: "tok", deviceId: store.get().deviceId, version: "test", timeoutMs: 2000, attachmentTimeoutMs: 2000 });
      const attachments = new AttachmentReader({ attachmentsDir: synth.attachmentsDir, maxBytes: 1_000_000, uploadHidden: false, uploadStickers: true });
      const engine = new SyncEngine({
        cfg: { batchSize: opts.batchSize ?? 5, blockedHandles: [], filterShortcodeSenders: true },
        log,
        store,
        transport,
        queries,
        contacts,
        attachments,
        sleep: async () => undefined,
        backoff: { baseMs: 1, maxMs: 2 },
      });
      const incremental = new IncrementalSync(engine, store, queries, synth.dbPath, log);
      return { engine, store, queries, log, incremental, close: () => mdb.close() };
    },
  };
}

function logText(h: Harness): string {
  const p = join(h.logDir, "imessage-sender.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("sync: full backfill", () => {
  let h: Harness;
  before(async () => (h = await harness(30)));
  after(async () => {
    await h.mock.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("sends everything except filtered messages, uploads only available/eligible attachments, advances checkpoint", async () => {
    const rt = h.make();
    const r = await runBackfill(rt.engine, rt.store, rt.queries, rt.log);
    rt.close();
    assert.equal(r.completed, true);
    const total = 50; // 20 sample + 30 filler
    const filtered = 5; // 4 OTP + "gate code ... 4471" (false-positive by design)
    assert.equal(r.filtered, filtered);
    assert.equal(r.sent, total - filtered);
    const st = h.mock.stats();
    assert.equal(st.uniqueMessageGuids, total - filtered);
    assert.equal(st.duplicateMessages, 0);
    assert.equal(st.otpLikeTexts, 0, "receiver's leak scanner must find nothing");
    assert.equal(st.phases.backfill, 10);
    // attachments: 2 heic uploaded + caf uploaded; hidden payload skipped; missing mov skipped
    assert.equal(st.attachments, 3);
    const uploadedNames = [...h.mock.attachments().values()].map((a) => (a.meta as { filename: string }).filename).sort();
    assert.deepEqual(uploadedNames, ["Audio Message.caf", "IMG_0001.heic", "IMG_0002.heic"]);
    const state = rt.store.get();
    assert.equal(state.messages.lastAckedRowId, total);
    assert.equal(state.messages.backfillComplete, true);
    assert.equal(state.attachments.pending.length, 0);
    assert.equal(state.counters.uploadedAttachments, 3);
  });

  it("no OTP content reaches the receiver or the logs; log has no message text", () => {
    const dump = JSON.stringify([...h.mock.messages().values()]);
    for (const t of OTP_TEXTS) assert.ok(!dump.includes(t), `receiver got ${t}`);
    const logs = logText(h);
    for (const t of [...OTP_TEXTS, "dinner tomorrow", "airbnb", "Alice Example", "+15550000001"]) assert.ok(!logs.includes(t), `log leaked ${t}`);
    assert.ok(logs.includes("batch_acked"));
    assert.ok(logs.includes("backfill_complete"));
  });

  it("contact names and metadata made it into payloads", () => {
    const msgs = [...h.mock.messages().values()] as Array<{ sender: { displayName?: string; handle?: string }; attachments: Array<{ skippedReason?: string; willUpload: boolean }> }>;
    assert.ok(msgs.some((m) => m.sender.displayName === "Alice Example"));
    const skipped = msgs.flatMap((m) => m.attachments).map((a) => a.skippedReason).filter(Boolean).sort();
    assert.deepEqual(skipped, ["hidden", "missing"]);
  });

  it("a second backfill run is a no-op", async () => {
    const before = h.mock.stats().batches;
    const rt = h.make();
    const r = await runBackfill(rt.engine, rt.store, rt.queries, rt.log);
    rt.close();
    assert.equal(r.batches, 0);
    assert.equal(h.mock.stats().batches, before);
  });
});

describe("sync: failures never advance the checkpoint", () => {
  let h: Harness;
  before(async () => (h = await harness()));
  after(async () => {
    await h.mock.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("5xx on every other batch: retried, no loss, no checkpoint skip", async () => {
    h.mock.setOptions({ failEvery: 2 });
    const rt = h.make();
    const r = await runBackfill(rt.engine, rt.store, rt.queries, rt.log);
    rt.close();
    h.mock.setOptions({ failEvery: 0 });
    assert.equal(r.completed, true);
    assert.equal(h.mock.stats().failuresInjected, 3); // batches 2,3,4 each fail once
    assert.equal(h.mock.stats().uniqueMessageGuids, 15);
    assert.equal(h.mock.stats().duplicateMessages, 0);
    assert.ok(logText(h).includes("batch_send_failed"));
    assert.ok(logText(h).includes("batch_recovered"));
  });

  it("aborting mid-retry leaves the checkpoint where it was", async () => {
    h.mock.reset();
    rmSync(h.stateDir, { recursive: true, force: true });
    h.mock.setOptions({ dropConnections: true });
    const rt = h.make();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await runBackfill(rt.engine, rt.store, rt.queries, rt.log, ac.signal);
    rt.close();
    h.mock.setOptions({ dropConnections: false });
    assert.equal(r.completed, false);
    assert.equal(rt.store.get().messages.lastAckedRowId, 0);
    assert.equal(rt.store.get().messages.backfillComplete, false);
  });

  it("non-retryable 4xx: retried at the cap, not skipped; proceeds once the receiver recovers", async () => {
    await new Promise((r) => setTimeout(r, 100)); // let any aborted in-flight request from the previous test drain
    h.mock.reset();
    h.mock.setOptions({ rejectOnce: 400 });
    const rt = h.make();
    const r = await runBackfill(rt.engine, rt.store, rt.queries, rt.log);
    rt.close();
    assert.equal(r.completed, true);
    assert.ok(logText(h).includes("batch_rejected"));
    assert.equal(h.mock.stats().uniqueMessageGuids, 15);
  });
});

describe("sync: crash/resume and duplicate retries", () => {
  let h: Harness;
  before(async () => (h = await harness(20)));
  after(async () => {
    await h.mock.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("process dies after 3 batches; restart resumes from checkpoint and finishes without re-sending acked batches", async () => {
    const rt = h.make();
    const ac = new AbortController();
    let acked = 0;
    let lastSeen = 0;
    const orig = rt.store.commit.bind(rt.store);
    rt.store.commit = (m) => {
      const s = orig(m);
      if (s.messages.lastAckedRowId > lastSeen) {
        lastSeen = s.messages.lastAckedRowId;
        if (++acked === 3) ac.abort();
      }
      return s;
    };
    const r1 = await runBackfill(rt.engine, rt.store, rt.queries, rt.log, ac.signal);
    rt.close();
    assert.equal(r1.completed, false);
    const cp = rt.store.get().messages.lastAckedRowId;
    assert.equal(cp, 15);
    const batchesBefore = h.mock.stats().batches;

    const rt2 = h.make();
    const r2 = await runBackfill(rt2.engine, rt2.store, rt2.queries, rt2.log);
    rt2.close();
    assert.equal(r2.completed, true);
    assert.ok(logText(h).includes("backfill_resumed"));
    assert.equal(h.mock.stats().batches, batchesBefore + 5);
    assert.equal(h.mock.stats().duplicateMessages, 0);
    assert.equal(h.mock.stats().uniqueMessageGuids, 40 - 5);
    assert.equal(rt2.store.get().messages.lastAckedRowId, 40);
  });

  it("crash between receiver ack and checkpoint write → identical batchId re-sent, receiver dedups", async () => {
    h.mock.reset();
    rmSync(h.stateDir, { recursive: true, force: true });
    let calls = 0;
    const seenIds: string[] = [];
    const flaky: ReceiverTransport = {
      async sendBatch(b: BatchRequest): Promise<BatchResponse> {
        calls++;
        seenIds.push(b.batchId);
        const real = new HttpReceiverClient({ baseUrl: h.mock.url, token: "tok", deviceId: b.deviceId, version: "t", timeoutMs: 2000, attachmentTimeoutMs: 2000 });
        const res = await real.sendBatch(b);
        if (calls === 2) throw new Error("simulated crash after ack, before checkpoint");
        return res;
      },
      async uploadAttachment() {
        return { status: "ok" as const };
      },
    };
    const rt = h.make({ transport: flaky });
    await assert.rejects(runBackfill(rt.engine, rt.store, rt.queries, rt.log), /simulated crash/);
    rt.close();
    assert.equal(rt.store.get().messages.lastAckedRowId, 5);
    const rt2 = h.make({ transport: flaky });
    const r = await runBackfill(rt2.engine, rt2.store, rt2.queries, rt2.log);
    rt2.close();
    assert.equal(r.completed, true);
    assert.equal(seenIds[1], seenIds[2], "retry carries the same deterministic batchId");
    assert.equal(h.mock.stats().duplicateMessages, 5);
    assert.equal(h.mock.stats().uniqueMessageGuids, 35);
  });

  it("refuses to run if chat.db was replaced (max ROWID < checkpoint)", async () => {
    const db = new DatabaseSync(h.synth.dbPath);
    db.exec("DELETE FROM message WHERE ROWID > 3");
    db.close();
    const rt = h.make();
    rt.store.commit((s) => {
      s.messages.backfillComplete = false;
    });
    await assert.rejects(runBackfill(rt.engine, rt.store, rt.queries, rt.log), /replaced/);
    rt.close();
  });
});

describe("sync: incremental", () => {
  let h: Harness;
  before(async () => (h = await harness()));
  after(async () => {
    await h.mock.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("backfill → idle tick → new messages → edit → attachment retry", async () => {
    const rt = h.make();
    await runBackfill(rt.engine, rt.store, rt.queries, rt.log);
    const idle = await rt.incremental.tick(undefined, true);
    assert.equal(idle.changed, false);
    const batchesAfterBackfill = h.mock.stats().batches;

    // new messages arrive (one is an OTP) plus a new attachment
    const db = new DatabaseSync(h.synth.dbPath);
    const guids = appendMessages(
      db,
      h.synth.attachmentsDir,
      [
        { text: "new message after backfill", handle: "+15550000001" },
        { text: "Your login code is 991822", handle: "+18005550100" },
        { text: "pic", fromMe: true, handle: "+15550000001", attachments: [{ name: "new.png", mime: "image/png", uti: "public.png", bytes: Buffer.from("png") }] },
      ],
      Date.UTC(2025, 0, 1),
    );
    db.close();
    const t1 = await rt.incremental.tick();
    assert.equal(t1.changed, true);
    assert.equal(t1.sent, 2);
    assert.equal(t1.filtered, 1);
    assert.equal(h.mock.stats().batches, batchesAfterBackfill + 1);
    assert.equal(h.mock.stats().phases.incremental, 1);
    assert.ok(h.mock.messages().has(guids[0]!));
    assert.ok(!h.mock.messages().has(guids[1]!));
    assert.ok([...h.mock.attachments().values()].some((a) => (a.meta as { filename: string }).filename === "new.png"));
    assert.equal(h.mock.stats().otpLikeTexts, 0);

    // nothing changed → no requests
    const t2 = await rt.incremental.tick();
    assert.equal(t2.changed, false);

    // an old message gets edited in place → revision batch
    const db2 = new DatabaseSync(h.synth.dbPath);
    const nowNs = rt.engine.nowAppleNs() + 5_000_000_000;
    db2.prepare("UPDATE message SET date_edited = ? WHERE ROWID = 1").run(nowNs);
    db2.close();
    const t3 = await rt.incremental.tick();
    assert.equal(t3.revisions, 1);
    assert.equal(h.mock.stats().phases.revision, 1);
    assert.equal(h.mock.stats().duplicateMessages, 1); // upsert of the edited row
    const t4 = await rt.incremental.tick();
    assert.equal(t4.revisions, 0);
    rt.close();
  });

  it("attachment upload failure is retried later without blocking messages", async () => {
    h.mock.reset();
    rmSync(h.stateDir, { recursive: true, force: true });
    // receiver drops attachment PUTs: we simulate with a transport wrapper
    let failUploads = true;
    const real = (deviceId: string) => new HttpReceiverClient({ baseUrl: h.mock.url, token: "tok", deviceId, version: "t", timeoutMs: 2000, attachmentTimeoutMs: 2000 });
    const wrapper: ReceiverTransport = {
      sendBatch: (b, s) => real(b.deviceId).sendBatch(b, s),
      uploadAttachment: async (m, body, s) => {
        if (failUploads) {
          const { TransportError } = await import("../src/transport/types.js");
          throw new TransportError("simulated", "network");
        }
        return real("d").uploadAttachment(m, body, s);
      },
    };
    const rt = h.make({ transport: wrapper });
    const r = await runBackfill(rt.engine, rt.store, rt.queries, rt.log);
    assert.equal(r.completed, true, "messages complete even though attachments fail");
    // 3 from the sample fixture + new.png appended by the previous test (same synthetic db)
    assert.equal(rt.store.get().attachments.pending.length, 4);
    assert.ok(rt.store.get().attachments.pending.every((p) => p.attempts === 1));
    assert.ok(logText(h).includes("attachment_upload_failed"));
    // pending entries carry only identifiers
    const pendingJson = JSON.stringify(rt.store.get().attachments.pending);
    assert.ok(!pendingJson.includes("IMG_0001"));
    assert.ok(!pendingJson.includes("/"));

    failUploads = false;
    // not due yet (backoff) → nothing
    let res = await rt.engine.drainPendingAttachments();
    assert.equal(res.uploaded, 0);
    // make them due
    rt.store.commit((s) => {
      for (const p of s.attachments.pending) p.nextAttemptAt = new Date(0).toISOString();
    });
    res = await rt.engine.drainPendingAttachments();
    assert.equal(res.uploaded, 4);
    assert.equal(rt.store.get().attachments.pending.length, 0);
    assert.equal(h.mock.stats().attachments, 4);
    rt.close();
  });
});

describe("logger privacy", () => {
  it("drops forbidden keys and truncates long strings", () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      lines.push(s);
      return true;
    };
    try {
      const log = new Logger({ level: "debug", stdout: true });
      log.info("evt", { text: "SECRET BODY", token: "SECRET TOKEN", Authorization: "Bearer x", ok: 1, long: "y".repeat(500) });
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    const out = lines.join("");
    assert.ok(!out.includes("SECRET"));
    assert.ok(!out.includes("Bearer"));
    assert.ok(out.includes('"ok":1'));
    assert.ok(out.length < 400);
  });
});
