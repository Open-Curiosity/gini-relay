import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { DEFAULTS, PACKAGE_ROOT, resolveDefaults } from "../src/client/defaults.ts";

describe("DEFAULTS", () => {
  it("has the hardcoded public shape", () => {
    expect(DEFAULTS).toEqual({
      relayUrl: "https://gini-relay.lilaclabs.ai",
      frpsAddr: "gini-relay.lilaclabs.ai",
      frpsPort: 7000,
      relayDomain: "gini-relay.lilaclabs.ai",
      tlsServerName: "gini-relay.lilaclabs.ai",
      frpToken: "AAFwwApadkEUoKj9jQ9P6wP1jzYY0zTe",
      caFile: join(PACKAGE_ROOT, "frps-ca.crt"),
      loopbackPorts: [8765, 8766, 8767],
      bandwidth: "1220KB",
    });
  });

  it("PACKAGE_ROOT points two levels up from src/client and caFile sits under it", () => {
    expect(PACKAGE_ROOT).toBe(join(import.meta.dir, ".."));
    expect(DEFAULTS.caFile).toBe(join(PACKAGE_ROOT, "frps-ca.crt"));
    expect(DEFAULTS.caFile.endsWith("frps-ca.crt")).toBe(true);
  });
});

describe("resolveDefaults", () => {
  it("returns DEFAULTS values with an empty env", () => {
    expect(resolveDefaults({})).toEqual(DEFAULTS);
  });

  it("defaults to process.env when no arg is given", () => {
    // Just verify it returns a well-formed object using the implicit default.
    const r = resolveDefaults();
    expect(r.loopbackPorts).toEqual(DEFAULTS.loopbackPorts);
    expect(r.bandwidth).toBe(DEFAULTS.bandwidth);
  });

  it("applies every GINI_* override, converting frpsPort to a number", () => {
    const env = {
      GINI_RELAY_URL: "https://custom.example",
      GINI_FRPS_ADDR: "custom.addr",
      GINI_FRPS_PORT: "9999",
      GINI_RELAY_DOMAIN: "custom.domain",
      GINI_TLS_SERVER_NAME: "custom.tls",
      GINI_FRP_TOKEN: "custom-token",
      GINI_CA_FILE: "/tmp/custom-ca.crt",
    };
    expect(resolveDefaults(env)).toEqual({
      relayUrl: "https://custom.example",
      frpsAddr: "custom.addr",
      frpsPort: 9999,
      relayDomain: "custom.domain",
      tlsServerName: "custom.tls",
      frpToken: "custom-token",
      caFile: "/tmp/custom-ca.crt",
      loopbackPorts: DEFAULTS.loopbackPorts,
      bandwidth: DEFAULTS.bandwidth,
    });
    expect(typeof resolveDefaults(env).frpsPort).toBe("number");
  });
});
