import { describe, it, expect, mock } from "bun:test";
import { runCli, type CliDeps, type TunnelHandle } from "../src/client/cli.ts";
import type { Store, Session } from "../src/client/store.ts";
import { resolveDefaults } from "../src/client/defaults.ts";

function fakeStore(session: Session | null): Store {
  return {
    home: "/tmp/none",
    deviceId: () => "dev-1",
    readSession: () => session,
    writeSession: () => {},
    clearSession: () => {},
  };
}

describe("runCli port arguments", () => {
  it("rejects hexadecimal and exponent-form ports without building a tunnel", async () => {
    const errors: string[] = [];
    const handle: TunnelHandle = {
      on() {
        return this;
      },
      async start() {
        return undefined;
      },
      get exited() {
        return Promise.resolve(0);
      },
    };
    const buildTunnel = mock(() => handle);
    const deps: CliDeps = {
      store: fakeStore({ token: "t", subdomain: "g1", account: "a" }),
      defaults: resolveDefaults({}),
      buildTunnel,
      log: () => {},
      error: (message) => errors.push(message),
    };

    for (const port of ["0x1f90", "8e3"]) {
      expect(await runCli([port], deps)).toBe(1);
    }

    expect(buildTunnel).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes("usage"))).toBe(true);
  });
});
