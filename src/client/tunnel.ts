/**
 * Tunnel construction: turn a session + local port into a supervised native frpc
 * process (no docker). `buildTunnel` is pure wiring (config -> Frpc); `validatePort`
 * guards the port argument. The caller drives the lifecycle (start, logs, exited).
 */
import { buildFrpcConfig } from "./config.ts";
import { Frpc, type FrpcOptions } from "./runner/supervisor.ts";
import { isProxyStartLine } from "./runner/logparse.ts";
import type { Session } from "./store.ts";
import type { RelayDefaults } from "./defaults.ts";

export interface TunnelOptions {
  session: Pick<Session, "token" | "subdomain">;
  deviceId: string;
  port: number;
  defaults: RelayDefaults;
  localHost?: string;
  caFile?: string;
  /**
   * Extra runner options/seams (binary path, spawn fn, etc.). `config`/`configPath`
   * are intentionally excluded so a caller can't override the securely-generated
   * config (pinned subdomain/bandwidth/TLS-CA).
   */
  frpc?: Omit<FrpcOptions, "config" | "configPath">;
}

/** Builds (but does not start) a supervised frpc client for one tunnel. */
export function buildTunnel(opts: TunnelOptions): Frpc {
  const config = buildFrpcConfig({
    session: opts.session,
    deviceId: opts.deviceId,
    port: opts.port,
    defaults: opts.defaults,
    localHost: opts.localHost,
    caFile: opts.caFile,
  });
  const frpcOpts = opts.frpc ?? {};
  // Readiness = the proxy is actually up (gini runs exactly one proxy per device),
  // not merely "logged in", so a later NewProxy rejection isn't reported as ready.
  return new Frpc({ ...frpcOpts, config, readyWhen: frpcOpts.readyWhen ?? isProxyStartLine });
}

/** Parses a port argument; returns the integer port or null if out of range. */
export function validatePort(portArg: string): number | null {
  const port = Number(portArg);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}
