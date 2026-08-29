import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmailHandle, isShortCode, normalizeEmail, phoneKeys } from "./phone.js";
import type { Logger } from "../logging/logger.js";

export interface ResolvedContact {
  displayName: string;
  /** More than one distinct contact matched this handle. */
  ambiguous: boolean;
}

export interface ContactResolver {
  resolve(handle: string | null | undefined): ResolvedContact | undefined;
  /** Re-read the source if it changed. Cheap when nothing changed. */
  refreshIfChanged(): void;
  readonly size: number;
  readonly sources: string[];
}

interface NameEntry {
  name: string;
}

/** In-memory index built from (name, phone[]/email[]) tuples — the store-agnostic core. */
export class ContactIndex implements ContactResolver {
  private byPhoneFull = new Map<string, Set<string>>();
  private byPhoneLast10 = new Map<string, Set<string>>();
  private byEmail = new Map<string, Set<string>>();
  private count = 0;
  sources: string[] = [];

  add(name: string, phones: string[], emails: string[]): void {
    const n = name.trim();
    if (!n) return;
    this.count++;
    for (const p of phones) {
      const k = phoneKeys(p);
      if (!k) continue;
      addTo(this.byPhoneFull, k.full, n);
      if (k.last10) addTo(this.byPhoneLast10, k.last10, n);
    }
    for (const e of emails) {
      const k = normalizeEmail(e);
      if (k) addTo(this.byEmail, k, n);
    }
  }

  get size(): number {
    return this.count;
  }

  resolve(handle: string | null | undefined): ResolvedContact | undefined {
    if (!handle) return undefined;
    const h = handle.trim();
    if (!h || isShortCode(h) || h.startsWith("urn:")) return undefined;
    let names: Set<string> | undefined;
    if (isEmailHandle(h)) {
      names = this.byEmail.get(normalizeEmail(h));
    } else {
      const k = phoneKeys(h);
      if (!k) return undefined;
      names = this.byPhoneFull.get(k.full) ?? (k.last10 ? this.byPhoneLast10.get(k.last10) : undefined);
    }
    if (!names || names.size === 0) return undefined;
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    return { displayName: sorted[0]!, ambiguous: sorted.length > 1 };
  }

  refreshIfChanged(): void {
    /* static index */
  }
}

function addTo(map: Map<string, Set<string>>, key: string, name: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(name);
  map.set(key, set);
}

/** Always-empty resolver (contacts disabled or unavailable). */
export class NullContactResolver implements ContactResolver {
  readonly size = 0;
  readonly sources: string[] = [];
  resolve(): undefined {
    return undefined;
  }
  refreshIfChanged(): void {
    /* nothing */
  }
}

// ---------------------------------------------------------------------------------------------
// macOS AddressBook SQLite store
// ---------------------------------------------------------------------------------------------

export interface AddressBookSchemaInfo {
  path: string;
  recordColumns: string[];
  phoneColumns: string[];
  emailColumns: string[];
  ok: boolean;
  reason?: string;
}

/** Locate every AddressBook-v22.abcddb under the AddressBook directory (main + Sources/*). */
export function findAddressBookStores(addressBookDir: string): string[] {
  const out: string[] = [];
  const main = join(addressBookDir, "AddressBook-v22.abcddb");
  if (existsSync(main)) out.push(main);
  const sources = join(addressBookDir, "Sources");
  if (existsSync(sources)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(sources);
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const p = join(sources, e, "AddressBook-v22.abcddb");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  try {
    return (db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>).map((r) => r.name);
  } catch {
    return [];
  }
}

export function inspectAddressBookStore(path: string): AddressBookSchemaInfo {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = 1");
    db.exec("PRAGMA busy_timeout = 3000");
    const recordColumns = tableColumns(db, "ZABCDRECORD");
    const phoneColumns = tableColumns(db, "ZABCDPHONENUMBER");
    const emailColumns = tableColumns(db, "ZABCDEMAILADDRESS");
    const info: AddressBookSchemaInfo = { path, recordColumns, phoneColumns, emailColumns, ok: true };
    if (recordColumns.length === 0) {
      info.ok = false;
      info.reason = "ZABCDRECORD table missing";
    } else if (!recordColumns.includes("Z_PK")) {
      info.ok = false;
      info.reason = "ZABCDRECORD.Z_PK missing";
    } else if (!phoneColumns.includes("ZFULLNUMBER") && !emailColumns.includes("ZADDRESS")) {
      info.ok = false;
      info.reason = "neither ZABCDPHONENUMBER.ZFULLNUMBER nor ZABCDEMAILADDRESS.ZADDRESS present";
    }
    return info;
  } catch (err) {
    return { path, recordColumns: [], phoneColumns: [], emailColumns: [], ok: false, reason: (err as Error).message };
  } finally {
    db?.close();
  }
}

function pick(cols: string[], candidates: string[]): string | undefined {
  return candidates.find((c) => cols.includes(c));
}

