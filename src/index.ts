#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ConfigError, loadConfig, describeConfig } from "./config.js";
import { createRuntime, runForever, runOnce, packageVersion } from "./service.js";
import { checkOtp } from "./privacy/otp-filter.js";
import { MessagesDb, validateSchema } from "./messages/db.js";
import { MessageQueries } from "./messages/queries.js";
import { findAddressBookStores, inspectAddressBookStore, AddressBookResolver } from "./contacts/resolver.js";
import { CheckpointStore } from "./sync/checkpoint.js";
import { atomicWriteFileSync } from "./util/atomic-write.js";
import { AttachmentReader } from "./attachments/reader.js";
import { normalizeMessage } from "./messages/normalize.js";
import { NullContactResolver } from "./contacts/resolver.js";
import { Logger } from "./logging/logger.js";

const USAGE = `imessage-sender ${packageVersion()}

Usage: imessage-sender <command> [--env-file <path>]

Commands:
  run          Backfill if needed, then poll for new messages forever (what the LaunchAgent runs)
  once         One pass: backfill if needed, then a single incremental tick, then exit
  doctor       Check permissions, schema, contacts store, config. Read-only. Prints no message content.
  status       Show checkpoint / counters / pending attachments
  otp-check    Read lines from stdin and print the filter verdict for each (for testing the detector)
  dry-run      Like 'once' but with IMESSAGE_DRY_RUN=true forced (never opens a network connection)
  reset-state  Delete the checkpoint so the next run re-sends everything (asks for confirmation)
  version      Print version
`;

function parseArgs(argv: string[]): { command: string; envFile?: string; flags: Set<string> } {
  const flags = new Set<string>();
  let envFile: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--env-file") {
      envFile = argv[++i];
    } else if (a.startsWith("--")) {
      flags.add(a.slice(2));
    } else {
      positional.push(a);
    }
  }
  const out: { command: string; envFile?: string; flags: Set<string> } = { command: positional[0] ?? "help", flags };
  if (envFile) out.envFile = envFile;
  return out;
}

