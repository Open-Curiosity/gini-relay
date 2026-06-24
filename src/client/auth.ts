/**
 * Loopback OAuth login.
 *
 * `loginUrl(deps)` is the library primitive: it binds the loopback callback
 * server, asks the relay for the Google consent URL, and hands back that URL plus
 * a `waitForSession()` you can await. It does NOT open a browser or print
 * anything — present the URL yourself (open it in a specific browser, put it
 * behind a "Sign in" button) and then await the session. The URL is machine-
 * bound, NOT shareable: the auth code comes back to THIS machine's 127.0.0.1
 * loopback, so the browser that approves it must run on this same machine —
 * don't send the URL to another device or person.
 *
 * `login(deps)` is the CLI convenience built on top: it opens the browser, prints
 * the URL, awaits completion, and returns a process exit code.
 */
import { createPkce, newState, type Pkce } from "./pkce.ts";
import { startLoopback as defaultStartLoopback, type StartLoopback } from "./loopback.ts";
import type { Store, Session } from "./store.ts";

export interface LoginUrlDeps {
  store: Store;
  relayUrl: string;
  loopbackPorts: number[];
  /**
   * Optional Workspace service names (e.g. ["calendar", "gmail"]) to request
   * extra scopes for. Forwarded to the relay's /auth/google-url, which validates
   * them against its own allowlist. Omitted/empty -> an identity-only login,
   * byte-for-byte the prior behavior, so existing callers are unaffected.
   */
  services?: string[];
  fetchFn?: typeof fetch;
  startLoopback?: StartLoopback;
  makePkce?: () => Pkce;
  makeState?: () => string;
}

export interface LoginHandle {
  /** Google consent URL — open it, redirect to it, or display it however you like. */
  url: string;
  /** The loopback redirect URI the auth code lands on (this machine's 127.0.0.1). */
  redirectUri: string;
  /**
   * Waits for the user to approve in the browser, exchanges the code, persists
   * the session, and resolves with it. Rejects if the callback fails or the
   * exchange is rejected. Always stops the loopback server when it settles.
   *
   * One-shot: repeated or concurrent calls share the SAME single exchange and
   * resolve/reject to the same result (the OAuth code is single-use, so it is
   * never redeemed twice).
   */
  waitForSession: () => Promise<Session>;
  /** Abort a pending login: stop the loopback and make `waitForSession` reject. */
  cancel: () => void;
}

/**
 * Begins a login: returns the consent URL plus an awaitable session. Throws if
 * no loopback port is free or the relay won't issue a consent URL (the loopback
 * is stopped before throwing in the latter case).
 */
export async function loginUrl(deps: LoginUrlDeps): Promise<LoginHandle> {
  const fetchFn = deps.fetchFn ?? fetch;
  const startLoopback = deps.startLoopback ?? defaultStartLoopback;
  const makePkce = deps.makePkce ?? (() => createPkce());
  const makeState = deps.makeState ?? (() => newState());

  const device_id = deps.store.deviceId();
  const state = makeState();
  const { verifier, challenge } = makePkce();

  const lb = startLoopback(deps.loopbackPorts, state);
  if (!lb) {
    throw new Error(`no free loopback port among ${deps.loopbackPorts.join(", ")} — close whatever's using them and retry`);
  }

  // Only append `services` when the caller requested some, so the identity-only
  // request URL is unchanged (and existing relays that ignore the param are fine).
  const servicesParam =
    deps.services && deps.services.length > 0
      ? `&services=${encodeURIComponent(deps.services.join(","))}`
      : "";

  let url: string;
  try {
    const urlRes = await fetchFn(
      `${deps.relayUrl}/auth/google-url?redirect_uri=${encodeURIComponent(lb.redirectUri)}&state=${state}&code_challenge=${challenge}${servicesParam}`,
    );
    if (!urlRes.ok) {
      throw new Error(`relay error getting login URL: ${urlRes.status} ${await urlRes.text()}`);
    }
    const body = (await urlRes.json()) as { url?: unknown };
    if (typeof body.url !== "string" || body.url === "") {
      throw new Error("relay returned no login url");
    }
    url = body.url;
  } catch (e) {
    lb.stop(); // don't leak the bound loopback if we never hand back a handle
    throw e;
  }

  const { promise: aborted, resolve: abort } = Promise.withResolvers<null>();
  let settled = false;
  let cancelled = false;
  let pending: Promise<Session> | undefined;

  const doWait = async (): Promise<Session> => {
    // Rejects when cancel() fires, so cancellation can settle a hung wait OR a hung
    // exchange. Created lazily per call and .catch'd so a cancel that arrives after
    // we've already settled can't surface as an unhandled rejection.
    const onCancel = aborted.then((): never => {
      throw new Error("login was not completed");
    });
    onCancel.catch(() => {});
    try {
      const code = await Promise.race([lb.code, onCancel]);
      // `|| cancelled` matters when the code had already arrived before cancel():
      // bail BEFORE the exchange so a cancelled login never POSTs /auth/exchange.
      if (!code || cancelled) throw new Error("login was not completed");

      // Exchange + parse + persist as ONE unit, raced against cancel — so a stall
      // anywhere (the fetch, the body read, etc.) can still settle waitForSession().
      // If cancel wins the race this keeps running in the background; the `cancelled`
      // guard before writeSession stops that orphan from clobbering a newer session.
      const exchange = async (): Promise<Session> => {
        const res = await fetchFn(`${deps.relayUrl}/auth/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, redirect_uri: lb.redirectUri, device_id, code_verifier: verifier }),
        });
        const s = (await res.json()) as { token?: string; subdomain?: string; account?: string; error?: string };
        if (!res.ok || !s.token || !s.subdomain) throw new Error(`login failed: ${s.error ?? res.status}`);
        if (cancelled) throw new Error("login was not completed");
        const session: Session = { token: s.token, subdomain: s.subdomain, account: s.account };
        deps.store.writeSession(session);
        return session;
      };
      return await Promise.race([exchange(), onCancel]);
    } finally {
      settled = true;
      lb.stop();
    }
  };

  // One-shot: repeated/concurrent calls share a single exchange. The OAuth code
  // is single-use, so re-redeeming it would fail one caller and is never wanted.
  const waitForSession = (): Promise<Session> => (pending ??= doWait());

  const cancel = (): void => {
    if (settled) return;
    cancelled = true; // also blocks a post-code exchange/write, not just the pre-code wait
    abort(null);
    lb.stop();
  };

  return { url, redirectUri: lb.redirectUri, waitForSession, cancel };
}

export interface LoginDeps extends LoginUrlDeps {
  relayDomain: string;
  openBrowser: (url: string) => void;
  log?: (m: string) => void;
  error?: (m: string) => void;
}

/** CLI convenience: open the browser, await the session, return an exit code. */
export async function login(deps: LoginDeps): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;

  let handle: LoginHandle;
  try {
    handle = await loginUrl(deps);
  } catch (e) {
    error((e as Error).message);
    return 1;
  }

  try {
    log(`\nOpening Google sign-in in your browser — just approve, nothing else to do.\nIf it doesn't open automatically, visit:\n\n  ${handle.url}\n`);
    deps.openBrowser(handle.url);
    const session = await handle.waitForSession();
    log(`\nlogged in as ${session.account}\nyour address: https://${session.subdomain}.${deps.relayDomain}\n`);
    return 0;
  } catch (e) {
    handle.cancel(); // stop the loopback if we bailed before/within the wait (no-op once settled)
    error((e as Error).message);
    return 1;
  }
}
