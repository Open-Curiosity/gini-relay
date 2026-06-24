/**
 * The brain's HTTP surface as a pure request handler. `createApp(deps)` returns
 * a `fetch(req)` function so the whole policy can be exercised with plain
 * `Request` objects in tests; the thin bin entry wires real deps and serves it.
 *
 * Routes:
 *   GET    /.well-known/apple-app-site-association   Apple universal-link assoc (served at the apex)
 *   GET    /auth/google-url      Google consent URL for a loopback redirect
 *   POST   /auth/exchange        code (+PKCE) -> { token, subdomain, account }
 *   GET    /devices              list the caller's devices (Bearer token)
 *   DELETE /devices/:subdomain   revoke one (Bearer token)
 *   POST   /_frp/handler         frps server-plugin RPC (Login + NewProxy policy)
 */
import { LOOPBACK_REDIRECTS, SERVICE_SCOPES } from "./oauth.ts";
import { BANDWIDTH, CAP_BYTES, SUPPORTED_PROXY, parseBw } from "./bandwidth.ts";
import type { Registry } from "./registry.ts";

export interface AppDeps {
  registry: Registry;
  googleLive: boolean;
  authUrl: (redirectUri: string, state: string, codeChallenge: string, services: string[]) => string;
  exchange: (code: string, redirectUri: string, codeVerifier: string) => Promise<{ account: string; email: string | null }>;
  log?: (msg: string) => void;
  /**
   * App ID (`TeamID.bundleID`) published in the Apple App Site Association file.
   * iOS validates a wildcard associated domain (`applinks:*.<relay>`) by fetching
   * the AASA from the wildcard's ROOT — the apex — via Apple's CDN, not from the
   * per-device tunnel subdomain. The apex routes here (Caddy: apex -> brain), so
   * the brain must serve it or universal links into tunneled subdomains never
   * validate and scanned links fall back to Safari. Defaults to the Gini mobile
   * app; override via GINI_IOS_APP_ID at the bin entry.
   */
  iosAppId?: string;
}

