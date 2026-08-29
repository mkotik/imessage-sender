import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { phoneKeys, isShortCode, normalizeEmail } from "../src/contacts/phone.js";
import { ContactIndex, AddressBookResolver, buildDisplayName, findAddressBookStores, inspectAddressBookStore, createContactResolver } from "../src/contacts/resolver.js";
import { Logger } from "../src/logging/logger.js";
import { maskHandle, shortGuid } from "../src/privacy/redact.js";

describe("phone normalisation", () => {
  it("US formats collapse to the same key", () => {
    const a = phoneKeys("+1 (555) 010-0199")!;
    const b = phoneKeys("5550100199")!;
    const c = phoneKeys("1-555-010-0199")!;
    assert.equal(a.full, "15550100199");
    assert.equal(b.full, "15550100199");
    assert.equal(c.full, "15550100199");
    assert.equal(a.last10, "5550100199");
  });
  it("international numbers keep their country code", () => {
    assert.equal(phoneKeys("+44 20 7946 0958")!.full, "442079460958");
    assert.equal(phoneKeys("0044 20 7946 0958")!.full, "442079460958");
  });
  it("extensions are dropped", () => {
    assert.equal(phoneKeys("555-010-0199 x204")!.full, "15550100199");
  });
  it("emails and junk return undefined", () => {
    assert.equal(phoneKeys("a@b.c"), undefined);
    assert.equal(phoneKeys("12"), undefined);
  });
  it("short codes", () => {
    assert.equal(isShortCode("22395"), true);
    assert.equal(isShortCode("+15550100199"), false);
  });
  it("emails lower-case", () => {
    assert.equal(normalizeEmail("  Alice@Example.COM "), "alice@example.com");
  });
});

describe("ContactIndex", () => {
  const idx = new ContactIndex();
  idx.add("Alice Example", ["(555) 010-0101", "+44 20 7946 0958"], ["alice@example.com"]);
  idx.add("Bob Builder", ["555-010-0102"], []);
  idx.add("Bob Builder (work)", ["555-010-0102"], []); // duplicate number → ambiguous
  idx.add("Carol", [], ["CAROL@example.com", "c2@example.com"]);

  it("resolves phones in any format", () => {
    assert.equal(idx.resolve("+15550100101")?.displayName, "Alice Example");
    assert.equal(idx.resolve("5550100101")?.displayName, "Alice Example");
    assert.equal(idx.resolve("+442079460958")?.displayName, "Alice Example");
  });
  it("resolves emails case-insensitively", () => {
    assert.equal(idx.resolve("Alice@Example.com")?.displayName, "Alice Example");
    assert.equal(idx.resolve("carol@example.com")?.displayName, "Carol");
    assert.equal(idx.resolve("c2@example.com")?.displayName, "Carol");
  });
  it("marks ambiguous matches deterministically", () => {
    const r = idx.resolve("+15550100102")!;
    assert.equal(r.ambiguous, true);
    assert.equal(r.displayName, "Bob Builder");
  });
  it("unknown, short code and business handles resolve to undefined", () => {
    assert.equal(idx.resolve("+15550109999"), undefined);
    assert.equal(idx.resolve("22395"), undefined);
    assert.equal(idx.resolve("urn:biz:abc"), undefined);
    assert.equal(idx.resolve(null), undefined);
  });
  it("display name precedence", () => {
    assert.equal(buildDisplayName({ first: "A", last: "B" }), "A B");
    assert.equal(buildDisplayName({ first: "A", middle: "M", last: "B" }), "A M B");
    assert.equal(buildDisplayName({ nick: "Nick", org: "Org" }), "Nick");
    assert.equal(buildDisplayName({ org: "Org" }), "Org");
    assert.equal(buildDisplayName({}), undefined);
  });
});

describe("AddressBook store reader", () => {
  const dir = mkdtempSync(join(tmpdir(), "abtest-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  function makeStore(path: string, rows: Array<{ first?: string; last?: string; org?: string; phones?: string[]; emails?: string[] }>) {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, ZFIRSTNAME VARCHAR, ZLASTNAME VARCHAR, ZMIDDLENAME VARCHAR, ZORGANIZATION VARCHAR, ZNICKNAME VARCHAR);
      CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR);
      CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR);
    `);
    let pk = 1;
    for (const r of rows) {
      db.prepare("INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION) VALUES (?, 19, ?, ?, ?)").run(pk, r.first ?? null, r.last ?? null, r.org ?? null);
      for (const p of r.phones ?? []) db.prepare("INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)").run(pk, p);
      for (const e of r.emails ?? []) db.prepare("INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)").run(pk, e);
      pk++;
    }
    db.close();
  }

  it("finds main + Sources stores and resolves across them", () => {
    const abDir = join(dir, "AddressBook");
    mkdirSync(join(abDir, "Sources", "ABCD-1"), { recursive: true });
    makeStore(join(abDir, "AddressBook-v22.abcddb"), [{ first: "Main", last: "Person", phones: ["+1 555 010 0201"] }]);
    makeStore(join(abDir, "Sources", "ABCD-1", "AddressBook-v22.abcddb"), [
      { first: "Cloud", last: "Contact", phones: ["555-010-0202"], emails: ["cloud@example.com"] },
      { org: "Some Company", phones: ["+15550100203"] },
      { first: "No", last: "Handles" },
    ]);
    assert.equal(findAddressBookStores(abDir).length, 2);
    const info = inspectAddressBookStore(join(abDir, "AddressBook-v22.abcddb"));
    assert.equal(info.ok, true);
    const log = new Logger({ level: "error", stdout: false });
    const r = new AddressBookResolver(abDir, log);
    assert.equal(r.size, 3);
    assert.equal(r.resolve("+15550100201")?.displayName, "Main Person");
    assert.equal(r.resolve("+15550100202")?.displayName, "Cloud Contact");
    assert.equal(r.resolve("cloud@example.com")?.displayName, "Cloud Contact");
    assert.equal(r.resolve("+15550100203")?.displayName, "Some Company");
    assert.equal(r.resolve("+15550100299"), undefined);
  });

  it("tolerates a store with an unexpected schema", () => {
    const abDir = join(dir, "Weird");
    mkdirSync(abDir, { recursive: true });
    const db = new DatabaseSync(join(abDir, "AddressBook-v22.abcddb"));
    db.exec("CREATE TABLE SOMETHING_ELSE (x)");
    db.close();
    const info = inspectAddressBookStore(join(abDir, "AddressBook-v22.abcddb"));
    assert.equal(info.ok, false);
    const r = new AddressBookResolver(abDir, new Logger({ level: "error", stdout: false }));
    assert.equal(r.size, 0);
    assert.equal(r.resolve("+15550100201"), undefined);
  });

  it("missing directory → null resolver", () => {
    const r = createContactResolver(true, join(dir, "nope"), new Logger({ level: "error", stdout: false }));
    assert.equal(r.size, 0);
    assert.equal(createContactResolver(false, dir, new Logger({ level: "error", stdout: false })).size, 0);
  });
});

describe("redaction helpers", () => {
  it("masks phones and emails", () => {
    assert.equal(maskHandle("+15550100199"), "+1••••••0199");
    assert.equal(maskHandle("alice@example.com"), "a•••@example.com");
    assert.equal(maskHandle("22395"), "short:•••••");
    assert.equal(maskHandle(undefined), "(none)");
    assert.ok(!maskHandle("+15550100199").includes("5550100"));
  });
  it("shortGuid is a prefix only", () => {
    assert.equal(shortGuid("ABCDEFGH-1234"), "ABCDEFGH");
  });
});
