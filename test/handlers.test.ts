import { describe, it, expect } from "bun:test";
import { createApp, type AppDeps } from "../src/server/handlers.ts";
import { createRegistry, openDb, type Registry } from "../src/server/registry.ts";
import { BANDWIDTH } from "../src/server/bandwidth.ts";

const REDIRECT = "http://127.0.0.1:8765/cb";

function makeRegistry(): Registry {
  return createRegistry(openDb(":memory:"));
}

function makeDeps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    registry: makeRegistry(),
    googleLive: false,
    authUrl: (r) => "url:" + r,
    exchange: async () => ({ account: "acct", email: null, refreshToken: null }),
    log: () => {},
    ...over,
  };
}

/** Mint a real session and return its token + subdomain for an account/device. */
function session(registry: Registry, account = "acct", deviceId = "d1") {
  return registry.createSession(account, deviceId);
}

function get(app: (r: Request) => Promise<Response>, path: string, headers?: Record<string, string>) {
  return app(new Request("http://x" + path, { method: "GET", headers }));
}
function post(app: (r: Request) => Promise<Response>, path: string, body?: unknown, raw?: string) {
  return app(new Request("http://x" + path, { method: "POST", body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }));
}

describe("/auth/google-url", () => {
  it("400 stub_mode when googleLive=false", async () => {
    const app = createApp(makeDeps({ googleLive: false }));
    const r = await get(app, "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&state=s&code_challenge=c");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("stub_mode");
  });

  it("400 bad redirect_uri", async () => {
    const app = createApp(makeDeps({ googleLive: true }));
    const r = await get(app, "/auth/google-url?redirect_uri=http://evil/cb&state=s&code_challenge=c");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain("loopback");
  });

  it("400 missing state", async () => {
    const app = createApp(makeDeps({ googleLive: true }));
    const r = await get(app, "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&code_challenge=c");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("state required");
  });

  it("400 missing code_challenge", async () => {
    const app = createApp(makeDeps({ googleLive: true }));
    const r = await get(app, "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&state=s");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("code_challenge required");
  });

  it("200 success", async () => {
    const app = createApp(makeDeps({ googleLive: true, authUrl: (r, s, c) => `url:${r}:${s}:${c}` }));
    const r = await get(app, "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&state=s&code_challenge=c");
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).url).toBe(`url:${REDIRECT}:s:c`);
  });

  it("passes a validated services list through to authUrl", async () => {
    const app = createApp(
      makeDeps({ googleLive: true, authUrl: (_r, _s, _c, services) => `svc:${services.join(",")}` }),
    );
    const r = await get(
      app,
      "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&state=s&code_challenge=c&services=calendar,gmail",
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).url).toBe("svc:calendar,gmail");
  });

  it("drops services not on the relay allowlist", async () => {
    // `bogus` is not in SERVICE_SCOPES, so only `calendar` survives — the relay
    // never forwards a scope its Google app isn't verified for.
    const app = createApp(
      makeDeps({ googleLive: true, authUrl: (_r, _s, _c, services) => `svc:${services.join(",")}` }),
    );
    const r = await get(
      app,
      "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&state=s&code_challenge=c&services=bogus,calendar",
    );
    expect(((await r.json()) as any).url).toBe("svc:calendar");
  });

  it("defaults to an empty services list when the param is absent", async () => {
    const app = createApp(
      makeDeps({ googleLive: true, authUrl: (_r, _s, _c, services) => `svc:[${services.join(",")}]` }),
    );
    const r = await get(app, "/auth/google-url?redirect_uri=" + encodeURIComponent(REDIRECT) + "&state=s&code_challenge=c");
    expect(((await r.json()) as any).url).toBe("svc:[]");
  });
});

