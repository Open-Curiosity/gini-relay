/**
 * Google OAuth 2.0 loopback-redirect helpers (RFC 8252 + PKCE, RFC 7636).
 *
 * The CLI runs the browser on the user's own machine and catches the auth code
 * on a 127.0.0.1 loopback; the brain (which holds the client secret) does the
 * code->token exchange. PKCE binds the code to the CLI that started the flow.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Loopback redirect URIs the CLI may use (must be registered on the Google client). */
export const LOOPBACK_PORTS = [8765, 8766, 8767];
export const LOOPBACK_REDIRECTS = new Set(LOOPBACK_PORTS.map((p) => `http://127.0.0.1:${p}/cb`));

// Workspace service shorthand -> the Google OAuth scope(s) that service needs.
// The base login is identity-only (openid email profile); a caller can request
// extra Workspace surfaces by name and the consent URL adds their scopes. The
// relay's Google app must be VERIFIED for any scope listed here (gmail.modify is
// a restricted scope), so this map doubles as the relay's allowlist of grantable
// services — a service not present here contributes nothing.
export const SERVICE_SCOPES: Record<string, string[]> = {
  calendar: ["https://www.googleapis.com/auth/calendar"],
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
};

// Resolve a list of requested service names to their scope URLs, dropping any
// name not in SERVICE_SCOPES and de-duplicating (two services could in principle
// share a scope). Order is preserved for a stable, testable scope string.
export function scopesForServices(services: string[]): string[] {
  const out: string[] = [];
  for (const name of services) {
    for (const scope of SERVICE_SCOPES[name] ?? []) {
      if (!out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

/** Decodes a JWT's payload claims without verifying the signature. Used to read
 *  Google's id_token, whose origin is already authenticated by the TLS exchange. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

/**
 * Builds the Google consent URL for a loopback redirect with a PKCE challenge.
 *
 * `services` is an optional list of Workspace surfaces (see SERVICE_SCOPES). When
 * empty (the default, identity-only login) the request is byte-for-byte what it
 * always was: `openid email profile`, `access_type=online`, `prompt=select_account`
 * — so an existing tunnel login is unchanged. When one or more grantable services
 * are requested, their scopes are appended AND the request switches to
 * `access_type=offline` + `prompt=consent`, because a refresh token (needed to use
 * the grant past the access token's lifetime) is only issued for an offline,
 * explicitly-consented grant.
 */
export function googleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  services: string[] = [],
): string {
  const extra = scopesForServices(services);
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", ["openid", "email", "profile", ...extra].join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("access_type", extra.length > 0 ? "offline" : "online");
  u.searchParams.set("prompt", extra.length > 0 ? "consent" : "select_account");
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface ExchangeDeps {
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
}

/**
 * Exchanges an auth code (+ PKCE verifier) with Google's token endpoint and
 * returns the verified account id and email from the id_token. The id_token
 * arrives over TLS straight from Google, so its origin is authenticated; aud /
 * iss / exp / sub are still checked as defense-in-depth.
 */
export async function exchangeGoogleCode(
  deps: ExchangeDeps,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ account: string; email: string | null; refreshToken: string | null }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.nowMs ?? Date.now;
  const body = new URLSearchParams({
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`google token exchange failed: ${res.status} ${await res.text()}`);
  // A refresh_token is present only when the consent was offline (i.e. the login
  // requested Workspace scopes); an identity-only login omits it. Capture it so
  // the caller can hand it to a Workspace tool — the relay itself never stores it.
  const json = (await res.json()) as { id_token?: string; refresh_token?: string };
  if (typeof json.id_token !== "string") throw new Error("google response missing id_token");
  const claims = decodeJwtClaims(json.id_token);
  if (claims.aud !== deps.clientId) throw new Error("id_token aud mismatch");
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("id_token iss mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now()) throw new Error("id_token expired");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("id_token missing sub");
  return {
    account: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token.length > 0 ? json.refresh_token : null,
  };
}
