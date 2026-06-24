import { describe, it, expect, mock, spyOn } from "bun:test";
import { login, loginUrl, type LoginUrlDeps, type LoginDeps } from "../src/client/auth.ts";
import type { Store, Session } from "../src/client/store.ts";
import type { Loopback } from "../src/client/loopback.ts";

// ── fakes ──────────────────────────────────────────────────────────────────
function fakeStore(): Store & { written: Session[] } {
  const written: Session[] = [];
  return {
    home: "/x",
    deviceId: () => "dev",
    readSession: () => null,
    writeSession: (s: Session) => void written.push(s),
    written,
  } as Store & { written: Session[] };
}

function fakeLoopback(code?: string | null): Loopback & { stop: ReturnType<typeof mock> } {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  if (code !== undefined) resolve(code); // omit to leave it pending (for cancel)
  return { redirectUri: "http://127.0.0.1:8765/cb", code: promise, stop: mock(() => {}) };
}

type Resp = { ok: boolean; status?: number; json?: unknown; text?: string };
function fetchSeq(...responses: Resp[]): typeof fetch {
  let i = 0;
  return mock(async () => {
    // Throw on overrun rather than repeating the last response, so an accidental
    // extra fetch (e.g. a re-redeemed OAuth code) surfaces as a test failure.
    if (i >= responses.length) throw new Error(`fetchSeq: unexpected fetch #${i + 1}`);
    return mkResponse(responses[i++]!);
  }) as unknown as typeof fetch;
}

function mkResponse(r: Resp): Response {
  return {
    ok: r.ok,
    status: r.status ?? (r.ok ? 200 : 400),
    json: async () => r.json,
    text: async () => r.text ?? "",
  } as unknown as Response;
}

const URL_OK: Resp = { ok: true, json: { url: "https://consent.example/auth" } };
const EXCHANGE_OK: Resp = { ok: true, json: { token: "t", subdomain: "g1", account: "a@x" } };

function urlDeps(over: Partial<LoginUrlDeps> & { loopback?: Loopback | null } = {}): LoginUrlDeps {
  const lb = over.loopback === undefined ? fakeLoopback("CODE") : over.loopback;
  return {
    store: fakeStore(),
    relayUrl: "https://relay",
    loopbackPorts: [8765],
    fetchFn: fetchSeq(URL_OK, EXCHANGE_OK),
    startLoopback: () => lb,
    makePkce: () => ({ verifier: "v", challenge: "c" }),
    makeState: () => "st",
    ...over,
  };
}