describe("/auth/exchange", () => {
  it("400 no device_id (also covers bad json -> {})", async () => {
    const app = createApp(makeDeps());
    const r = await post(app, "/auth/exchange", undefined, "not json");
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("device_id required");
  });

  it("live: 400 missing code", async () => {
    const app = createApp(makeDeps({ googleLive: true }));
    const r = await post(app, "/auth/exchange", { device_id: "d1" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("code required");
  });

  it("live: 400 missing code_verifier", async () => {
    const app = createApp(makeDeps({ googleLive: true }));
    const r = await post(app, "/auth/exchange", { device_id: "d1", code: "abc" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("code_verifier required");
  });

  it("live: 400 bad redirect_uri", async () => {
    const app = createApp(makeDeps({ googleLive: true }));
    const r = await post(app, "/auth/exchange", { device_id: "d1", code: "abc", code_verifier: "v", redirect_uri: "http://evil/cb" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("bad redirect_uri");
  });

  it("live: 400 exchange throws", async () => {
    const app = createApp(makeDeps({ googleLive: true, exchange: async () => { throw new Error("boom"); } }));
    const r = await post(app, "/auth/exchange", { device_id: "d1", code: "abc", code_verifier: "v", redirect_uri: REDIRECT });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("exchange failed: boom");
  });

  it("live: 200 success returns token+subdomain that verify", async () => {
    const registry = makeRegistry();
    const app = createApp(makeDeps({
      registry,
      googleLive: true,
      exchange: async () => ({ account: "googsub", email: "e@x", refreshToken: null }),
    }));
    const r = await post(app, "/auth/exchange", { device_id: "d1", code: "abc", code_verifier: "v", redirect_uri: REDIRECT });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.account).toBe("googsub");
    expect(typeof j.subdomain).toBe("string");
    expect(typeof j.token).toBe("string");
    // An identity-only exchange has no refresh token, so the field is omitted.
    expect("refresh_token" in j).toBe(false);
    const id = registry.verifyToken(j.token);
    expect(id).not.toBeNull();
    expect(id!.account).toBe("googsub");
    expect(id!.subdomain).toBe(j.subdomain);
  });

  it("live: includes refresh_token in the response when the exchange returns one", async () => {
    const app = createApp(makeDeps({
      googleLive: true,
      exchange: async () => ({ account: "googsub", email: "e@x", refreshToken: "rt-123" }),
    }));
    const r = await post(app, "/auth/exchange", { device_id: "d1", code: "abc", code_verifier: "v", redirect_uri: REDIRECT });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.refresh_token).toBe("rt-123");
  });

  it("stub: 200 default account when none provided; token verifies", async () => {
    const registry = makeRegistry();
    const app = createApp(makeDeps({ registry }));
    const r = await post(app, "/auth/exchange", { device_id: "d1" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.account).toBe("owner@example.com");
    expect(registry.verifyToken(j.token)!.account).toBe("owner@example.com");
  });

  it("stub: 200 provided account", async () => {
    const app = createApp(makeDeps());
    const r = await post(app, "/auth/exchange", { device_id: "d1", account: "me@x" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).account).toBe("me@x");
  });
});

describe("/devices GET", () => {
  it("401 no token", async () => {
    const app = createApp(makeDeps());
    const r = await get(app, "/devices");
    expect(r.status).toBe(401);
  });

  it("401 bad token", async () => {
    const app = createApp(makeDeps());
    const r = await get(app, "/devices", { authorization: "Bearer nope" });
    expect(r.status).toBe(401);
  });

  it("200 lists with token", async () => {
    const registry = makeRegistry();
    const { token } = session(registry, "acct", "d1");
    const app = createApp(makeDeps({ registry }));
    const r = await get(app, "/devices", { authorization: "Bearer " + token });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.account).toBe("acct");
    expect(j.devices.length).toBe(1);
  });
});

describe("/devices DELETE", () => {
  it("401 no token", async () => {
    const app = createApp(makeDeps());
    const r = await app(new Request("http://x/devices/gs", { method: "DELETE" }));
    expect(r.status).toBe(401);
  });

  it("revoked true when changed > 0", async () => {
    const registry = makeRegistry();
    const { token, subdomain } = session(registry, "acct", "d1");
    const app = createApp(makeDeps({ registry }));
    const r = await app(new Request("http://x/devices/" + encodeURIComponent(subdomain), { method: "DELETE", headers: { authorization: "Bearer " + token } }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.revoked).toBe(true);
    expect(j.subdomain).toBe(subdomain);
  });

  it("revoked false when changed == 0", async () => {
    const registry = makeRegistry();
    const { token } = session(registry, "acct", "d1");
    const app = createApp(makeDeps({ registry }));
    const r = await app(new Request("http://x/devices/gnonexistent", { method: "DELETE", headers: { authorization: "Bearer " + token } }));
    expect(((await r.json()) as any).revoked).toBe(false);
  });
});

describe("/_frp/handler", () => {
  function frp(app: (r: Request) => Promise<Response>, op: string | null, content: unknown, raw?: string) {
    const u = "http://x/_frp/handler" + (op ? "?op=" + op : "");
    return app(new Request(u, { method: "POST", body: raw ?? JSON.stringify({ content }) }));
  }

  it("bad body -> reject", async () => {
    const app = createApp(makeDeps());
    const r = await frp(app, "Login", undefined, "garbage");
    expect(((await r.json()) as any).reject_reason).toBe("bad body");
  });

  it("Login OK", async () => {
    const registry = makeRegistry();
    const { token } = session(registry);
    const app = createApp(makeDeps({ registry }));
    const r = await frp(app, "Login", { metas: { token } });
    expect(((await r.json()) as any).reject).toBe(false);
  });

  it("Login REJECT bad token", async () => {
    const app = createApp(makeDeps());
    const r = await frp(app, "Login", { metas: { token: "bad" } });
    expect(((await r.json()) as any).reject).toBe(true);
  });

  it("Login REJECT empty-string token", async () => {
    const app = createApp(makeDeps());
    const r = await frp(app, "Login", { metas: { token: "" } });
    expect(((await r.json()) as any).reject).toBe(true);
  });

  function newProxyApp() {
    const registry = makeRegistry();
    const { token, subdomain } = session(registry, "acct", "d1");
    const app = createApp(makeDeps({ registry }));
    return { app, token, subdomain };
  }

  const base = (token: string, subdomain: string, over: Record<string, unknown> = {}) => ({
    user: { metas: { token } },
    proxy_type: "http",
    bandwidth_limit: BANDWIDTH,
    bandwidth_limit_mode: "server",
    subdomain,
    proxy_name: subdomain,
    ...over,
  });

  it("NewProxy REJECT bad token", async () => {
    const app = createApp(makeDeps());
    const r = await frp(app, "NewProxy", base("bad", "gx", { user: { metas: { token: "bad" } } }));
    expect(((await r.json()) as any).reject_reason).toBe("invalid identity token");
  });

  it("NewProxy REJECT unsupported proxy_type", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { proxy_type: "tcp" }));
    expect(((await r.json()) as any).reject_reason).toContain("subdomain tunnels");
  });

  it("NewProxy REJECT custom_domains (snake)", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { custom_domains: ["evil.com"] }));
    expect(((await r.json()) as any).reject_reason).toContain("custom_domains");
  });

  it("NewProxy REJECT customDomains (camel)", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { customDomains: ["evil.com"] }));
    expect(((await r.json()) as any).reject_reason).toContain("custom_domains");
  });

  it("NewProxy REJECT bad bandwidth null", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { bandwidth_limit: "garbage" }));
    expect(((await r.json()) as any).reject_reason).toContain("bandwidth");
  });

  it("NewProxy REJECT bandwidth over cap", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { bandwidth_limit: "50MB" }));
    expect(((await r.json()) as any).reject_reason).toContain("bandwidth");
  });

  it("NewProxy REJECT mode != server", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { bandwidth_limit_mode: "client" }));
    expect(((await r.json()) as any).reject_reason).toContain("bandwidth");
  });

  it("NewProxy REJECT subdomain mismatch", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { subdomain: "gwrong" }));
    expect(((await r.json()) as any).reject_reason).toBe(`subdomain must be ${subdomain}`);
  });

  it("NewProxy REJECT proxy_name mismatch", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain, { proxy_name: "gwrong" }));
    expect(((await r.json()) as any).reject_reason).toBe(`proxy name must be ${subdomain}`);
  });

  it("NewProxy full success", async () => {
    const { app, token, subdomain } = newProxyApp();
    const r = await frp(app, "NewProxy", base(token, subdomain));
    const j = (await r.json()) as any;
    expect(j.reject).toBe(false);
    expect(j.unchange).toBe(true);
  });

  it("unknown op -> reject (fail closed)", async () => {
    const app = createApp(makeDeps());
    const r = await frp(app, "Ping", {});
    expect(((await r.json()) as any).reject).toBe(true);
  });
});

