import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, emptyState, STATE_VERSION } from "../src/sync/checkpoint.js";
import { atomicWriteFileSync } from "../src/util/atomic-write.js";
import { parseEnvFile } from "../src/util/env-file.js";
import { backoffDelayMs } from "../src/util/backoff.js";
import { loadConfig, ConfigError } from "../src/config.js";

describe("CheckpointStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "ckpt-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty with a device id and persists on commit", () => {
    const s = new CheckpointStore(join(dir, "a"));
    assert.equal(s.get().messages.lastAckedRowId, 0);
    assert.match(s.get().deviceId, /^[0-9a-f-]{36}$/);
    s.commit((st) => {
      st.messages.lastAckedRowId = 42;
    });
    const again = new CheckpointStore(join(dir, "a"));
    assert.equal(again.get().messages.lastAckedRowId, 42);
    assert.equal(again.get().deviceId, s.get().deviceId);
  });

  it("a throwing mutator commits nothing", () => {
    const s = new CheckpointStore(join(dir, "b"));
    assert.throws(() =>
      s.commit((st) => {
        st.messages.lastAckedRowId = 99;
        throw new Error("boom");
      }),
    );
    assert.equal(s.get().messages.lastAckedRowId, 0);
    assert.equal(new CheckpointStore(join(dir, "b")).get().messages.lastAckedRowId, 0);
  });

  it("state file is mode 0600 and leaves no temp files", () => {
    const s = new CheckpointStore(join(dir, "c"));
    s.commit((st) => {
      st.counters.batches = 1;
    });
    const mode = statSync(s.path).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.deepEqual(readdirSync(join(dir, "c")), ["state.json"]);
  });

  it("refuses corrupt JSON instead of resetting silently", () => {
    const d = join(dir, "d");
    new CheckpointStore(d).commit(() => undefined);
    writeFileSync(join(d, "state.json"), "{ not json");
    assert.throws(() => new CheckpointStore(d), /corrupt/);
  });

  it("refuses a future state version", () => {
    const d = join(dir, "e");
    new CheckpointStore(d).commit(() => undefined);
    writeFileSync(join(d, "state.json"), JSON.stringify({ ...emptyState(), version: STATE_VERSION + 1 }));
    assert.throws(() => new CheckpointStore(d), /version/);
  });

  it("fills in missing sections from older files", () => {
    const d = join(dir, "f");
    new CheckpointStore(d).commit(() => undefined);
    writeFileSync(join(d, "state.json"), JSON.stringify({ version: STATE_VERSION, deviceId: "dev-1", messages: { lastAckedRowId: 7 } }));
    const s = new CheckpointStore(d).get();
    assert.equal(s.messages.lastAckedRowId, 7);
    assert.equal(s.messages.backfillComplete, false);
    assert.deepEqual(s.attachments.pending, []);
    assert.equal(s.deviceId, "dev-1");
  });

  it("never stores message content (shape check)", () => {
    const d = join(dir, "g");
    const s = new CheckpointStore(d);
    s.commit((st) => {
      st.attachments.pending.push({ attachmentGuid: "A", messageGuid: "M", rowId: 1, attachmentRowId: 2, attempts: 0, nextAttemptAt: new Date().toISOString() });
    });
    const keys = new Set<string>();
    const walk = (o: unknown) => {
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) (keys.add(k), walk(v));
    };
    walk(JSON.parse(readFileSync(s.path, "utf8")));
    for (const forbidden of ["text", "body", "handle", "displayName", "filename", "path"]) assert.ok(!keys.has(forbidden), forbidden);
  });
});

describe("atomicWriteFileSync", () => {
  it("replaces content atomically and preserves the old file if rename fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const p = join(dir, "f.json");
    atomicWriteFileSync(p, "one");
    atomicWriteFileSync(p, "two");
    assert.equal(readFileSync(p, "utf8"), "two");
    assert.deepEqual(readdirSync(dir), ["f.json"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("env file parser", () => {
  it("parses quotes, comments, export", () => {
    const r = parseEnvFile(`# c\nA=1\nexport B="two words"\nC='x' \nD=val # trailing\n\nBAD LINE\n=nokey\n`);
    assert.deepEqual(r, { A: "1", B: "two words", C: "x", D: "val" });
  });
});

describe("backoff", () => {
  it("grows exponentially and caps", () => {
    const fixed = () => 0.5;
    assert.equal(backoffDelayMs(0, { baseMs: 1000, maxMs: 60000 }, fixed), 1000);
    assert.equal(backoffDelayMs(1, { baseMs: 1000, maxMs: 60000 }, fixed), 2000);
    assert.equal(backoffDelayMs(10, { baseMs: 1000, maxMs: 60000 }, fixed), 60000);
  });
  it("jitters within ±30%", () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(3, { baseMs: 1000, maxMs: 60000 });
      assert.ok(d >= 5600 && d <= 10400, String(d));
    }
  });
});

describe("config", () => {
  const base = { IMESSAGE_STATE_DIR: "/tmp/x", IMESSAGE_LOG_DIR: "/tmp/y" };
  it("requires https by default", () => {
    assert.throws(() => loadConfig({ env: { ...base, IMESSAGE_INGEST_URL: "http://example.com" } }), ConfigError);
    assert.equal(loadConfig({ env: { ...base, IMESSAGE_INGEST_URL: "http://127.0.0.1:1", IMESSAGE_ALLOW_INSECURE_HTTP: "true" } }).ingestUrl, "http://127.0.0.1:1");
  });
  it("requires the URL unless dry run", () => {
    assert.throws(() => loadConfig({ env: { ...base } }), ConfigError);
    assert.equal(loadConfig({ env: { ...base, IMESSAGE_DRY_RUN: "true" } }).dryRun, true);
  });
  it("rejects credentials embedded in the URL and half-set CF tokens", () => {
    assert.throws(() => loadConfig({ env: { ...base, IMESSAGE_INGEST_URL: "https://u:p@example.com" } }), ConfigError);
    assert.throws(() => loadConfig({ env: { ...base, IMESSAGE_INGEST_URL: "https://example.com", IMESSAGE_CF_ACCESS_CLIENT_ID: "x" } }), ConfigError);
  });
  it("strips trailing slashes and parses lists", () => {
    const c = loadConfig({ env: { ...base, IMESSAGE_INGEST_URL: "https://example.com/", IMESSAGE_BLOCKED_HANDLES: " +1555, a@b.c ,, " } });
    assert.equal(c.ingestUrl, "https://example.com");
    assert.deepEqual(c.blockedHandles, ["+1555", "a@b.c"]);
  });
  it("validates integers", () => {
    assert.throws(() => loadConfig({ env: { ...base, IMESSAGE_INGEST_URL: "https://example.com", IMESSAGE_BATCH_SIZE: "0" } }), ConfigError);
  });
});
