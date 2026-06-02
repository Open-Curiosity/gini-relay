import { describe, it, expect } from "bun:test";
import * as client from "../src/client/index.ts";
import * as server from "../src/server/index.ts";

// Guards the public re-export barrels: if a re-exported symbol is renamed or
// dropped, these imports fail to resolve and the test breaks.

describe("client barrel (the package's public surface)", () => {
  it("exports the high-level entry points", () => {
    for (const name of ["runCli", "login", "loginUrl", "buildTunnel", "validatePort", "listDevices", "revokeDevice", "buildFrpcConfig", "createStore", "createPkce", "newState", "resolveDefaults", "startLoopback", "openBrowser", "Frpc", "runFrpc", "resolveBinary", "ensureBinary", "resolveTarget", "isReadyLine", "isProxyStartLine", "isFatalLine"]) {
      expect(typeof (client as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("exports the public defaults object", () => {
    expect(client.DEFAULTS.relayUrl).toContain("gini-relay");
    expect(typeof client.PACKAGE_ROOT).toBe("string");
  });
});

describe("server barrel (internal, not exported by the package)", () => {
  it("exports the brain building blocks", () => {
    for (const name of ["decodeJwtClaims", "parseBw", "googleAuthUrl", "exchangeGoogleCode", "openDb", "createRegistry", "createApp", "loadServerConfig", "assertStartable"]) {
      expect(typeof (server as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("exports the bandwidth constants", () => {
    expect(server.CAP_BYTES).toBe(1220 * 1024);
    expect(server.SUPPORTED_PROXY.has("http")).toBe(true);
  });
});