describe("/.well-known/apple-app-site-association", () => {
  it("200 serves the AASA with the default app ID and a JSON content-type", async () => {
    const app = createApp(makeDeps());
    const r = await get(app, "/.well-known/apple-app-site-association");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    const j = (await r.json()) as any;
    expect(j.applinks.details[0].appIDs).toEqual(["WB6Y3K67AB.ai.lilaclabs.gini.mobile"]);
    expect(j.applinks.details[0].components.map((c: any) => c["/"])).toEqual(["/", "/pair", "/pair/*"]);
  });

  it("honors an app ID overridden via deps", async () => {
    const app = createApp(makeDeps({ iosAppId: "TEAMID.com.example.app" }));
    const r = await get(app, "/.well-known/apple-app-site-association");
    expect(((await r.json()) as any).applinks.details[0].appIDs).toEqual(["TEAMID.com.example.app"]);
  });
});

describe("defaults", () => {
  it("404 not found", async () => {
    const app = createApp(makeDeps());
    const r = await get(app, "/nope");
    expect(r.status).toBe(404);
  });

  it("uses the default log (createApp without log)", async () => {
    const registry = makeRegistry();
    const app = createApp({
      registry,
      googleLive: false,
      authUrl: (r) => "url:" + r,
      exchange: async () => ({ account: "a", email: null, refreshToken: null }),
    });
    const r = await post(app, "/auth/exchange", { device_id: "d1", account: "x" });
    expect(r.status).toBe(200);
    const { token } = (await r.json()) as any;
    const r2 = await get(app, "/devices", { authorization: "Bearer " + token });
    expect(r2.status).toBe(200);
  });
});