/** Build a ContactIndex from one AddressBook store. Read-only; tolerant of schema drift. */
export function loadAddressBookStore(path: string, index: ContactIndex, log?: Logger): number {
  const info = inspectAddressBookStore(path);
  if (!info.ok) {
    log?.warn("contacts_store_skipped", { store: path, reason: info.reason });
    return 0;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = 1");
    db.exec("PRAGMA busy_timeout = 3000");
    const rc = info.recordColumns;
    const first = pick(rc, ["ZFIRSTNAME"]);
    const last = pick(rc, ["ZLASTNAME"]);
    const middle = pick(rc, ["ZMIDDLENAME"]);
    const org = pick(rc, ["ZORGANIZATION"]);
    const nick = pick(rc, ["ZNICKNAME"]);
    const sel = [first, last, middle, org, nick].filter((c): c is string => !!c).map((c) => `r.${c}`);
    if (sel.length === 0) return 0;
    const records = db.prepare(`SELECT r.Z_PK AS pk, ${sel.join(", ")} FROM ZABCDRECORD r`).all() as Array<Record<string, unknown>>;

    const phonesByOwner = new Map<number, string[]>();
    const emailsByOwner = new Map<number, string[]>();
    if (info.phoneColumns.includes("ZFULLNUMBER") && info.phoneColumns.includes("ZOWNER")) {
      for (const row of db.prepare("SELECT ZOWNER AS owner, ZFULLNUMBER AS v FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL").all() as Array<{ owner: number; v: string }>) {
        const l = phonesByOwner.get(Number(row.owner)) ?? [];
        l.push(String(row.v));
        phonesByOwner.set(Number(row.owner), l);
      }
    }
    if (info.emailColumns.includes("ZADDRESS") && info.emailColumns.includes("ZOWNER")) {
      for (const row of db.prepare("SELECT ZOWNER AS owner, ZADDRESS AS v FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL").all() as Array<{ owner: number; v: string }>) {
        const l = emailsByOwner.get(Number(row.owner)) ?? [];
        l.push(String(row.v));
        emailsByOwner.set(Number(row.owner), l);
      }
    }

    let added = 0;
    for (const r of records) {
      const pk = Number(r.pk);
      const phones = phonesByOwner.get(pk) ?? [];
      const emails = emailsByOwner.get(pk) ?? [];
      if (phones.length === 0 && emails.length === 0) continue;
      const name = buildDisplayName({
        first: str(first && r[first]),
        last: str(last && r[last]),
        middle: str(middle && r[middle]),
        org: str(org && r[org]),
        nick: str(nick && r[nick]),
      });
      if (!name) continue;
      index.add(name, phones, emails);
      added++;
    }
    index.sources.push(path);
    return added;
  } finally {
    db.close();
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function buildDisplayName(p: { first?: string | undefined; last?: string | undefined; middle?: string | undefined; org?: string | undefined; nick?: string | undefined }): string | undefined {
  const parts = [p.first, p.middle, p.last].filter((s): s is string => !!s);
  if (parts.length > 0) return parts.join(" ");
  if (p.nick) return p.nick;
  if (p.org) return p.org;
  return undefined;
}

/** Resolver backed by the AddressBook stores; rebuilds when any store file changes. */
export class AddressBookResolver implements ContactResolver {
  private index = new ContactIndex();
  private stamp = "";

  constructor(
    private readonly addressBookDir: string,
    private readonly log?: Logger,
  ) {
    this.refreshIfChanged();
  }

  private currentStamp(): string {
    const stores = findAddressBookStores(this.addressBookDir);
    return stores
      .map((p) => {
        try {
          const st = statSync(p);
          const wal = existsSync(p + "-wal") ? statSync(p + "-wal").mtimeMs : 0;
          return `${p}:${st.mtimeMs}:${wal}`;
        } catch {
          return `${p}:?`;
        }
      })
      .join("|");
  }

  refreshIfChanged(): void {
    const stamp = this.currentStamp();
    if (stamp === this.stamp) return;
    const fresh = new ContactIndex();
    let contacts = 0;
    for (const store of findAddressBookStores(this.addressBookDir)) {
      try {
        contacts += loadAddressBookStore(store, fresh, this.log);
      } catch (err) {
        this.log?.warn("contacts_store_error", { store, errMessage: (err as Error).message.slice(0, 120) });
      }
    }
    this.index = fresh;
    this.stamp = stamp;
    this.log?.info("contacts_loaded", { stores: fresh.sources.length, contacts });
  }

  resolve(handle: string | null | undefined): ResolvedContact | undefined {
    return this.index.resolve(handle);
  }

  get size(): number {
    return this.index.size;
  }

  get sources(): string[] {
    return this.index.sources;
  }
}

export function createContactResolver(enabled: boolean, addressBookDir: string, log: Logger): ContactResolver {
  if (!enabled) return new NullContactResolver();
  const stores = findAddressBookStores(addressBookDir);
  if (stores.length === 0) {
    log.warn("contacts_unavailable", { addressBookDir });
    return new NullContactResolver();
  }
  return new AddressBookResolver(addressBookDir, log);
}
