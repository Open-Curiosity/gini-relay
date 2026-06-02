/**
 * Public relay defaults. Every value here is non-secret by design: the client is
 * meant to be installed and run by anyone, so the shared frp token and the pinned
 * CA path are baked in. The real authorization is the per-user opaque session token
 * minted after Google sign-in. Any field is overridable via a GINI_* env var.
 */
import { join } from "node:path";

export interface RelayDefaults {
  /** Brain base URL (login + exchange live here). */
  relayUrl: string;
  /** frps control-plane host the client dials. */
  frpsAddr: string;
  /** frps control-plane port. */
  frpsPort: number;
  /** Apex domain; your public address is `<subdomain>.<relayDomain>`. */
  relayDomain: string;
  /** Expected TLS server name when pinning the frps control-plane cert. */
  tlsServerName: string;
  /** Shared coarse frp gate (non-secret; the session token is the real auth). */
  frpToken: string;
  /** Path to the CA cert the client pins for the frps control plane. */
  caFile: string;
  /** Loopback ports registered as OAuth redirect URIs; first free one is used. */
  loopbackPorts: number[];
  /** Per-device bandwidth tier in frp's string form. */
  bandwidth: string;
}

/** Repo/package root (two levels up from src/client). */
export const PACKAGE_ROOT = join(import.meta.dir, "..", "..");

/** The hardcoded public defaults before any env override. */
export const DEFAULTS: RelayDefaults = {
  relayUrl: "https://gini-relay.lilaclabs.ai",
  frpsAddr: "gini-relay.lilaclabs.ai",
  frpsPort: 7000,
  relayDomain: "gini-relay.lilaclabs.ai",
  tlsServerName: "gini-relay.lilaclabs.ai",
  frpToken: "AAFwwApadkEUoKj9jQ9P6wP1jzYY0zTe",
  caFile: join(PACKAGE_ROOT, "frps-ca.crt"),
  loopbackPorts: [8765, 8766, 8767],
  bandwidth: "1220KB",
};

/** Resolves defaults, applying any GINI_* environment overrides. */
export function resolveDefaults(env: NodeJS.ProcessEnv = process.env): RelayDefaults {
  return {
    relayUrl: env.GINI_RELAY_URL ?? DEFAULTS.relayUrl,
    frpsAddr: env.GINI_FRPS_ADDR ?? DEFAULTS.frpsAddr,
    frpsPort: Number(env.GINI_FRPS_PORT ?? DEFAULTS.frpsPort),
    relayDomain: env.GINI_RELAY_DOMAIN ?? DEFAULTS.relayDomain,
    tlsServerName: env.GINI_TLS_SERVER_NAME ?? DEFAULTS.tlsServerName,
    frpToken: env.GINI_FRP_TOKEN ?? DEFAULTS.frpToken,
    caFile: env.GINI_CA_FILE ?? DEFAULTS.caFile,
    loopbackPorts: DEFAULTS.loopbackPorts,
    bandwidth: DEFAULTS.bandwidth,
  };
}