const J = (o: unknown, status = 200): Response => Response.json(o as never, { status });
const bearer = (req: Request): string => (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");

const DEFAULT_IOS_APP_ID = "WB6Y3K67AB.ai.lilaclabs.gini.mobile";

/** Apple App Site Association body authorizing the app on every relay subdomain. */
function appleAppSiteAssociation(appId: string): unknown {
  return {
    applinks: {
      details: [
        { appIDs: [appId], components: [{ "/": "/" }, { "/": "/pair" }, { "/": "/pair/*" }] },
      ],
    },
  };
}

export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const { registry } = deps;
  const iosAppId = deps.iosAppId ?? DEFAULT_IOS_APP_ID;

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── Apple universal links: serve the AASA at the apex ────────────────
    // The wildcard associated domain (applinks:*.<relay>) is validated by iOS
    // fetching this file from the apex via Apple's CDN; the per-subdomain copy
    // the gateway serves is never consulted for a wildcard.
    if (path === "/.well-known/apple-app-site-association" && req.method === "GET") {
      return new Response(JSON.stringify(appleAppSiteAssociation(iosAppId)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // ── login: Google consent URL for a loopback redirect ───────────────
    if (path === "/auth/google-url" && req.method === "GET") {
      if (!deps.googleLive) return J({ error: "stub_mode" }, 400);
      const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const code_challenge = url.searchParams.get("code_challenge") ?? "";
      if (!LOOPBACK_REDIRECTS.has(redirect_uri)) return J({ error: "redirect_uri must be a registered loopback" }, 400);
      if (!state) return J({ error: "state required" }, 400);
      if (!code_challenge) return J({ error: "code_challenge required" }, 400);
      // Optional `services` (comma-separated) lets the client request extra
      // Workspace scopes. Validate against the relay's allowlist (SERVICE_SCOPES)
      // HERE rather than trusting the client: the relay's own Google app bears the
      // verification + quota, so a name it isn't verified for must be dropped, not
      // forwarded. Absent/empty -> identity-only login, exactly as before.
      const services = (url.searchParams.get("services") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s in SERVICE_SCOPES);
      return J({ url: deps.authUrl(redirect_uri, state, code_challenge, services) });
    }

    // ── login: exchange the auth code (or, in dev stub, a bare account) ──
    if (path === "/auth/exchange" && req.method === "POST") {
      let b: Record<string, unknown>;
      try { b = (await req.json()) as Record<string, unknown>; } catch { b = {}; }
      const deviceId = typeof b.device_id === "string" && b.device_id && b.device_id.length <= 256 ? b.device_id : "";
      if (!deviceId) return J({ error: "device_id required" }, 400);
      let account: string;
      if (deps.googleLive) {
        const code = typeof b.code === "string" ? b.code : "";
        const redirect_uri = typeof b.redirect_uri === "string" ? b.redirect_uri : "";
        const code_verifier = typeof b.code_verifier === "string" ? b.code_verifier : "";
        if (!code) return J({ error: "code required" }, 400);
        if (!code_verifier) return J({ error: "code_verifier required" }, 400);
        if (!LOOPBACK_REDIRECTS.has(redirect_uri)) return J({ error: "bad redirect_uri" }, 400);
        try {
          account = (await deps.exchange(code, redirect_uri, code_verifier)).account;
        } catch (e) {
          return J({ error: `exchange failed: ${(e as Error).message}` }, 400);
        }
      } else {
        account = typeof b.account === "string" && b.account ? b.account : "owner@example.com";
      }
      const { subdomain, token } = registry.createSession(account, deviceId);
      log(`[auth] ${account} (device ${deviceId}) -> ${subdomain}`);
      return J({ token, subdomain, account });
    }

    // ── device management ────────────────────────────────────────────────
    if (path === "/devices" && req.method === "GET") {
      const id = registry.verifyToken(bearer(req));
      if (!id) return J({ error: "invalid token" }, 401);
      return J({ account: id.account, devices: registry.listDevices(id.account) });
    }
    if (path.startsWith("/devices/") && req.method === "DELETE") {
      const id = registry.verifyToken(bearer(req));
      if (!id) return J({ error: "invalid token" }, 401);
      const subdomain = decodeURIComponent(path.slice("/devices/".length));
      const changed = registry.revoke(id.account, subdomain);
      return J({ revoked: changed > 0, subdomain });
    }

    // ── frp server-plugin RPC (frps only) ───────────────────────────────
    if (path === "/_frp/handler") {
      const op = url.searchParams.get("op");
      let body: { content?: Record<string, unknown> };
      try { body = (await req.json()) as { content?: Record<string, unknown> }; } catch { return J({ reject: true, reject_reason: "bad body" }); }
      const c = (body?.content ?? {}) as Record<string, unknown>;

      if (op === "Login") {
        const metas = c.metas as { token?: unknown } | undefined;
        const id = registry.verifyToken(metas?.token);
        if (!id) { log("[Login] REJECT"); return J({ reject: true, reject_reason: "invalid identity token" }); }
        log(`[Login] OK — ${id.account}`);
        return J({ reject: false, unchange: true });
      }

      if (op === "NewProxy") {
        const user = c.user as { metas?: { token?: unknown } } | undefined;
        const id = registry.verifyToken(user?.metas?.token);
        if (!id) { log("[NewProxy] REJECT — token"); return J({ reject: true, reject_reason: "invalid identity token" }); }

        // Fail closed on proxy type: only subdomain-routed http tunnels.
        if (!SUPPORTED_PROXY.has(c.proxy_type as string)) {
          log(`[NewProxy] REJECT — unsupported proxy_type ${String(c.proxy_type)}`);
          return J({ reject: true, reject_reason: "only http(s) subdomain tunnels are supported" });
        }
        // custom_domains would route an arbitrary host, bypassing the namespaced subdomain.
        const customDomains = c.custom_domains ?? c.customDomains;
        if (Array.isArray(customDomains) && customDomains.length > 0) {
          log(`[NewProxy] REJECT — custom_domains ${JSON.stringify(customDomains)}`);
          return J({ reject: true, reject_reason: "custom_domains are not allowed; use your assigned subdomain" });
        }
        const declared = parseBw(c.bandwidth_limit);
        if (declared === null || declared > CAP_BYTES || c.bandwidth_limit_mode !== "server") {
          log(`[NewProxy] REJECT — bw ${String(c.bandwidth_limit)}/${String(c.bandwidth_limit_mode)}`);
          return J({ reject: true, reject_reason: `bandwidth must be <= ${BANDWIDTH} with mode=server` });
        }
        // The token resolves directly to its owned subdomain (revoked tokens fail
        // verifyToken above), so a revoked device can never reach this point.
        const expected = id.subdomain;
        if (c.subdomain !== expected) {
          log(`[NewProxy] REJECT — ${id.account}/${id.device_id} requested ${String(c.subdomain)}, owns ${expected}`);
          return J({ reject: true, reject_reason: `subdomain must be ${expected}` });
        }
        // Pin proxy_name to the subdomain: frps requires globally-unique names,
        // so a device gets exactly ONE live proxy — no multiplying the tier.
        if (c.proxy_name !== expected) {
          log(`[NewProxy] REJECT — proxy_name ${String(c.proxy_name)} != ${expected}`);
          return J({ reject: true, reject_reason: `proxy name must be ${expected}` });
        }
        log(`[NewProxy] OK — ${id.account}/${id.device_id} -> ${expected} bw=${String(c.bandwidth_limit)}/server`);
        return J({ reject: false, unchange: true });
      }

      // Fail closed: frps is configured to call only Login/NewProxy (frps.toml
      // ops). Any other op is unexpected — reject rather than rubber-stamp it.
      log(`[_frp] REJECT — unsupported op ${String(op)}`);
      return J({ reject: true, reject_reason: `unsupported op ${String(op)}` });
    }

    return J({ error: "not found" }, 404);
  };
}
