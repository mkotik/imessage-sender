/**
 * npm run synthetic-db [--dir <path>] [--count <n>]
 * Writes a fabricated chat.db + Attachments/ so the sender can be exercised without touching
 * the real Messages database.
 */
import { resolve } from "node:path";
import { buildSyntheticDb, sampleMessages, type SynthMessage } from "./synthetic.js";

const args = process.argv.slice(2);
const dir = resolve(args[args.indexOf("--dir") + 1] && args.includes("--dir") ? args[args.indexOf("--dir") + 1]! : "./tmp/synthetic");
const count = args.includes("--count") ? Number(args[args.indexOf("--count") + 1]) : 0;

const messages: SynthMessage[] = sampleMessages();
for (let i = 0; i < count; i++) {
  const otp = i % 25 === 0;
  messages.push(
    otp
      ? { text: `Your login code is ${100000 + ((i * 7919) % 900000)}`, handle: "+18005550100" }
      : { text: `synthetic filler message number ${i}`, handle: i % 2 ? "+15550000001" : "+15550000002", fromMe: i % 3 === 0 },
  );
}

const r = buildSyntheticDb({ dir, messages });
r.db.close();
process.stdout.write(`synthetic chat.db written: ${r.dbPath} (${r.guids.length} messages)\nexport IMESSAGE_CHAT_DB_PATH=${r.dbPath}\nexport IMESSAGE_ATTACHMENTS_DIR=${r.attachmentsDir}\n`);
