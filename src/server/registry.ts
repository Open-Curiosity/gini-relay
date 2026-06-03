/**
 * Namespaced subdomain registry backed by SQLite.
 *
 * One row per (account, device_id): a random 128-bit subdomain owned by that
 * device, plus the sha256 hash of its opaque session token. The full record is
 * also kept as a serialized blob (source of truth); the flat columns are the
 * queryable index. A revoked row stays in place so the unique (account,
 * device_id) index lets a re-login reactivate it with a fresh token (and a fresh
 * token_hash) instead of colliding.
 *
 * The session token itself is never stored — only `sha256(token)` hex — so the
 * raw secret returned to the client at login cannot be recovered from the DB.
 */
import { Database } from "bun:sqlite";
import { serialize } from "bun:jsc";
import { randomBytes, createHash } from "node:crypto";

export interface DeviceRow {
  device_id: string;
  subdomain: string;
  created_at: number;
  revoked: number;
}

export interface Registry {
  /**
   * Mints a fresh opaque session token for the (account, device_id), creating
   * or reactivating the device row. Stores only sha256(token); returns the raw
   * token ONCE (it cannot be recovered later) along with the owned subdomain.
   */
  createSession(account: string, deviceId: string): { subdomain: string; token: string };
  /** Lists every device row for an account (including revoked), oldest first. */
  listDevices(account: string): DeviceRow[];
  /** Soft-revokes a subdomain owned by the account; returns rows changed. */
  revoke(account: string, subdomain: string): number;
  /** Resolves an opaque token to its active owner, or null (non-strings included). Never mutates. */
  verifyToken(token: unknown): { account: string; device_id: string; subdomain: string } | null;
}

/** Hex sha256 of an opaque token — the only form of the secret kept on disk. */
export function sha256hex(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Lowercase Crockford Base32 alphabet: digits 0-9 plus 22 letters with the
// visually ambiguous I, L, O, U removed. DNS labels are case-insensitive, so we
// emit lowercase. https://www.crockford.com/base32.html
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Encodes bytes as a Crockford Base32 string (5 bits per character, MSB-first).
 * 16 random bytes (128 bits) → 26 characters: the unguessable subdomain. The
 * final character carries the last 3 bits left-aligned (2 zero-padding bits).
 */
export function crockford32(bytes: Buffer): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) >>> 0;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** Opens (creating if needed) the registry database with its schema applied. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.run(`CREATE TABLE IF NOT EXISTS devices (
  subdomain  TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  token_hash TEXT,
  record     BLOB NOT NULL
);`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_owner ON devices(account, device_id);`);
  // Migrate a pre-sessions DB that lacks token_hash before we index it (SQLite has
  // no ADD COLUMN IF NOT EXISTS). A fresh DB already has the column from CREATE TABLE.
  const cols = db.query("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "token_hash")) {
    db.run("ALTER TABLE devices ADD COLUMN token_hash TEXT");
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);`);
  return db;
}

export interface RegistryOptions {
  /** Random 16-byte source for subdomain generation (injectable for tests). */
  rng?: () => Buffer;
  /** Clock in ms (injectable for tests). */
  nowMs?: () => number;
}

export function createRegistry(db: Database, opts: RegistryOptions = {}): Registry {
  const rng = opts.rng ?? (() => Buffer.from(randomBytes(16)));
  const now = opts.nowMs ?? Date.now;

  return {
    createSession(account, deviceId) {
      const token = "gsk_" + randomBytes(32).toString("base64url");
      const hash = sha256hex(token);
      const existing = db
        .query("SELECT subdomain, created_at FROM devices WHERE account=$a AND device_id=$d")
        .get({ $a: account, $d: deviceId }) as { subdomain: string; created_at: number } | null;
      if (existing) {
        // Keep the device's subdomain AND its original created_at; rotate the token
        // (new hash) and reactivate. The blob mirrors every flat column (no drift).
        const rec = { subdomain: existing.subdomain, account, device_id: deviceId, created_at: existing.created_at, token_hash: hash, revoked: false };
        db.query(
          "UPDATE devices SET token_hash=$h, revoked=0, record=$r WHERE account=$a AND device_id=$d",
        ).run({ $h: hash, $r: serialize(rec, { binaryType: "nodebuffer" }), $a: account, $d: deviceId });
        return { subdomain: existing.subdomain, token };
      }
      const createdAt = now();
      let subdomain = "";
      for (let i = 0; i < 5; i++) {
        subdomain = crockford32(rng());
        if (!db.query("SELECT 1 FROM devices WHERE subdomain=$s").get({ $s: subdomain })) break;
      }
      const rec = { subdomain, account, device_id: deviceId, created_at: createdAt, token_hash: hash, revoked: false };
      db.query(
        `INSERT INTO devices (subdomain, account, device_id, created_at, revoked, token_hash, record)
         VALUES ($s,$a,$d,$c,0,$h,$r)`,
      ).run({ $s: subdomain, $a: account, $d: deviceId, $c: createdAt, $h: hash, $r: serialize(rec, { binaryType: "nodebuffer" }) });
      return { subdomain, token };
    },

    listDevices(account) {
      return db
        .query("SELECT device_id, subdomain, created_at, revoked FROM devices WHERE account=$a ORDER BY created_at")
        .all({ $a: account }) as DeviceRow[];
    },

    revoke(account, subdomain) {
      // Only an ACTIVE row transitions; re-revoking an already-revoked (or unknown)
      // subdomain returns 0, not 1. Rebuild the blob from the flat columns so it
      // stays the authoritative archive (revoked flips to true) instead of going stale.
      const row = db
        .query("SELECT subdomain, account, device_id, created_at, token_hash FROM devices WHERE account=$a AND subdomain=$s AND revoked=0")
        .get({ $a: account, $s: subdomain }) as
        | { subdomain: string; account: string; device_id: string; created_at: number; token_hash: string | null }
        | null;
      if (!row) return 0;
      const rec = { subdomain: row.subdomain, account: row.account, device_id: row.device_id, created_at: row.created_at, token_hash: row.token_hash, revoked: true };
      const r = db.query("UPDATE devices SET revoked=1, record=$r WHERE account=$a AND subdomain=$s AND revoked=0")
        .run({ $r: serialize(rec, { binaryType: "nodebuffer" }), $a: account, $s: subdomain });
      return r.changes;
    },

    verifyToken(token) {
      // Fail closed on non-string (missing/garbage frps metadata): don't hash undefined.
      if (typeof token !== "string") return null;
      const row = db
        .query("SELECT account, device_id, subdomain FROM devices WHERE token_hash=$h AND revoked=0")
        .get({ $h: sha256hex(token) }) as { account: string; device_id: string; subdomain: string } | null;
      return row ?? null;
    },
  };
}