async function main(): Promise<number> {
  const { command, envFile, flags } = parseArgs(process.argv.slice(2));
  const loadCfg = (overrides: Record<string, string> = {}, allowMissingUrl = false) => {
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    return loadConfig({ ...(envFile ? { envFile } : {}), allowMissingUrl });
  };

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    case "version":
      process.stdout.write(packageVersion() + "\n");
      return 0;

    case "run": {
      const rt = createRuntime(loadCfg());
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      try {
        await runForever(rt, ac.signal);
      } finally {
        rt.close();
      }
      return 0;
    }

    case "once":
    case "dry-run": {
      const rt = createRuntime(loadCfg(command === "dry-run" ? { IMESSAGE_DRY_RUN: "true" } : {}));
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      try {
        await runOnce(rt, ac.signal);
      } finally {
        rt.close();
      }
      const s = rt.store.get();
      process.stdout.write(`done. checkpoint=${s.messages.lastAckedRowId} backfillComplete=${s.messages.backfillComplete} pendingAttachments=${s.attachments.pending.length}\n`);
      return 0;
    }

    case "status": {
      const cfg = loadCfg({}, true);
      const statePath = join(cfg.stateDir, "state.json");
      if (!existsSync(statePath)) {
        process.stdout.write(`no state yet (${statePath})\n`);
        return 0;
      }
      const s = new CheckpointStore(cfg.stateDir).get();
      let maxRowId: number | string = "?";
      try {
        const mdb = MessagesDb.open(cfg.chatDbPath);
        maxRowId = new MessageQueries(mdb).maxRowId();
        mdb.close();
      } catch {
        /* no access */
      }
      const logFile = join(cfg.logDir, "imessage-sender.log");
      const logInfo = existsSync(logFile) ? `${logFile} (${statSync(logFile).size} bytes)` : "(none)";
      process.stdout.write(
        [
          `state file:          ${statePath}`,
          `device id:           ${s.deviceId}`,
          `checkpoint (ROWID):  ${s.messages.lastAckedRowId}   chat.db max ROWID: ${maxRowId}`,
          `backfill complete:   ${s.messages.backfillComplete}${s.messages.backfillTargetRowId !== undefined ? ` (target ${s.messages.backfillTargetRowId})` : ""}`,
          `sent messages:       ${s.counters.sentMessages}`,
          `filtered locally:    ${s.counters.filteredMessages}`,
          `attachments:         uploaded ${s.counters.uploadedAttachments}, dropped ${s.counters.droppedAttachments}, pending ${s.attachments.pending.length}`,
          `batches acked:       ${s.counters.batches}`,
          `last update:         ${s.updatedAt}`,
          `log:                 ${logInfo}`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    case "doctor":
      return doctor(loadCfg({}, true));

    case "otp-check": {
      const rl = createInterface({ input: process.stdin });
      let total = 0;
      let filtered = 0;
      for await (const line of rl) {
        if (!line.trim()) continue;
        total++;
        const v = checkOtp({ text: line });
        if (v.filtered) filtered++;
        process.stdout.write(`${v.filtered ? "FILTER" : "allow "}  ${v.reasons.join(",") || "-"}\n`);
      }
      process.stdout.write(`\n${filtered}/${total} filtered\n`);
      return 0;
    }

    case "reset-state": {
      const cfg = loadCfg({}, true);
      const statePath = join(cfg.stateDir, "state.json");
      if (!existsSync(statePath)) {
        process.stdout.write("no state file\n");
        return 0;
      }
      if (!flags.has("yes")) {
        process.stdout.write(`This deletes ${statePath}. The next run will re-send the entire history (the receiver deduplicates by GUID).\nRe-run with --yes to confirm.\n`);
        return 1;
      }
      const old = JSON.parse(readFileSync(statePath, "utf8")) as { deviceId?: string };
      const keepId = typeof old.deviceId === "string" ? old.deviceId : undefined;
      atomicWriteFileSync(statePath + ".bak", readFileSync(statePath, "utf8"));
      const { emptyState } = await import("./sync/checkpoint.js");
      atomicWriteFileSync(statePath, JSON.stringify(emptyState(keepId), null, 2) + "\n");
      process.stdout.write(`state reset (backup at ${statePath}.bak)\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function doctor(cfg: ReturnType<typeof loadConfig>): number {
  const out: string[] = [];
  let problems = 0;
  const ok = (label: string, detail = "") => out.push(`  ✔ ${label}${detail ? `  ${detail}` : ""}`);
  const bad = (label: string, detail = "") => {
    problems++;
    out.push(`  ✘ ${label}${detail ? `  ${detail}` : ""}`);
  };

  out.push(`imessage-sender doctor (${packageVersion()})`, "");
  out.push("Environment");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if ((major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13)) ok(`node ${process.version} at ${process.execPath}`);
  else bad(`node ${process.version} is too old (need >= 22.13 for node:sqlite)`);
  ok(`platform ${process.platform} ${process.arch}`);
  out.push("", "Config");
  for (const [k, v] of Object.entries(describeConfig(cfg))) out.push(`  ${k}: ${String(v)}`);

  out.push("", "Messages database");
  if (!existsSync(cfg.chatDbPath)) {
    bad(`not found: ${cfg.chatDbPath}`);
  } else {
    try {
      const mdb = MessagesDb.open(cfg.chatDbPath);
      const schema = validateSchema(mdb);
      if (schema.ok) ok("opened read-only, required tables/columns present");
      else bad("schema mismatch", `tables missing [${schema.missingTables.join(",")}] columns missing [${schema.missingMessageColumns.join(",")}]`);
      if (schema.optionalMissing.length) out.push(`  ! optional columns absent: ${schema.optionalMissing.join(", ")}`);
      const q = new MessageQueries(mdb);
      const st = q.stats();
      for (const [k, v] of Object.entries(st)) out.push(`  ${k}: ${v}`);
      // parse check on the newest 500 rows, content-free
      const sample = q.messagesAfter(Math.max(0, st.maxRowId! - 500), 500);
      const reader = new AttachmentReader({ attachmentsDir: cfg.attachmentsDir, maxBytes: cfg.maxAttachmentBytes, uploadHidden: cfg.uploadHiddenAttachments, uploadStickers: cfg.uploadStickers });
      const atts = q.attachmentsFor(sample.map((r) => r.rowid));
      const parts = q.participantsFor(sample.map((r) => r.chat_rowid).filter((c): c is number => c !== null));
      let decodeFailed = 0;
      let withText = 0;
      let attAvailable = 0;
      let attTotal = 0;
      let filtered = 0;
      for (const row of sample) {
        const { message } = normalizeMessage(row, { contacts: new NullContactResolver(), attachments: reader, attachmentRows: atts, participants: parts });
        if (message.flags.bodyDecodeFailed) decodeFailed++;
        if (message.text) withText++;
        for (const a of message.attachments) {
          attTotal++;
          if (a.available) attAvailable++;
        }
        if (checkOtp({ text: message.text, subject: message.subject, senderHandle: message.sender.handle, isFromMe: message.isFromMe }, { blockedHandles: cfg.blockedHandles, filterShortcodeSenders: cfg.filterShortcodeSenders }).filtered) filtered++;
      }
      if (decodeFailed === 0) ok(`parsed newest ${sample.length} rows: ${withText} with text, 0 decode failures`);
      else bad(`attributedBody decode failed on ${decodeFailed}/${sample.length} newest rows (falls back to text column)`);
      ok(`attachments in sample: ${attAvailable}/${attTotal} present on disk`);
      out.push(`  OTP filter would withhold ${filtered}/${sample.length} of the newest rows`);
      mdb.close();
    } catch (err) {
      bad("cannot open", (err as Error).message);
    }
  }

  out.push("", "Attachments directory");
  if (existsSync(cfg.attachmentsDir)) ok(cfg.attachmentsDir);
  else bad(`not found: ${cfg.attachmentsDir}`);

  out.push("", "Contacts (AddressBook store)");
  if (!cfg.resolveContacts) {
    out.push("  disabled by config");
  } else {
    const stores = findAddressBookStores(cfg.addressBookDir);
    if (stores.length === 0) bad(`no AddressBook-v22.abcddb under ${cfg.addressBookDir}`);
    for (const s of stores) {
      const info = inspectAddressBookStore(s);
      if (info.ok) ok(`${s}`, `record cols: ${info.recordColumns.filter((c) => /NAME|ORGANIZATION/.test(c)).join(",")}; phone cols: ${info.phoneColumns.filter((c) => /NUMBER|OWNER/.test(c)).join(",")}; email cols: ${info.emailColumns.filter((c) => /ADDRESS|OWNER/.test(c)).join(",")}`);
      else bad(`${s}`, info.reason ?? "unusable");
    }
    if (stores.length > 0) {
      try {
        const r = new AddressBookResolver(cfg.addressBookDir, new Logger({ level: "error", stdout: false }));
        ok(`loaded ${r.size} contacts with phone/email from ${r.sources.length} store(s)`);
      } catch (err) {
        bad("failed to load contacts", (err as Error).message);
      }
    }
  }

  out.push("", "State");
  const statePath = join(cfg.stateDir, "state.json");
  if (existsSync(statePath)) {
    const s = new CheckpointStore(cfg.stateDir).get();
    ok(`${statePath}`, `checkpoint ${s.messages.lastAckedRowId}, backfillComplete ${s.messages.backfillComplete}, pending attachments ${s.attachments.pending.length}`);
  } else {
    out.push(`  (none yet — first run will create ${statePath})`);
  }

  out.push("", problems === 0 ? "All checks passed." : `${problems} problem(s) found.`, "");
  process.stdout.write(out.join("\n"));
  return problems === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ConfigError) process.stderr.write(`config error: ${err.message}\n`);
    else process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
