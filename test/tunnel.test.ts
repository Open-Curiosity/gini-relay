import { describe, it, expect } from "bun:test";
import { buildTunnel, validatePort, type TunnelOptions } from "../src/client/tunnel.ts";
import { Frpc } from "../src/client/runner/supervisor.ts";
import { DEFAULTS } from "../src/client/defaults.ts";

const baseOpts = (overrides: Partial<TunnelOptions> = {}): TunnelOptions => ({
  session: { token: "tok", subdomain: "sub" },
  deviceId: "dev-1",
  port: 3000,
  defaults: DEFAULTS,
  ...overrides,
});

describe("validatePort", () => {
  it("parses a valid mid-range port", () => {
    expect(validatePort("8080")).toBe(8080);
  });

  it("rejects 0 (below range)", () => {
    expect(validatePort("0")).toBeNull();
  });

  it("rejects 65536 (above range)", () => {
    expect(validatePort("65536")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(validatePort("abc")).toBeNull();
  });

  it("accepts the lower bound 1", () => {
    expect(validatePort("1")).toBe(1);
  });

  it("accepts the upper bound 65535", () => {
    expect(validatePort("65535")).toBe(65535);
  });

  it("rejects non-integer values", () => {
    expect(validatePort("8.5")).toBeNull();
  });
});

describe("buildTunnel", () => {
  it("returns an unstarted Frpc instance with frpc seams", () => {
    const tunnel = buildTunnel(baseOpts({ frpc: { binaryPath: "/bin/true" } }));
    expect(tunnel).toBeInstanceOf(Frpc);
    expect(tunnel.configPath).toBeNull();
  });

  it("builds without opts.frpc", () => {
    const tunnel = buildTunnel(baseOpts());
    expect(tunnel).toBeInstanceOf(Frpc);
    expect(tunnel.configPath).toBeNull();
  });

  it("threads localHost and caFile through to the config", () => {
    const tunnel = buildTunnel(
      baseOpts({ localHost: "0.0.0.0", caFile: "/tmp/ca.crt", frpc: { binaryPath: "/bin/true" } }),
    );
    expect(tunnel).toBeInstanceOf(Frpc);
    expect(tunnel.configPath).toBeNull();
  });
});
