/**
 * Server configuration loaded from the environment. Parsing is pure (no process
 * exits); `assertStartable` enforces the fail-closed invariants and throws so
 * the thin bin entry can report and exit.
 */

export interface ServerConfig {
  port: number;
  dbPath: string;
  publicUrl: string;
  googleId: string;
  googleSecret: string;
  googleLive: boolean;
  allowStub: boolean;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.GINI_PLUGIN_PORT ?? 9100);
  const googleId = (env.GINI_GOOGLE_CLIENT_ID ?? "").trim();
  const googleSecret = (env.GINI_GOOGLE_CLIENT_SECRET ?? "").trim();
  return {
    port,
    dbPath: env.GINI_DB ?? "/tmp/gini-relay.db",
    publicUrl: env.GINI_PUBLIC_URL ?? `http://localhost:${port}`,
    googleId,
    googleSecret,
    googleLive: googleId !== "" && googleSecret !== "",
    allowStub: (env.GINI_ALLOW_STUB ?? "").trim() === "1",
  };
}

/**
 * Throws unless the config is safe to start: stub (no-Google) auth must be
 * explicitly opted into with GINI_ALLOW_STUB=1, so a creds-less prod deploy
 * can't silently accept arbitrary accounts.
 */
export function assertStartable(cfg: ServerConfig): void {
  if (!cfg.googleLive && !cfg.allowStub) {
    throw new Error("Google OAuth creds (GINI_GOOGLE_CLIENT_ID/_SECRET) absent and GINI_ALLOW_STUB!=1 — refusing to start in open stub auth mode.");
  }
}
