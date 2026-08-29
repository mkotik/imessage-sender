import { mkdirSync, appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { LogLevel } from "../config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured, privacy-conscious logger.
 *
 * Only accepts a short event name plus a flat bag of scalar fields. It is the caller's job to
 * never pass message text / tokens; as a second guard, string values longer than
 * MAX_FIELD_LEN are truncated and keys that look like content are dropped outright.
 */
const FORBIDDEN_KEYS = /^(text|body|message|content|token|secret|authorization|password|attributedbody|payload)$/i;
const MAX_FIELD_LEN = 200;

export type Fields = Record<string, string | number | boolean | null | undefined>;

export interface LoggerOptions {
  level: LogLevel;
  logDir?: string; // when set, also append JSON lines to <logDir>/imessage-sender.log
  stdout?: boolean; // default true
  maxFileBytes?: number; // rotate when exceeded (default 20 MB)
  clock?: () => Date;
}

export class Logger {
  private readonly threshold: number;
  private readonly filePath: string | undefined;
  private readonly stdout: boolean;
  private readonly maxFileBytes: number;
  private readonly clock: () => Date;
  private fileDisabled = false;

  constructor(private readonly opts: LoggerOptions) {
    this.threshold = LEVELS[opts.level];
    this.stdout = opts.stdout ?? true;
    this.maxFileBytes = opts.maxFileBytes ?? 20 * 1024 * 1024;
    this.clock = opts.clock ?? (() => new Date());
    if (opts.logDir) {
      try {
        mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
        this.filePath = join(opts.logDir, "imessage-sender.log");
      } catch {
        this.filePath = undefined;
      }
    }
  }

  child(bound: Fields): Logger {
    const parent = this;
    const child = Object.create(parent) as Logger;
    const orig = parent.emit.bind(parent);
    (child as unknown as { emit: Logger["emit"] }).emit = (level, event, fields) => orig(level, event, { ...bound, ...fields });
    return child;
  }

  debug(event: string, fields?: Fields): void {
    this.emit("debug", event, fields);
  }
  info(event: string, fields?: Fields): void {
    this.emit("info", event, fields);
  }
  warn(event: string, fields?: Fields): void {
    this.emit("warn", event, fields);
  }
  error(event: string, fields?: Fields): void {
    this.emit("error", event, fields);
  }

  private emit(level: LogLevel, event: string, fields?: Fields): void {
    if (LEVELS[level] < this.threshold) return;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (FORBIDDEN_KEYS.test(k)) continue;
      if (v === undefined) continue;
      safe[k] = typeof v === "string" && v.length > MAX_FIELD_LEN ? v.slice(0, MAX_FIELD_LEN) + "…" : v;
    }
    const record = { ts: this.clock().toISOString(), level, event, ...safe };
    const line = JSON.stringify(record);
    if (this.stdout) {
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    }
    if (this.filePath && !this.fileDisabled) {
      try {
        this.rotateIfNeeded();
        appendFileSync(this.filePath, line + "\n", { mode: 0o600 });
      } catch {
        this.fileDisabled = true;
      }
    }
  }

  private rotateIfNeeded(): void {
    if (!this.filePath) return;
    try {
      const st = statSync(this.filePath);
      if (st.size > this.maxFileBytes) renameSync(this.filePath, this.filePath + ".1");
    } catch {
      /* file does not exist yet */
    }
  }
}

/** Describe an error for logs without leaking bodies. */
export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: string; status?: number; cause?: unknown };
    const cause = anyErr.cause as { code?: string; message?: string } | undefined;
    return {
      errName: err.name,
      errCode: anyErr.code ?? cause?.code ?? undefined,
      errMessage: err.message.slice(0, MAX_FIELD_LEN),
      ...(anyErr.status !== undefined ? { status: anyErr.status } : {}),
    };
  }
  return { errMessage: String(err).slice(0, MAX_FIELD_LEN) };
}
