import { describe, it, expect } from "bun:test";
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  LOOPBACK_PORTS,
  LOOPBACK_REDIRECTS,
  googleAuthUrl,
  scopesForServices,
  exchangeGoogleCode,
  decodeJwtClaims,
} from "../src/server/oauth.ts";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeIdToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

function fakeFetch(opts: {
  ok?: boolean;
  status?: number;
  text?: string;
  json?: unknown;
}): typeof fetch {
  return (async () =>
    ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => opts.text ?? "",
      json: async () => opts.json,
    }) as unknown as Response) as unknown as typeof fetch;
}

const CLIENT_ID = "client-123.apps.googleusercontent.com";
const REDIRECT = "http://127.0.0.1:8765/cb";

describe("constants", () => {
  it("exposes Google endpoints", () => {
    expect(GOOGLE_AUTH_URL).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(GOOGLE_TOKEN_URL).toBe("https://oauth2.googleapis.com/token");
  });

  it("exposes loopback ports and redirects", () => {
    expect(LOOPBACK_PORTS).toEqual([8765, 8766, 8767]);
    expect(LOOPBACK_REDIRECTS.has("http://127.0.0.1:8765/cb")).toBe(true);
    expect(LOOPBACK_REDIRECTS.has("http://127.0.0.1:8766/cb")).toBe(true);
    expect(LOOPBACK_REDIRECTS.has("http://127.0.0.1:8767/cb")).toBe(true);
    expect(LOOPBACK_REDIRECTS.has("http://127.0.0.1:9999/cb")).toBe(false);
    expect(LOOPBACK_REDIRECTS.size).toBe(3);
  });
});

describe("decodeJwtClaims", () => {
  it("decodes the JWT payload claims", () => {
    const claims = { sub: "user-1", email: "x@y.com", aud: CLIENT_ID };
    const jwt = makeIdToken(claims);
    expect(decodeJwtClaims(jwt)).toEqual(claims);
  });

  it("falls back to an empty payload segment when none is present", () => {
    // split(".")[1] is undefined -> "" coalesces in; decode an empty-object token.
    const jwt = `${b64url({})}.${b64url({})}.sig`;
    expect(decodeJwtClaims(jwt)).toEqual({} as Record<string, unknown>);
  });
});

