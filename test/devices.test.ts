import { describe, it, expect, mock } from "bun:test";
import { listDevices, revokeDevice } from "../src/client/devices.ts";
import type { Store, Session } from "../src/client/store.ts";

function storeWith(session: Session | null): Store {
  return { home: "/x", deviceId: () => "dev", readSession: () => session, writeSession: () => {}, clearSession: () => {} };
}
function resp(ok: boolean, json: unknown, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => json, text: async () => "" } as unknown as Response;
}
const SESSION: Session = { token: "tok", subdomain: "g1", account: "a@x" };

describe("listDevices", () => {
  it("GETs /devices with the bearer token and returns the list", async () => {
    let seen: { url: string; init: { headers: Record<string, string> } } | undefined;
    const fetchFn = mock(async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, init };
      return resp(true, { account: "a@x", devices: [{ device_id: "d1", subdomain: "g1", created_at: 1, revoked: 0 }] });
    }) as unknown as typeof fetch;
    const out = await listDevices({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn });
    expect(out).toEqual([{ device_id: "d1", subdomain: "g1", created_at: 1, revoked: 0 }]);
    expect(seen!.url).toBe("https://r/devices");
    expect(seen!.init.headers.authorization).toBe("Bearer tok");
  });

  it("returns [] when the body has no devices array", async () => {
    const fetchFn = mock(async () => resp(true, {})) as unknown as typeof fetch;
    expect(await listDevices({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn })).toEqual([]);
  });

  it("throws when not logged in", async () => {
    await expect(listDevices({ store: storeWith(null), relayUrl: "https://r" })).rejects.toThrow(/not logged in/);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = mock(async () => resp(false, {}, 401)) as unknown as typeof fetch;
    await expect(listDevices({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn })).rejects.toThrow(/could not list devices: 401/);
  });
});

describe("revokeDevice", () => {
  it("DELETEs the (encoded) subdomain with the bearer token and returns true", async () => {
    let seen: { url: string; init: { method: string; headers: Record<string, string> } } | undefined;
    const fetchFn = mock(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      seen = { url, init };
      return resp(true, { revoked: true, subdomain: "g1" });
    }) as unknown as typeof fetch;
    expect(await revokeDevice({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn }, "g1")).toBe(true);
    expect(seen!.url).toBe("https://r/devices/g1");
    expect(seen!.init.method).toBe("DELETE");
    expect(seen!.init.headers.authorization).toBe("Bearer tok");
  });

  it("returns false when nothing was revoked", async () => {
    const fetchFn = mock(async () => resp(true, { revoked: false })) as unknown as typeof fetch;
    expect(await revokeDevice({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn }, "gX")).toBe(false);
  });

  it("percent-encodes the subdomain in the path", async () => {
    let seenUrl = "";
    const fetchFn = mock(async (url: string) => {
      seenUrl = url;
      return resp(true, { revoked: true });
    }) as unknown as typeof fetch;
    await revokeDevice({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn }, "g/x y");
    expect(seenUrl).toBe("https://r/devices/g%2Fx%20y");
  });

  it("throws when not logged in", async () => {
    await expect(revokeDevice({ store: storeWith(null), relayUrl: "https://r" }, "g1")).rejects.toThrow(/not logged in/);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = mock(async () => resp(false, {}, 500)) as unknown as typeof fetch;
    await expect(revokeDevice({ store: storeWith(SESSION), relayUrl: "https://r", fetchFn }, "g1")).rejects.toThrow(/could not revoke g1: 500/);
  });
});
