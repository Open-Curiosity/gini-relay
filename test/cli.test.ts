import { describe, it, expect, mock } from "bun:test";
import { runCli, type CliDeps, type TunnelHandle } from "../src/client/cli.ts";
import type { Store, Session } from "../src/client/store.ts";
import { resolveDefaults } from "../src/client/defaults.ts";

const defaults = resolveDefaults({});

function fakeStore(session: Session | null, clearSession: () => void = () => {}): Store {
  return {
    home: "/tmp/none",
    deviceId: () => "dev-1",
    readSession: () => session,
    writeSession: () => {},
    clearSession,
  };
}

function baseDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    store: fakeStore({ token: "t", subdomain: "g1", account: "a" }),
    defaults,
    log: () => {},
    error: () => {},
    ...over,
  };
}

describe("runCli", () => {
  it("dispatches `login` to the injected login fn and returns its code", async () => {
    const login = mock(async () => 0);
    const code = await runCli(["login"], baseDeps({ login }));
    expect(code).toBe(0);
    expect(login).toHaveBeenCalledTimes(1);
    const arg = (login.mock.calls[0] as unknown[])[0] as { relayUrl: string; loopbackPorts: number[] };
    expect(arg.relayUrl).toBe(defaults.relayUrl);
    expect(arg.loopbackPorts).toEqual(defaults.loopbackPorts);
  });

  it("tunnels a port: builds, streams logs, and resolves with the exit code", async () => {
    const logged: string[] = [];
    let listener: ((line: string) => void) | null = null;
    const handle: TunnelHandle = {
      on(_event, l) {
        listener = l;
        return this;
      },
      async start() {
        listener?.("login to server success");
        return undefined;
      },
      get exited() {
        return Promise.resolve(0);
      },
    };
    const buildTunnel = mock(() => handle);
    const code = await runCli(["8080"], baseDeps({ buildTunnel, log: (m) => logged.push(m) }));
    expect(code).toBe(0);
    expect(buildTunnel).toHaveBeenCalledTimes(1);
    expect(logged.some((l) => l.includes("tunneling localhost:8080"))).toBe(true);
    expect(logged).toContain("login to server success");
  });

  it("refuses to tunnel when not logged in", async () => {
    const errors: string[] = [];
    const code = await runCli(["8080"], baseDeps({ store: fakeStore(null), error: (m) => errors.push(m) }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("not logged in");
  });

  it("rejects an out-of-range port", async () => {
    const errors: string[] = [];
    const code = await runCli(["99999"], baseDeps({ error: (m) => errors.push(m) }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("invalid port");
  });

  it("returns 1 when the tunnel fails to start", async () => {
    const errors: string[] = [];
    const handle: TunnelHandle = {
      on() {
        return this;
      },
      async start() {
        throw new Error("frpc boom");
      },
      get exited() {
        return Promise.resolve(0);
      },
    };
    const code = await runCli(["8080"], baseDeps({ buildTunnel: () => handle, error: (m) => errors.push(m) }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("frpc boom");
  });

  it("prints usage for an unknown command", async () => {
    const errors: string[] = [];
    expect(await runCli(["bogus"], baseDeps({ error: (m) => errors.push(m) }))).toBe(1);
    expect(await runCli([], baseDeps({ error: (m) => errors.push(m) }))).toBe(1);
    expect(errors[0]).toContain("usage");
    expect(errors[0]).toContain("logout");
  });

  it("devices: lists the account's subdomains, marking the current one", async () => {
    const logs: string[] = [];
    const listDevices = mock(async () => [
      { device_id: "dev-1", subdomain: "g1", created_at: 1, revoked: 0 },
      { device_id: "dev-2", subdomain: "g2", created_at: 2, revoked: 1 },
    ]);
    const code = await runCli(["devices"], baseDeps({ listDevices, log: (m) => logs.push(m) }));
    expect(code).toBe(0);
    expect(logs.some((l) => l.includes("g1") && l.includes("active") && l.includes("(this device)"))).toBe(true);
    expect(logs.some((l) => l.includes("g2") && l.includes("revoked"))).toBe(true);
  });

  it("devices: reports when there are none", async () => {
    const logs: string[] = [];
    const code = await runCli(["devices"], baseDeps({ listDevices: async () => [], log: (m) => logs.push(m) }));
    expect(code).toBe(0);
    expect(logs[0]).toContain("no devices yet");
  });

  it("devices: returns 1 on error", async () => {
    const errors: string[] = [];
    const code = await runCli(["devices"], baseDeps({
      listDevices: async () => {
        throw new Error("list boom");
      },
      error: (m) => errors.push(m),
    }));
    expect(code).toBe(1);
    expect(errors[0]).toBe("list boom");
  });

  it("revoke: revokes a subdomain and returns 0", async () => {
    const logs: string[] = [];
    const revokeDevice = mock(async () => true);
    const code = await runCli(["revoke", "g9"], baseDeps({ revokeDevice, log: (m) => logs.push(m) }));
    expect(code).toBe(0);
    expect(revokeDevice).toHaveBeenCalledTimes(1);
    expect(logs[0]).toContain("revoked g9");
  });

  it("revoke: accepts a full hostname and strips it to the bare subdomain", async () => {
    let seen = "";
    const revokeDevice = mock(async (_deps: unknown, subdomain: string) => {
      seen = subdomain;
      return true;
    });
    const code = await runCli(["revoke", `g9.${defaults.relayDomain}`], baseDeps({ revokeDevice, log: () => {} }));
    expect(code).toBe(0);
    expect(seen).toBe("g9"); // the `.<relayDomain>` suffix was stripped
  });

  it("revoke: returns 1 when nothing was revoked", async () => {
    const logs: string[] = [];
    const code = await runCli(["revoke", "gX"], baseDeps({ revokeDevice: async () => false, log: (m) => logs.push(m) }));
    expect(code).toBe(1);
    expect(logs[0]).toContain("no active subdomain");
  });

  it("revoke: requires a subdomain argument", async () => {
    const errors: string[] = [];
    const code = await runCli(["revoke"], baseDeps({ error: (m) => errors.push(m) }));
    expect(code).toBe(1);
    expect(errors[0]).toContain("usage: frp revoke");
  });

  it("revoke: returns 1 on error", async () => {
    const errors: string[] = [];
    const code = await runCli(["revoke", "g9"], baseDeps({
      revokeDevice: async () => {
        throw new Error("revoke boom");
      },
      error: (m) => errors.push(m),
    }));
    expect(code).toBe(1);
    expect(errors[0]).toBe("revoke boom");
  });

  it("logout: revokes this device's subdomain, clears the session, returns 0", async () => {
    const logs: string[] = [];
    const clearSession = mock(() => {});
    let seen = "";
    const revokeDevice = mock(async (_deps: unknown, subdomain: string) => {
      seen = subdomain;
      return true;
    });
    const code = await runCli(["logout"], baseDeps({
      store: fakeStore({ token: "t", subdomain: "g1", account: "a" }, clearSession),
      revokeDevice,
      log: (m) => logs.push(m),
    }));
    expect(code).toBe(0);
    expect(revokeDevice).toHaveBeenCalledTimes(1);
    expect(seen).toBe("g1"); // revoked the current session's subdomain
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("logged out"))).toBe(true);
  });

  it("logout: reports when not logged in and returns 0 without revoking", async () => {
    const logs: string[] = [];
    const clearSession = mock(() => {});
    const revokeDevice = mock(async () => true);
    const code = await runCli(["logout"], baseDeps({
      store: fakeStore(null, clearSession),
      revokeDevice,
      log: (m) => logs.push(m),
    }));
    expect(code).toBe(0);
    expect(logs[0]).toContain("not logged in");
    expect(revokeDevice).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("logout: returns 1 on revoke error without clearing the session", async () => {
    const errors: string[] = [];
    const clearSession = mock(() => {});
    const code = await runCli(["logout"], baseDeps({
      store: fakeStore({ token: "t", subdomain: "g1", account: "a" }, clearSession),
      revokeDevice: async () => {
        throw new Error("logout boom");
      },
      error: (m) => errors.push(m),
    }));
    expect(code).toBe(1);
    expect(errors[0]).toBe("logout boom");
    expect(clearSession).not.toHaveBeenCalled();
  });
});