describe("googleAuthUrl", () => {
  it("builds a consent URL with all PKCE params", () => {
    const url = googleAuthUrl(CLIENT_ID, REDIRECT, "state-xyz", "chal-abc");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(GOOGLE_AUTH_URL);
    expect(u.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("state")).toBe("state-xyz");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("prompt")).toBe("select_account");
    expect(u.searchParams.get("code_challenge")).toBe("chal-abc");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("identity-only when services is the default empty list", () => {
    // Omitting the arg must reproduce the exact prior request (online + select_account).
    const u = new URL(googleAuthUrl(CLIENT_ID, REDIRECT, "s", "c"));
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });

  it("appends workspace scopes and switches to offline+consent when services are requested", () => {
    const u = new URL(googleAuthUrl(CLIENT_ID, REDIRECT, "s", "c", ["calendar", "gmail"]));
    expect(u.searchParams.get("scope")).toBe(
      "openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify",
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("appends the drive and sheets scopes when those services are requested", () => {
    const u = new URL(googleAuthUrl(CLIENT_ID, REDIRECT, "s", "c", ["drive", "sheets"]));
    expect(u.searchParams.get("scope")).toBe(
      "openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
  });

  it("drops unknown service names and stays identity-only when none resolve", () => {
    // An all-unknown list resolves to zero extra scopes, so the request must NOT
    // flip to offline/consent — it stays a plain identity login.
    const u = new URL(googleAuthUrl(CLIENT_ID, REDIRECT, "s", "c", ["bogus"]));
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("access_type")).toBe("online");
    expect(u.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("scopesForServices", () => {
  it("maps known services to their scope URLs in order", () => {
    expect(scopesForServices(["calendar", "gmail"])).toEqual([
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });

  it("maps drive and sheets to their scope URLs", () => {
    expect(scopesForServices(["drive", "sheets"])).toEqual([
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
  });

  it("maps the full four-service set in request order", () => {
    expect(scopesForServices(["calendar", "gmail", "drive", "sheets"])).toEqual([
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
  });

  it("drops unknown names and de-duplicates repeats", () => {
    expect(scopesForServices(["calendar", "nope", "calendar"])).toEqual([
      "https://www.googleapis.com/auth/calendar",
    ]);
  });

  it("returns an empty list for no services", () => {
    expect(scopesForServices([])).toEqual([]);
  });
});

describe("exchangeGoogleCode", () => {
  const FUTURE = 4_000_000_000; // exp in seconds, far future
  const fixedNow = () => 1_000_000_000_000; // ms

  function deps(fetchFn: typeof fetch, nowMs?: () => number) {
    return { clientId: CLIENT_ID, clientSecret: "secret", fetchFn, nowMs };
  }

  it("returns account and email on the ok path", async () => {
    const idToken = makeIdToken({
      aud: CLIENT_ID,
      iss: "https://accounts.google.com",
      exp: FUTURE,
      sub: "user-sub-1",
      email: "a@b.com",
    });
    const out = await exchangeGoogleCode(
      deps(fakeFetch({ json: { id_token: idToken } }), fixedNow),
      "code",
      REDIRECT,
      "verifier",
    );
    expect(out).toEqual({ account: "user-sub-1", email: "a@b.com", refreshToken: null });
  });

  it("returns the refresh token when Google includes one (offline consent)", async () => {
    const idToken = makeIdToken({
      aud: CLIENT_ID,
      iss: "https://accounts.google.com",
      exp: FUTURE,
      sub: "user-sub-rt",
      email: "rt@b.com",
    });
    const out = await exchangeGoogleCode(
      deps(fakeFetch({ json: { id_token: idToken, refresh_token: "rt-xyz" } }), fixedNow),
      "code",
      REDIRECT,
      "verifier",
    );
    expect(out).toEqual({ account: "user-sub-rt", email: "rt@b.com", refreshToken: "rt-xyz" });
  });

  it("treats an empty-string refresh_token as none", async () => {
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "accounts.google.com", exp: FUTURE, sub: "s-empty" });
    const out = await exchangeGoogleCode(
      deps(fakeFetch({ json: { id_token: idToken, refresh_token: "" } }), fixedNow),
      "c",
      REDIRECT,
      "v",
    );
    expect(out.refreshToken).toBeNull();
  });

  it("returns null email when email missing", async () => {
    const idToken = makeIdToken({
      aud: CLIENT_ID,
      iss: "accounts.google.com",
      exp: FUTURE,
      sub: "user-sub-2",
    });
    const out = await exchangeGoogleCode(
      deps(fakeFetch({ json: { id_token: idToken } }), fixedNow),
      "code",
      REDIRECT,
      "verifier",
    );
    expect(out).toEqual({ account: "user-sub-2", email: null, refreshToken: null });
  });

  it("accepts both iss values", async () => {
    for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
      const idToken = makeIdToken({ aud: CLIENT_ID, iss, exp: FUTURE, sub: "s" });
      const out = await exchangeGoogleCode(
        deps(fakeFetch({ json: { id_token: idToken } }), fixedNow),
        "c",
        REDIRECT,
        "v",
      );
      expect(out.account).toBe("s");
    }
  });

  it("throws when response not ok", async () => {
    await expect(
      exchangeGoogleCode(
        deps(fakeFetch({ ok: false, status: 400, text: "bad" }), fixedNow),
        "c",
        REDIRECT,
        "v",
      ),
    ).rejects.toThrow("google token exchange failed: 400 bad");
  });

  it("throws when id_token missing", async () => {
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: {} }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("google response missing id_token");
  });

  it("throws on aud mismatch", async () => {
    const idToken = makeIdToken({ aud: "other", iss: "accounts.google.com", exp: FUTURE, sub: "s" });
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: { id_token: idToken } }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("id_token aud mismatch");
  });

  it("throws on iss mismatch", async () => {
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "evil.com", exp: FUTURE, sub: "s" });
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: { id_token: idToken } }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("id_token iss mismatch");
  });

  it("throws when expired (exp in past)", async () => {
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "accounts.google.com", exp: 1, sub: "s" });
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: { id_token: idToken } }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("id_token expired");
  });

  it("throws when exp not a number", async () => {
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "accounts.google.com", sub: "s" });
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: { id_token: idToken } }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("id_token expired");
  });

  it("throws when sub missing", async () => {
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "accounts.google.com", exp: FUTURE });
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: { id_token: idToken } }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("id_token missing sub");
  });

  it("throws when sub empty string", async () => {
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "accounts.google.com", exp: FUTURE, sub: "" });
    await expect(
      exchangeGoogleCode(deps(fakeFetch({ json: { id_token: idToken } }), fixedNow), "c", REDIRECT, "v"),
    ).rejects.toThrow("id_token missing sub");
  });

  it("uses default fetch and Date.now seams when not injected", async () => {
    // Exercise the `?? fetch` and `?? Date.now` default branches by injecting
    // only one of them; here we omit nowMs so Date.now is used (token far-future).
    const idToken = makeIdToken({ aud: CLIENT_ID, iss: "accounts.google.com", exp: FUTURE, sub: "dflt" });
    const out = await exchangeGoogleCode(
      { clientId: CLIENT_ID, clientSecret: "s", fetchFn: fakeFetch({ json: { id_token: idToken } }) },
      "c",
      REDIRECT,
      "v",
    );
    expect(out.account).toBe("dflt");
  });
});
