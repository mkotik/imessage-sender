import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeConfig, type Config } from "./config.js";
import { Logger, errorFields } from "./logging/logger.js";
import { MessagesDb, validateSchema } from "./messages/db.js";
import { MessageQueries } from "./messages/queries.js";
import { createContactResolver } from "./contacts/resolver.js";
import { AttachmentReader } from "./attachments/reader.js";
import { CheckpointStore } from "./sync/checkpoint.js";
import { SyncEngine } from "./sync/engine.js";
import { runBackfill } from "./sync/backfill.js";
import { IncrementalSync } from "./sync/incremental.js";
import { DryRunTransport, HttpReceiverClient } from "./transport/client.js";
import type { ReceiverTransport } from "./transport/types.js";
import { sleep } from "./util/backoff.js";

export function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [join(here, "..", "..", "package.json"), join(here, "..", "package.json")]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return "0.0.0";
}

export interface Runtime {
  cfg: Config;
  log: Logger;
  mdb: MessagesDb;
  queries: MessageQueries;
  store: CheckpointStore;
  engine: SyncEngine;
  incremental: IncrementalSync;
  transport: ReceiverTransport;
  version: string;
  close(): void;
}

export function createRuntime(cfg: Config, opts: { stdout?: boolean } = {}): Runtime {
  const version = packageVersion();
  const log = new Logger({ level: cfg.logLevel, logDir: cfg.logDir, stdout: opts.stdout ?? true });
  log.info("startup", { version, node: process.version, pid: process.pid, ...describeConfig(cfg) });

  const mdb = MessagesDb.open(cfg.chatDbPath);
  const schema = validateSchema(mdb);
  if (!schema.ok) {
    mdb.close();
    throw new Error(`chat.db schema unsupported: missing tables [${schema.missingTables.join(", ")}] columns [${schema.missingMessageColumns.join(", ")}]`);
  }
  if (schema.optionalMissing.length > 0) log.warn("schema_optional_missing", { columns: schema.optionalMissing.join(",") });

  const queries = new MessageQueries(mdb);
  const store = new CheckpointStore(cfg.stateDir);
  const contacts = createContactResolver(cfg.resolveContacts, cfg.addressBookDir, log);
  const attachments = new AttachmentReader({
    attachmentsDir: cfg.attachmentsDir,
    maxBytes: cfg.maxAttachmentBytes,
    uploadHidden: cfg.uploadHiddenAttachments,
    uploadStickers: cfg.uploadStickers,
  });
  const transport: ReceiverTransport = cfg.dryRun ? new DryRunTransport() : HttpReceiverClient.fromConfig(cfg, store.get().deviceId, version, log);
  if (cfg.dryRun) log.warn("dry_run_enabled", { note: "nothing will be transmitted" });

  const engine = new SyncEngine({ cfg, log, store, transport, queries, contacts, attachments });
  const incremental = new IncrementalSync(engine, store, queries, cfg.chatDbPath, log);
  return {
    cfg,
    log,
    mdb,
    queries,
    store,
    engine,
    incremental,
    transport,
    version,
    close: () => mdb.close(),
  };
}

/** Long-running loop: backfill (if needed) then poll forever. */
export async function runForever(rt: Runtime, signal: AbortSignal): Promise<void> {
  const { cfg, log, store } = rt;
  let lastHeartbeat = 0;

  const heartbeat = async (phase: "backfill" | "incremental" | "idle") => {
    if (!cfg.heartbeat || !rt.transport.heartbeat) return;
    if (Date.now() - lastHeartbeat < cfg.heartbeatIntervalMs) return;
    lastHeartbeat = Date.now();
    const s = store.get();
    try {
      await rt.transport.heartbeat(
        { deviceId: s.deviceId, version: rt.version, at: new Date().toISOString(), phase, lastAckedRowId: s.messages.lastAckedRowId, pendingAttachments: s.attachments.pending.length, backfillComplete: s.messages.backfillComplete },
        signal,
      );
    } catch (err) {
      log.debug("heartbeat_failed", errorFields(err));
    }
  };

  while (!signal.aborted) {
    try {
      if (!store.get().messages.backfillComplete) {
        await heartbeat("backfill");
        const r = await runBackfill(rt.engine, store, rt.queries, log, signal);
        if (!r.completed) continue; // aborted
      }
      await rt.incremental.tick(signal);
      await heartbeat("incremental");
    } catch (err) {
      log.error("loop_error", errorFields(err));
      // Schema/DB-replaced errors are fatal by design: exit non-zero and let launchd hold us back.
      if (err instanceof Error && /Refusing to continue|schema unsupported/.test(err.message)) throw err;
      await sleep(Math.min(cfg.pollIntervalMs * 2, 60_000), signal);
      continue;
    }
    await sleep(cfg.pollIntervalMs, signal);
  }
  log.info("shutdown", { reason: "signal" });
}

/** One pass: backfill (if needed) then a single incremental tick. Used by `once` and tests. */
export async function runOnce(rt: Runtime, signal?: AbortSignal): Promise<void> {
  if (!rt.store.get().messages.backfillComplete) await runBackfill(rt.engine, rt.store, rt.queries, rt.log, signal);
  await rt.incremental.tick(signal, true);
}
