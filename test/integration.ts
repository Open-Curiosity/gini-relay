#!/usr/bin/env bun
/**
 * Self-contained integration test for the relay brain.
 *
 * Spawns a fresh stub-mode brain on a per-run port + DB, drives the whole HTTP
 * surface, asserts, and tears down. Run: `bun test/integration.ts`. Exits
 * non-zero if anything fails.
 *
 * Auth is opaque-session: /auth/exchange mints a `gsk_…` token whose sha256 the
 * brain stores; there is NO signing key, so nothing Ed25519/JWT here.
 */
import { rmSync } from "node:fs";

const probe = Bun.serve({ port: 0, fetch: () => new Response("") }); // grab an OS-assigned free port
const PORT = probe.port;
probe.stop(true);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = `/tmp/gini-test-flow-${process.pid}.db`;
const cleanDb = () => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s); } catch {} } };
cleanDb();

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(name); console.log(`FAIL  ${name}`); }
}
const J = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(BASE + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

// Opaque-session brain: no signing key — stub mode just needs GINI_ALLOW_STUB=1
// and empty Google creds.
const brain = Bun.spawn(["bun", "src/server/bin.ts"], {
  env: { ...process.env, GINI_PLUGIN_PORT: String(PORT), GINI_DB: DB, GINI_PUBLIC_URL: BASE, GINI_GOOGLE_CLIENT_ID: "", GINI_GOOGLE_CLIENT_SECRET: "", GINI_ALLOW_STUB: "1" },
  stdout: "ignore", stderr: "ignore",
});

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/devices"); if (r.status === 401) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("brain did not start");
}

// Stub login: no Google, so /auth/exchange trusts the supplied account (dev only)
// and returns an opaque session token + the device's owned subdomain.
async function stubLogin(deviceId: string, account: string): Promise<{ token: string; subdomain: string }> {
  const s = (await (await J("POST", "/auth/exchange", { account, device_id: deviceId })).json()) as { token: string; subdomain: string; account: string };
  check(`exchange issued token for ${account}`, !!s.token && s.token.startsWith("gsk_") && !!s.subdomain && s.account === account);
  return s;
}

try {
  await waitUp();

  // ── login (stub exchange) + namespacing ─────────────────────────────────
  const alice = await stubLogin("dev1", "alice@example.com");
  const bob = await stubLogin("dev1", "bob@example.com"); // SAME device_id string
  check("namespacing: same device_id, different account => different subdomain", alice.subdomain !== bob.subdomain);

  // ── exchange / google-url input handling ────────────────────────────────
  const noDev = await J("POST", "/auth/exchange", { account: "x@example.com" });
  check("exchange without device_id => 400", noDev.status === 400);
  const gu = await J("GET", `/auth/google-url?redirect_uri=${encodeURIComponent("http://127.0.0.1:8765/cb")}&state=abc`);
  check("google-url => 400 in stub mode", gu.status === 400);

  // ── /_frp/handler: Login ────────────────────────────────────────────────
  const loginOk = await (await J("POST", "/_frp/handler?op=Login", { content: { metas: { token: alice.token } } })).json() as { reject: boolean };
  check("Login with valid token accepted", loginOk.reject === false);
  const loginBad = await (await J("POST", "/_frp/handler?op=Login", { content: { metas: { token: "nope" } } })).json() as { reject: boolean };
  check("Login with bad token rejected", loginBad.reject === true);

  // ── /_frp/handler: NewProxy ─────────────────────────────────────────────
  const np = (extra: Record<string, unknown>) => J("POST", "/_frp/handler?op=NewProxy", {
    content: { user: { metas: { token: alice.token, device_id: "dev1" } }, proxy_name: alice.subdomain, proxy_type: "http", subdomain: alice.subdomain, bandwidth_limit: "1220KB", bandwidth_limit_mode: "server", ...extra },
  });
  check("NewProxy valid accepted", (await (await np({})).json() as { reject: boolean }).reject === false);
  check("NewProxy wrong subdomain rejected", (await (await np({ subdomain: "gWRONG" }).then(r => r.json())) as { reject: boolean }).reject === true);
  check("NewProxy over-tier bandwidth rejected", (await (await np({ bandwidth_limit: "5MB" }).then(r => r.json())) as { reject: boolean }).reject === true);
  check("NewProxy client-mode bandwidth rejected", (await (await np({ bandwidth_limit_mode: "client" }).then(r => r.json())) as { reject: boolean }).reject === true);
  check("NewProxy with custom_domains rejected", (await (await np({ custom_domains: ["evil.gini-relay.lilaclabs.ai"] }).then(r => r.json())) as { reject: boolean }).reject === true);
  check("NewProxy malformed (NaN) bandwidth rejected", (await (await np({ bandwidth_limit: "garbageMB" }).then(r => r.json())) as { reject: boolean }).reject === true);
  check("NewProxy non-http proxy_type rejected", (await (await np({ proxy_type: "tcp", remote_port: 2222 }).then(r => r.json())) as { reject: boolean }).reject === true);
  check("NewProxy mismatched proxy_name rejected (no tier multiplying)", (await (await np({ proxy_name: "g-second-proxy" }).then(r => r.json())) as { reject: boolean }).reject === true);
  const npNoTok = await J("POST", "/_frp/handler?op=NewProxy", { content: { user: { metas: { token: "", device_id: "dev1" } }, proxy_type: "http", subdomain: alice.subdomain, bandwidth_limit: "1220KB", bandwidth_limit_mode: "server" } });
  check("NewProxy without token rejected", (await npNoTok.json() as { reject: boolean }).reject === true);

  // ── /devices: list + revoke ─────────────────────────────────────────────
  const list = await (await J("GET", "/devices", undefined, { authorization: `Bearer ${alice.token}` })).json() as { devices: Array<{ device_id: string; subdomain: string }> };
  check("devices list shows alice's dev1", list.devices.some(d => d.device_id === "dev1" && d.subdomain === alice.subdomain));
  const noauth = await J("GET", "/devices");
  check("devices without token => 401", noauth.status === 401);
  const del = await (await J("DELETE", `/devices/${alice.subdomain}`, undefined, { authorization: `Bearer ${alice.token}` })).json() as { revoked: boolean };
  check("revoke alice's device succeeds", del.revoked === true);

  // Session revocation kills the TOKEN, not just the tunnel: the same token that
  // logged in above must now fail verifyToken at Login.
  const loginAfterRevoke = await (await J("POST", "/_frp/handler?op=Login", { content: { metas: { token: alice.token } } })).json() as { reject: boolean };
  check("revoked token now rejected at Login (session killed, not just tunnel)", loginAfterRevoke.reject === true);

  // re-login for the SAME (account, device_id) reactivates the row with a fresh
  // token (no UNIQUE crash); the fresh token works at Login.
  const alice2 = await stubLogin("dev1", "alice@example.com");
  check("re-login issues a working fresh token", alice2.token !== alice.token);
  const loginFresh = await (await J("POST", "/_frp/handler?op=Login", { content: { metas: { token: alice2.token } } })).json() as { reject: boolean };
  check("fresh token accepted at Login after re-login", loginFresh.reject === false);
} catch (e) {
  fails.push(`exception: ${(e as Error).message}`);
} finally {
  brain.kill();
  await brain.exited;
  cleanDb();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
console.log("ALL GREEN");
