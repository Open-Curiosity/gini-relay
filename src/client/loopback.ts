/**
 * OS-touching glue for the loopback OAuth flow: a throwaway 127.0.0.1 server that
 * catches Google's redirect, and a helper to open the browser. Both are kept here
 * (separate from auth.ts) and injected, so the auth logic stays pure/testable.
 */
import { bunSpawn, type SpawnFn } from "./runner/process.ts";

export interface Loopback {
  /** The redirect URI the bound port serves (`http://127.0.0.1:<port>/cb`). */
  redirectUri: string;
  /** Resolves with the auth code, or null if the callback failed/was cancelled. */
  code: Promise<string | null>;
  /** Shuts the loopback server down. */
  stop: () => void;
}

export type StartLoopback = (ports: number[], state: string) => Loopback | null;

/**
 * Binds the first free port from `ports` and serves `/cb`, resolving the auth
 * code once Google redirects to it. Returns null if no port is free. The `state`
 * must match or the code is rejected (CSRF guard).
 */
export const startLoopback: StartLoopback = (ports, state) => {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const html = (s: string): Response => new Response(s, { headers: { "content-type": "text/html" } });

  let server: ReturnType<typeof Bun.serve> | undefined;
  let redirectUri = "";
  for (const p of ports) {
    try {
      server = Bun.serve({
        port: p,
        hostname: "127.0.0.1",
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname !== "/cb") return new Response("not found", { status: 404 });
          const code = u.searchParams.get("code");
          if (!code || u.searchParams.get("state") !== state) {
            resolve(null);
            return html("<h2>Login failed.</h2><p>Return to your terminal and try again.</p>");
          }
          resolve(code);
          return html("<h2>Logged in.</h2><p>You can close this tab and return to your terminal.</p>");
        },
      });
      redirectUri = `http://127.0.0.1:${p}/cb`;
      break;
    } catch {
      /* port busy — try the next */
    }
  }
  if (!server) return null;
  const bound = server;
  return { redirectUri, code: promise, stop: () => bound.stop(true) };
};

/** Opens `url` in the default browser. Best-effort; failures are swallowed. */
export function openBrowser(url: string, spawnFn: SpawnFn = bunSpawn): void {
  try {
    spawnFn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no browser available — the URL was already printed for manual use */
  }
}
