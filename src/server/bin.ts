#!/usr/bin/env bun
/**
 * The relay brain entry point. Thin glue: parses the `mint` dev subcommand,
 * otherwise loads config, enforces the fail-closed invariants, wires the
 * registry + OAuth into the app, and serves it. All real logic lives in the
 * sibling modules (oauth, registry, bandwidth, handlers, config).
 */
import { googleAuthUrl, exchangeGoogleCode } from "./oauth.ts";
import { openDb, createRegistry } from "./registry.ts";
import { createApp } from "./handlers.ts";
import { loadServerConfig, assertStartable } from "./config.ts";

const sub = process.argv[2];

const cfg = loadServerConfig();

if (sub === "mint") {
  const account = process.argv[3] ?? "owner@example.com";
  const deviceId = process.argv[4] ?? "laptop";
  const registry = createRegistry(openDb(cfg.dbPath));
  const { subdomain, token } = registry.createSession(account, deviceId);
  console.log(JSON.stringify({ account, deviceId, subdomain, token }, null, 2));
  process.exit(0);
}

try {
  assertStartable(cfg);
} catch (e) {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
}

const registry = createRegistry(openDb(cfg.dbPath));
const app = createApp({
  registry,
  googleLive: cfg.googleLive,
  authUrl: (redirectUri, state, codeChallenge, services) => googleAuthUrl(cfg.googleId, redirectUri, state, codeChallenge, services),
  exchange: (code, redirectUri, codeVerifier) =>
    exchangeGoogleCode({ clientId: cfg.googleId, clientSecret: cfg.googleSecret }, code, redirectUri, codeVerifier),
  log: (msg) => console.log(msg),
  iosAppId: process.env.GINI_IOS_APP_ID || undefined,
});

Bun.serve({
  port: cfg.port,
  hostname: "0.0.0.0",
  idleTimeout: 30,
  maxRequestBodySize: 64 * 1024,
  fetch: app,
});
console.log(`gini relay brain on :${cfg.port}  google=${cfg.googleLive ? "live" : "stub"}  auth=opaque-session  public=${cfg.publicUrl}  db=${cfg.dbPath}`);
