import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, PACKAGE_ROOT } from "../src/client/defaults.ts";
import { LOOPBACK_PORTS } from "../src/server/oauth.ts";
import { BANDWIDTH } from "../src/server/bandwidth.ts";
import { DEFAULT_VERSION } from "../src/client/runner/platform.ts";
import { FRP_CHECKSUMS } from "../src/client/runner/checksums.ts";

// The client and server are intentionally decoupled (the client never imports
// server code, since the package exports only the client). These cross-component
// constants are therefore duplicated; this test fails if the two halves drift.

describe("client/server constant parity", () => {
  it("loopback redirect ports match between client and server", () => {
    expect(DEFAULTS.loopbackPorts).toEqual(LOOPBACK_PORTS);
  });

  it("bandwidth tier matches between client and server", () => {
    expect(DEFAULTS.bandwidth).toBe(BANDWIDTH);
  });

  it("the frp version matches the frps image pinned in docker-compose.yml", () => {
    const compose = readFileSync(join(PACKAGE_ROOT, "docker-compose.yml"), "utf8");
    const m = /fatedier\/frps:v([0-9][0-9.]*)/.exec(compose);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(DEFAULT_VERSION);
  });

  it("a pinned checksum table exists for the default frp version", () => {
    expect(FRP_CHECKSUMS[DEFAULT_VERSION]).toBeDefined();
  });
});
