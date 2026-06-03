import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { deserialize } from "bun:jsc";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { openDb, createRegistry, sha256hex, crockford32 } from "../src/server/registry.ts";

describe("sha256hex", () => {
  it("returns hex sha256 of the token", () => {
    // Known SHA-256 of the empty string.
    expect(sha256hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("crockford32", () => {
  it("encodes known vectors (MSB-first, 5 bits/char, low bits zero-padded)", () => {
    // 0xff = 11111111 -> 11111 | 111(00) -> index 31 then 28 = "z","w".
    expect(crockford32(Buffer.from([0xff]))).toBe("zw");
    // 0xff,0x00 = 11111111 00000000 -> 11111|11100|00000|0 -> z,w,0,0.
    expect(crockford32(Buffer.from([0xff, 0x00]))).toBe("zw00");
    // 16 zero bytes -> 26 zero chars.
    expect(crockford32(Buffer.alloc(16, 0x00))).toBe("0".repeat(26));
    // 16 0xff bytes -> 25 all-ones groups ("z") + final 111(00)=28 ("w").
    expect(crockford32(Buffer.alloc(16, 0xff))).toBe("z".repeat(25) + "w");
  });

  it("maps 16 random bytes to a 26-char DNS-safe label with no ambiguous chars", () => {
    const s = crockford32(Buffer.alloc(16, 0x9c));
    expect(s).toHaveLength(26);
    expect(s).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/); // excludes i, l, o, u
  });
});

describe("openDb", () => {
  it("creates the devices table so insert/select works", () => {
    const db = openDb(":memory:");
    db.run(
      `INSERT INTO devices (subdomain, account, device_id, created_at, revoked, token_hash, record)
       VALUES ('gabc','acct','dev',1,0,'deadbeef',X'00')`,
    );
    const row = db.query("SELECT subdomain, revoked, token_hash FROM devices WHERE account='acct'").get() as {
      subdomain: string;
      revoked: number;
      token_hash: string;
    };
    expect(row.subdomain).toBe("gabc");
    expect(row.revoked).toBe(0);
    expect(row.token_hash).toBe("deadbeef");
    db.close();
  });

  it("migrates a pre-sessions DB lacking token_hash by adding the column", () => {
    const path = join(tmpdir(), `gini-mig-${randomBytes(6).toString("hex")}.db`);
    // Build the OLD schema: a devices table with no token_hash column.
    const old = new Database(path, { create: true });
    old.run(`CREATE TABLE devices (
      subdomain  TEXT PRIMARY KEY,
      account    TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked    INTEGER NOT NULL DEFAULT 0,
      record     BLOB NOT NULL
    );`);
    old.run(`INSERT INTO devices (subdomain, account, device_id, created_at, revoked, record)
             VALUES ('gold','acct','dev',1,0,X'00')`);
    old.close();

    // openDb must ADD token_hash (no crash) and leave the existing row intact.
    const db = openDb(path);
    const cols = (db.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("token_hash");
    const row = db.query("SELECT token_hash FROM devices WHERE subdomain='gold'").get() as {
      token_hash: string | null;
    };
    expect(row.token_hash).toBeNull(); // pre-existing rows have no token until re-login
    db.close();

    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  });
});

describe("createRegistry", () => {
  let db: Database;
  let nowVal: number;
  const nowMs = () => nowVal;

  beforeEach(() => {
    db = openDb(":memory:");
    nowVal = 1000;
  });

  it("createSession mints a token, stores only its hash, and verifyToken resolves it", () => {
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, 0xaa), nowMs });
    const { subdomain, token } = reg.createSession("a", "d1");

    expect(subdomain).toBe(crockford32(Buffer.alloc(16, 0xaa)));
    expect(subdomain).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect(token).toMatch(/^gsk_[A-Za-z0-9_-]+$/);

    // The raw token is never stored — only its hash.
    const stored = db.query("SELECT token_hash FROM devices WHERE subdomain=$s").get({ $s: subdomain }) as {
      token_hash: string;
    };
    expect(stored.token_hash).toBe(sha256hex(token));
    expect(stored.token_hash).not.toBe(token);

    // verifyToken resolves the live token to its identity.
    expect(reg.verifyToken(token)).toEqual({ account: "a", device_id: "d1", subdomain });

    // A wrong token resolves to null.
    expect(reg.verifyToken("gsk_wrong")).toBeNull();

    const rows = reg.listDevices("a");
    expect(rows.length).toBe(1);
    expect(rows[0]!.subdomain).toBe(subdomain);
    expect(rows[0]!.created_at).toBe(1000);
    expect(rows[0]!.revoked).toBe(0);
  });

  it("re-login rotates the token (old one dies) and keeps the subdomain", () => {
    let n = 0;
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, n++), nowMs });
    nowVal = 500;
    const first = reg.createSession("a", "d1");
    nowVal = 600;
    const second = reg.createSession("a", "d1");

    // Same subdomain kept across the re-login.
    expect(second.subdomain).toBe(first.subdomain);
    // The token actually rotated.
    expect(second.token).not.toBe(first.token);

    // Old token is dead; new token works.
    expect(reg.verifyToken(first.token)).toBeNull();
    expect(reg.verifyToken(second.token)).toEqual({
      account: "a",
      device_id: "d1",
      subdomain: first.subdomain,
    });

    // Still exactly one row; the UPDATE keeps the original created_at column.
    const rows = reg.listDevices("a");
    expect(rows.length).toBe(1);
    expect(rows[0]!.created_at).toBe(500);
    expect(rows[0]!.revoked).toBe(0);
  });

  it("re-login after revoke reactivates the same subdomain with a fresh token", () => {
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, 0x77), nowMs });
    const first = reg.createSession("a", "d1");
    expect(reg.revoke("a", first.subdomain)).toBe(1);
    expect(reg.verifyToken(first.token)).toBeNull();

    const second = reg.createSession("a", "d1");
    expect(second.subdomain).toBe(first.subdomain);
    expect(reg.verifyToken(second.token)).toEqual({
      account: "a",
      device_id: "d1",
      subdomain: first.subdomain,
    });
    const rows = reg.listDevices("a");
    expect(rows.length).toBe(1);
    expect(rows[0]!.revoked).toBe(0);
  });

  it("retries on subdomain collision then breaks on a unique value", () => {
    const taken = Buffer.alloc(16, 0x11);
    const fresh = Buffer.alloc(16, 0x22);
    const seedReg = createRegistry(db, { rng: () => taken, nowMs });
    seedReg.createSession("seed", "seeddev");
    const takenSub = crockford32(taken);

    let call = 0;
    const reg = createRegistry(db, {
      rng: () => (call++ === 0 ? taken : fresh),
      nowMs,
    });
    const { subdomain } = reg.createSession("a", "d1");
    expect(subdomain).toBe(crockford32(fresh));
    expect(subdomain).not.toBe(takenSub);
    expect(call).toBe(2);
  });

  it("listDevices returns rows oldest-first including revoked", () => {
    let n = 1;
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, n++), nowMs });
    nowVal = 100;
    reg.createSession("a", "d1");
    nowVal = 200;
    reg.createSession("a", "d2");
    nowVal = 300;
    const third = reg.createSession("a", "d3");
    reg.revoke("a", third.subdomain);

    const rows = reg.listDevices("a");
    expect(rows.map((r) => r.device_id)).toEqual(["d1", "d2", "d3"]);
    expect(rows.map((r) => r.created_at)).toEqual([100, 200, 300]);
    expect(rows.map((r) => r.revoked)).toEqual([0, 0, 1]);
  });

  it("revoke kills the token, returns changes>0, and re-revoke returns 0", () => {
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, 0x33), nowMs });
    const { subdomain, token } = reg.createSession("a", "d1");

    expect(reg.verifyToken(token)).not.toBeNull();
    expect(reg.revoke("a", subdomain)).toBe(1); // active -> revoked
    expect(reg.verifyToken(token)).toBeNull(); // token now dead
    expect(reg.revoke("a", subdomain)).toBe(0); // already revoked: no transition
    expect(reg.revoke("a", "gnonexistent")).toBe(0); // unknown subdomain

    const rows = reg.listDevices("a");
    expect(rows[0]!.revoked).toBe(1);
  });

  it("keeps the record blob authoritative: token_hash included, revoked refreshed on revoke", () => {
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, 0x55), nowMs });
    const { subdomain, token } = reg.createSession("a", "d1");

    const readBlob = () =>
      deserialize(
        (db.query("SELECT record FROM devices WHERE subdomain=$s").get({ $s: subdomain }) as { record: Uint8Array })
          .record,
      ) as { subdomain: string; account: string; device_id: string; created_at: number; token_hash: string; revoked: boolean };

    // The blob mirrors every flat column, including token_hash, while active.
    const active = readBlob();
    expect(active).toEqual({
      subdomain,
      account: "a",
      device_id: "d1",
      created_at: 1000,
      token_hash: sha256hex(token),
      revoked: false,
    });

    // After revoke, the blob is rewritten — revoked flips to true (no stale archive).
    expect(reg.revoke("a", subdomain)).toBe(1);
    const revoked = readBlob();
    expect(revoked.revoked).toBe(true);
    expect(revoked.token_hash).toBe(sha256hex(token));
  });

  it("verifyToken returns null for non-string input (missing/garbage metadata)", () => {
    const reg = createRegistry(db, { rng: () => Buffer.alloc(16, 0x44), nowMs });
    reg.createSession("a", "d1");
    expect(reg.verifyToken(undefined)).toBeNull();
    expect(reg.verifyToken(null)).toBeNull();
    expect(reg.verifyToken(123)).toBeNull();
    expect(reg.verifyToken({})).toBeNull();
  });

  it("uses default rng and clock when not injected", () => {
    const reg = createRegistry(db);
    const { subdomain, token } = reg.createSession("a", "d1");
    expect(subdomain).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
    expect(reg.verifyToken(token)).toEqual({ account: "a", device_id: "d1", subdomain });
    const rows = reg.listDevices("a");
    expect(rows[0]!.created_at).toBeGreaterThan(0);
  });
});
