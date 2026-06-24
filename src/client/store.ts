/**
 * Local credential store under ~/.gini-relay: a stable device id and the current
 * session (opaque bearer token + assigned subdomain). Both files are written owner-only
 * (0600) and atomically (temp + rename) so a concurrent reader never sees a
 * half-written file. `home` and the id generator are injectable for tests.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Session {
  token: string;
  subdomain: string;
  account?: string;
  /**
   * Google refresh token from an offline (Workspace-scoped) login, present only
   * when the login requested Workspace services. Bound to the relay's OAuth
   * client, so a consumer pairs it with that client's id/secret to mint access
   * tokens. Absent for an identity-only login.
   */
  refreshToken?: string;
}

export interface Store {
  readonly home: string;
  /** Stable per-install device id, created on first use. */
  deviceId(): string;
  /** Current session, or null if not logged in. */
  readSession(): Session | null;
  /** Persists the session (owner-only, atomic). */
  writeSession(session: Session): void;
  /** Removes the persisted session (logout). Keeps the device id. */
  clearSession(): void;
}

export interface StoreOptions {
  home?: string;
  genId?: () => string;
  /** Resolver for the user's home dir (injectable for tests); defaults to os.homedir. */
  homedirFn?: () => string;
}

export function createStore(opts: StoreOptions = {}): Store {
  const resolveHomedir = opts.homedirFn ?? homedir;
  const home = opts.home ?? process.env.GINI_HOME ?? join(resolveHomedir(), ".gini-relay");
  const genId = opts.genId ?? randomUUID;
  const deviceIdPath = join(home, "device.json");
  const sessionPath = join(home, "session.json");

  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700); // tighten the dir if it pre-existed with looser perms (mkdir's mode is ignored then)

  function atomicWrite(path: string, data: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path); // rename preserves the temp file's 0600 mode
  }

  return {
    home,
    deviceId() {
      if (existsSync(deviceIdPath)) {
        return (JSON.parse(readFileSync(deviceIdPath, "utf8")) as { device_id: string }).device_id;
      }
      const id = genId();
      atomicWrite(deviceIdPath, JSON.stringify({ device_id: id }, null, 2));
      return id;
    },
    readSession() {
      if (!existsSync(sessionPath)) return null;
      return JSON.parse(readFileSync(sessionPath, "utf8")) as Session;
    },
    writeSession(session) {
      atomicWrite(sessionPath, JSON.stringify(session, null, 2));
    },
    clearSession() {
      rmSync(sessionPath, { force: true });
    },
  };
}
