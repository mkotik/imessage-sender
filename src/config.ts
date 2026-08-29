import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "./util/env-file.js";
import { expandHome } from "./util/paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  ingestUrl: string; // base URL, no trailing slash
  ingestToken?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  dryRun: boolean;
  allowInsecureHttp: boolean;

  chatDbPath: string;
  attachmentsDir: string;
  addressBookDir: string;

  stateDir: string;
  logDir: string;
  logLevel: LogLevel;

  batchSize: number;
  pollIntervalMs: number;
  httpTimeoutMs: number;
  attachmentHttpTimeoutMs: number;
  maxAttachmentBytes: number;
  uploadHiddenAttachments: boolean;
  uploadStickers: boolean;
  resolveContacts: boolean;
  heartbeat: boolean;
  heartbeatIntervalMs: number;

  blockedHandles: string[];
  filterShortcodeSenders: boolean;
}

export class ConfigError extends Error {}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function int(v: string | undefined, def: number, name: string, min = 1): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}`);
  return n;
}

/**
 * Load configuration. Precedence: real environment > explicit env file > ./.env.local > ./.env > state-dir config.env.
 * `envFile` may be passed explicitly (CLI --env-file) or via IMESSAGE_SENDER_ENV_FILE.
 */
export function loadConfig(opts: { envFile?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Config {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const stateDirPre = expandHome(env.IMESSAGE_STATE_DIR ?? "~/Library/Application Support/imessage-sender");
  const candidates = [
    opts.envFile,
    env.IMESSAGE_SENDER_ENV_FILE,
    join(cwd, ".env.local"),
    join(cwd, ".env"),
    join(stateDirPre, "config.env"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (existsSync(expandHome(p))) {
      loadEnvFile(expandHome(p), env);
      break;
    }
  }

  const dryRun = bool(env.IMESSAGE_DRY_RUN, false);
  const allowInsecureHttp = bool(env.IMESSAGE_ALLOW_INSECURE_HTTP, false);
  let ingestUrl = (env.IMESSAGE_INGEST_URL ?? "").trim().replace(/\/+$/, "");
  if (!ingestUrl) {
    if (!dryRun) throw new ConfigError("IMESSAGE_INGEST_URL is required (or set IMESSAGE_DRY_RUN=true)");
    ingestUrl = "https://dry-run.invalid";
  }
  let parsed: URL;
  try {
    parsed = new URL(ingestUrl);
  } catch {
    throw new ConfigError("IMESSAGE_INGEST_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:")) {
    throw new ConfigError("IMESSAGE_INGEST_URL must use https:// (set IMESSAGE_ALLOW_INSECURE_HTTP=true only for a local mock)");
  }
  if (parsed.username || parsed.password) throw new ConfigError("IMESSAGE_INGEST_URL must not embed credentials");

  const level = (env.IMESSAGE_LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(level)) throw new ConfigError("IMESSAGE_LOG_LEVEL invalid");

  const blockedHandles = (env.IMESSAGE_BLOCKED_HANDLES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg: Config = {
    ingestUrl,
    dryRun,
    allowInsecureHttp,
    chatDbPath: expandHome(env.IMESSAGE_CHAT_DB_PATH ?? "~/Library/Messages/chat.db"),
    attachmentsDir: expandHome(env.IMESSAGE_ATTACHMENTS_DIR ?? "~/Library/Messages/Attachments"),
    addressBookDir: expandHome(env.IMESSAGE_ADDRESSBOOK_DIR ?? "~/Library/Application Support/AddressBook"),
    // A dry run keeps its own checkpoint so it can never make the real run skip history.
    stateDir: dryRun ? join(stateDirPre, "dry-run") : stateDirPre,
    logDir: expandHome(env.IMESSAGE_LOG_DIR ?? "~/Library/Logs/imessage-sender"),
    logLevel: level as LogLevel,
    batchSize: int(env.IMESSAGE_BATCH_SIZE, 200, "IMESSAGE_BATCH_SIZE"),
    pollIntervalMs: int(env.IMESSAGE_POLL_INTERVAL_SECONDS, 30, "IMESSAGE_POLL_INTERVAL_SECONDS") * 1000,
    httpTimeoutMs: int(env.IMESSAGE_HTTP_TIMEOUT_SECONDS, 60, "IMESSAGE_HTTP_TIMEOUT_SECONDS") * 1000,
    attachmentHttpTimeoutMs:
      int(env.IMESSAGE_ATTACHMENT_HTTP_TIMEOUT_SECONDS, 600, "IMESSAGE_ATTACHMENT_HTTP_TIMEOUT_SECONDS") * 1000,
    maxAttachmentBytes: int(env.IMESSAGE_MAX_ATTACHMENT_BYTES, 100 * 1024 * 1024, "IMESSAGE_MAX_ATTACHMENT_BYTES", 0),
    uploadHiddenAttachments: bool(env.IMESSAGE_UPLOAD_HIDDEN_ATTACHMENTS, false),
    uploadStickers: bool(env.IMESSAGE_UPLOAD_STICKERS, true),
    resolveContacts: bool(env.IMESSAGE_RESOLVE_CONTACTS, true),
    heartbeat: bool(env.IMESSAGE_HEARTBEAT, true),
    heartbeatIntervalMs: int(env.IMESSAGE_HEARTBEAT_INTERVAL_SECONDS, 300, "IMESSAGE_HEARTBEAT_INTERVAL_SECONDS") * 1000,
    blockedHandles,
    filterShortcodeSenders: bool(env.IMESSAGE_FILTER_SHORTCODE_SENDERS, true),
  };
  const token = env.IMESSAGE_INGEST_TOKEN?.trim();
  if (token) cfg.ingestToken = token;
  const cfId = env.IMESSAGE_CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = env.IMESSAGE_CF_ACCESS_CLIENT_SECRET?.trim();
  if (cfId && cfSecret) {
    cfg.cfAccessClientId = cfId;
    cfg.cfAccessClientSecret = cfSecret;
  } else if (cfId || cfSecret) {
    throw new ConfigError("IMESSAGE_CF_ACCESS_CLIENT_ID and IMESSAGE_CF_ACCESS_CLIENT_SECRET must be set together");
  }
  return cfg;
}

/** Config view that is safe to log (no secrets). */
export function describeConfig(cfg: Config): Record<string, unknown> {
  return {
    ingestUrl: cfg.ingestUrl,
    auth: cfg.ingestToken ? (cfg.cfAccessClientId ? "bearer+cf-access" : "bearer") : cfg.cfAccessClientId ? "cf-access" : "none",
    dryRun: cfg.dryRun,
    chatDbPath: cfg.chatDbPath,
    stateDir: cfg.stateDir,
    logDir: cfg.logDir,
    batchSize: cfg.batchSize,
    pollIntervalMs: cfg.pollIntervalMs,
    maxAttachmentBytes: cfg.maxAttachmentBytes,
    uploadHiddenAttachments: cfg.uploadHiddenAttachments,
    resolveContacts: cfg.resolveContacts,
    blockedHandles: cfg.blockedHandles.length,
    filterShortcodeSenders: cfg.filterShortcodeSenders,
  };
}
