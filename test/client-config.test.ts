import { describe, it, expect } from "bun:test";
import { buildFrpcConfig } from "../src/client/config.ts";
import type { RelayDefaults } from "../src/client/defaults.ts";

const defaults: RelayDefaults = {
  relayUrl: "https://relay.example",
  frpsAddr: "frps.example",
  frpsPort: 7000,
  relayDomain: "relay.example",
  tlsServerName: "tls.example",
  frpToken: "shared-token",
  caFile: "/path/to/default-ca.crt",
  loopbackPorts: [8765, 8766, 8767],
  bandwidth: "1220KB",
};

describe("buildFrpcConfig", () => {
  it("maps every field with defaults (no localHost / caFile overrides)", () => {
    const cfg = buildFrpcConfig({
      session: { token: "gsk-tok", subdomain: "mysub" },
      deviceId: "dev-123",
      port: 3000,
      defaults,
    });

    expect(cfg.serverAddr).toBe("frps.example");
    expect(cfg.serverPort).toBe(7000);
    expect(cfg.loginFailExit).toBe(false);
    expect(cfg.auth).toEqual({ method: "token", token: "shared-token" });
    expect(cfg.metadatas).toEqual({ token: "gsk-tok", device_id: "dev-123" });
    expect(cfg.transport).toEqual({
      tls: {
        enable: true,
        serverName: "tls.example",
        trustedCaFile: "/path/to/default-ca.crt",
      },
    });
    expect(cfg.proxies).toHaveLength(1);
    expect(cfg.proxies[0]).toEqual({
      name: "mysub",
      type: "http",
      localIP: "127.0.0.1",
      localPort: 3000,
      subdomain: "mysub",
      transport: { bandwidthLimit: "1220KB", bandwidthLimitMode: "server" },
    });
  });

  it("honors localHost and caFile overrides", () => {
    const cfg = buildFrpcConfig({
      session: { token: "t2", subdomain: "other" },
      deviceId: "d2",
      port: 8080,
      defaults,
      localHost: "0.0.0.0",
      caFile: "/custom/ca.crt",
    });

    expect(cfg.transport.tls.trustedCaFile).toBe("/custom/ca.crt");
    expect(cfg.proxies[0]!.localIP).toBe("0.0.0.0");
    expect(cfg.proxies[0]!.localPort).toBe(8080);
    expect(cfg.proxies[0]!.name).toBe("other");
    expect(cfg.proxies[0]!.subdomain).toBe("other");
  });
});
