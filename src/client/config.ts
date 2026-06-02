/**
 * Builds the frpc client configuration for one tunnel. Pure: given a session, a
 * local port, and the relay defaults, it returns the config object frpc consumes
 * (serialized to JSON by the runner). The proxy name is pinned to the subdomain
 * and the control plane TLS is pinned to the relay's CA — both enforced again
 * server-side, but set correctly here so a normal run is accepted.
 */
import type { Session } from "./store.ts";
import type { RelayDefaults } from "./defaults.ts";

export interface BuildConfigOptions {
  session: Pick<Session, "token" | "subdomain">;
  deviceId: string;
  port: number;
  defaults: RelayDefaults;
  /** Local address frpc forwards to (the native client runs on the host). */
  localHost?: string;
  /** Override the pinned CA path (defaults to `defaults.caFile`). */
  caFile?: string;
}

/** The subset of frpc config fields this client sets; index signature for the rest. */
export interface FrpcConfig {
  serverAddr: string;
  serverPort: number;
  loginFailExit: boolean;
  auth: { method: string; token: string };
  metadatas: { token: string; device_id: string };
  transport: { tls: { enable: boolean; serverName: string; trustedCaFile: string } };
  proxies: Array<{
    name: string;
    type: string;
    localIP: string;
    localPort: number;
    subdomain: string;
    transport: { bandwidthLimit: string; bandwidthLimitMode: string };
  }>;
  /** frp accepts many more fields; allow them so this flows into the runner config. */
  [key: string]: unknown;
}

export function buildFrpcConfig(opts: BuildConfigOptions): FrpcConfig {
  const { session, deviceId, port, defaults } = opts;
  return {
    serverAddr: defaults.frpsAddr,
    serverPort: defaults.frpsPort,
    loginFailExit: false,
    auth: { method: "token", token: defaults.frpToken },
    metadatas: { token: session.token, device_id: deviceId },
    transport: {
      tls: {
        enable: true,
        serverName: defaults.tlsServerName,
        trustedCaFile: opts.caFile ?? defaults.caFile,
      },
    },
    proxies: [
      {
        name: session.subdomain,
        type: "http",
        localIP: opts.localHost ?? "127.0.0.1",
        localPort: port,
        subdomain: session.subdomain,
        transport: { bandwidthLimit: defaults.bandwidth, bandwidthLimitMode: "server" },
      },
    ],
  };
}