// ── loginUrl (the library primitive) ─────────────────────────────────────────
describe("loginUrl", () => {
  it("returns the consent url + redirect uri without opening or printing anything", async () => {
    // Omit makePkce/makeState so the real defaults run (covers those arrows).
    const handle = await loginUrl({
      store: fakeStore(),
      relayUrl: "https://relay",
      loopbackPorts: [8765],
      fetchFn: fetchSeq(URL_OK, EXCHANGE_OK),
      startLoopback: () => fakeLoopback("CODE"),
    });
    expect(handle.url).toBe("https://consent.example/auth");
    expect(handle.redirectUri).toBe("http://127.0.0.1:8765/cb");
    expect(typeof handle.waitForSession).toBe("function");
    expect(typeof handle.cancel).toBe("function");
  });

  it("forwards requested services as a query param on the url request", async () => {
    let requested = "";
    const fetchFn = mock(async (input: string) => {
      requested = input;
      return mkResponse(URL_OK);
    }) as unknown as typeof fetch;
    await loginUrl(urlDeps({ fetchFn, services: ["calendar", "gmail"] }));
    expect(requested).toContain(`&services=${encodeURIComponent("calendar,gmail")}`);
  });

  it("omits the services param entirely when none are requested", async () => {
    let requested = "";
    const fetchFn = mock(async (input: string) => {
      requested = input;
      return mkResponse(URL_OK);
    }) as unknown as typeof fetch;
    await loginUrl(urlDeps({ fetchFn })); // no services
    expect(requested).not.toContain("services=");
  });

  it("throws when no loopback port is free", async () => {
    await expect(loginUrl(urlDeps({ loopback: null }))).rejects.toThrow(/no free loopback port/);
  });

  it("throws and stops the loopback when the relay rejects the url request", async () => {
    const lb = fakeLoopback("CODE");
    await expect(loginUrl(urlDeps({ loopback: lb, fetchFn: fetchSeq({ ok: false, status: 503, text: "down" }) })))
      .rejects.toThrow(/relay error getting login URL: 503 down/);
    expect(lb.stop).toHaveBeenCalledTimes(1);
  });

  it("rethrows and stops the loopback when the url fetch throws", async () => {
    const lb = fakeLoopback("CODE");
    const fetchFn = mock(async () => {
      throw new Error("netfail");
    }) as unknown as typeof fetch;
    await expect(loginUrl(urlDeps({ loopback: lb, fetchFn }))).rejects.toThrow(/netfail/);
    expect(lb.stop).toHaveBeenCalledTimes(1);
  });

  it("waitForSession exchanges, persists, and returns the session", async () => {
    const store = fakeStore();
    const lb = fakeLoopback("CODE");
    const handle = await loginUrl(urlDeps({ store, loopback: lb }));
    const session = await handle.waitForSession();
    expect(session).toEqual({ token: "t", subdomain: "g1", account: "a@x" });
    expect(store.written).toEqual([{ token: "t", subdomain: "g1", account: "a@x" }]);
    expect(lb.stop).toHaveBeenCalledTimes(1);
  });

  it("waitForSession rejects when the callback yields no code", async () => {
    const lb = fakeLoopback(null);
    const handle = await loginUrl(urlDeps({ loopback: lb }));
    await expect(handle.waitForSession()).rejects.toThrow(/login was not completed/);
    expect(lb.stop).toHaveBeenCalledTimes(1);
  });

  it("waitForSession rejects when the exchange is rejected", async () => {
    const handle = await loginUrl(urlDeps({ fetchFn: fetchSeq(URL_OK, { ok: false, json: { error: "bad token" } }) }));
    await expect(handle.waitForSession()).rejects.toThrow(/login failed: bad token/);
  });

  it("cancel makes a pending waitForSession reject and stops the loopback", async () => {
    const lb = fakeLoopback(); // pending — never resolves on its own
    const handle = await loginUrl(urlDeps({ loopback: lb }));
    const pending = handle.waitForSession();
    handle.cancel();
    await expect(pending).rejects.toThrow(/login was not completed/);
    expect(lb.stop).toHaveBeenCalled();
  });

  it("cancel is a no-op once the login has settled", async () => {
    const lb = fakeLoopback("CODE");
    const handle = await loginUrl(urlDeps({ loopback: lb }));
    await handle.waitForSession();
    expect(lb.stop).toHaveBeenCalledTimes(1);
    handle.cancel(); // settled -> guard returns early, no extra stop
    expect(lb.stop).toHaveBeenCalledTimes(1);
  });

  it("throws when the relay returns no url string", async () => {
    const lb = fakeLoopback("CODE");
    await expect(loginUrl(urlDeps({ loopback: lb, fetchFn: fetchSeq({ ok: true, json: {} }) })))
      .rejects.toThrow(/relay returned no login url/);
    expect(lb.stop).toHaveBeenCalledTimes(1);
  });

  it("waitForSession is one-shot: repeated calls share a single exchange", async () => {
    const fetchFn = fetchSeq(URL_OK, EXCHANGE_OK);
    const handle = await loginUrl(urlDeps({ loopback: fakeLoopback("CODE"), fetchFn }));
    const a = await handle.waitForSession();
    const b = await handle.waitForSession();
    expect(a).toEqual(b);
    // 2 total fetches = google-url + exactly ONE exchange (the code is single-use).
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it("cancel before waitForSession never POSTs /auth/exchange", async () => {
    const store = fakeStore();
    const lb = fakeLoopback("CODE"); // code already arrived
    const fetchFn = fetchSeq(URL_OK); // ONLY google-url; an exchange call would overrun -> throw
    const handle = await loginUrl(urlDeps({ store, loopback: lb, fetchFn }));
    handle.cancel();
    await expect(handle.waitForSession()).rejects.toThrow(/login was not completed/);
    expect(store.written).toHaveLength(0);
    // exactly one fetch (the consent url) — the cancelled login never reached the exchange
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("cancel settles waitForSession even when the exchange body stalls, and never persists", async () => {
    const store = fakeStore();
    const lb = fakeLoopback("CODE");
    const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>();
    let calls = 0;
    const fetchFn = mock(async () => {
      calls += 1;
      if (calls === 1) return mkResponse(URL_OK); // google-url
      markEntered(); // we've reached the exchange: headers resolve …
      // … but the body read (res.json()) hangs forever. Only racing the WHOLE
      // exchange (not just the fetch) against cancel can settle this.
      return { ok: true, status: 200, json: () => new Promise(() => {}), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    const handle = await loginUrl(urlDeps({ store, loopback: lb, fetchFn }));
    const pending = handle.waitForSession();
    await entered; // deterministic: now blocked in the hung exchange (no timing sleep)
    handle.cancel(); // must settle the promise despite the hung fetch
    await expect(pending).rejects.toThrow(/login was not completed/);
    expect(store.written).toHaveLength(0); // the cancelled login never wrote a session
  });
});

// ── login (the CLI convenience over loginUrl) ────────────────────────────────
function loginDeps(over: Partial<LoginDeps> & { loopback?: Loopback | null } = {}): LoginDeps {
  return {
    ...urlDeps(over),
    relayDomain: "gini.example",
    openBrowser: mock(() => {}),
    log: mock(() => {}),
    error: mock(() => {}),
    ...over,
  };
}

describe("login", () => {
  it("opens the browser, persists the session, and returns 0", async () => {
    const openBrowser = mock(() => {});
    const store = fakeStore();
    const code = await login(loginDeps({ store, openBrowser }));
    expect(code).toBe(0);
    expect(openBrowser).toHaveBeenCalledWith("https://consent.example/auth");
    expect(store.written).toHaveLength(1);
  });

  it("returns 1 (and reports) when no loopback port is free", async () => {
    const error = mock(() => {});
    expect(await login(loginDeps({ loopback: null, error }))).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no free loopback port/));
  });

  it("returns 1 when the relay won't issue a consent url", async () => {
    const error = mock(() => {});
    expect(await login(loginDeps({ fetchFn: fetchSeq({ ok: false, status: 500, text: "x" }), error }))).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/relay error getting login URL/));
  });

  it("returns 1 when the callback yields no code", async () => {
    const error = mock(() => {});
    expect(await login(loginDeps({ loopback: fakeLoopback(null), error }))).toBe(1);
    expect(error).toHaveBeenCalledWith("login was not completed");
  });

  it("returns 1 when the exchange is rejected", async () => {
    const error = mock(() => {});
    const code = await login(loginDeps({ fetchFn: fetchSeq(URL_OK, { ok: false, json: { error: "nope" } }), error }));
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/login failed: nope/));
  });

  it("falls back to console log/error when not provided", async () => {
    // No log/error in deps -> exercises the `?? console.*` default lines. Spy on
    // console so the success banner doesn't print during the test run.
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await login({
        store: fakeStore(),
        relayUrl: "https://relay",
        relayDomain: "gini.example",
        loopbackPorts: [8765],
        fetchFn: fetchSeq(URL_OK, EXCHANGE_OK),
        startLoopback: () => fakeLoopback("CODE"),
        makePkce: () => ({ verifier: "v", challenge: "c" }),
        makeState: () => "st",
        openBrowser: () => {},
      });
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
