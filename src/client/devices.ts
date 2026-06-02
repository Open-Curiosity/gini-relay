/**
 * Device management against the relay's `/devices` API, authenticated with the
 * stored session token (account-scoped):
 *   listDevices()           -> every device/subdomain owned by your account
 *   revokeDevice(subdomain) -> revoke one device's session (instant, per-device)
 *
 * Revoking kills that device's token at the server (Login/NewProxy/devices all
 * reject it); other devices are unaffected. Re-login (`frp login`) mints a NEW
 * session token while keeping the device's subdomain.
 */
import type { Store } from "./store.ts";

export interface Device {
  device_id: string;
  subdomain: string;
  created_at: number;
  /** 0 = active, 1 = revoked. */
  revoked: number;
}

export interface DevicesDeps {
  store: Store;
  relayUrl: string;
  fetchFn?: typeof fetch;
}

function bearer(deps: DevicesDeps): { token: string; fetchFn: typeof fetch } {
  const session = deps.store.readSession();
  if (!session) throw new Error("not logged in — run `frp login` first");
  return { token: session.token, fetchFn: deps.fetchFn ?? fetch };
}

/** Lists every device (and its subdomain) owned by the logged-in account. */
export async function listDevices(deps: DevicesDeps): Promise<Device[]> {
  const { token, fetchFn } = bearer(deps);
  const res = await fetchFn(`${deps.relayUrl}/devices`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`could not list devices: ${res.status}`);
  const body = (await res.json()) as { devices?: Device[] };
  return Array.isArray(body.devices) ? body.devices : [];
}

/** Revokes one subdomain owned by the account. Returns true if a row changed. */
export async function revokeDevice(deps: DevicesDeps, subdomain: string): Promise<boolean> {
  const { token, fetchFn } = bearer(deps);
  const res = await fetchFn(`${deps.relayUrl}/devices/${encodeURIComponent(subdomain)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`could not revoke ${subdomain}: ${res.status}`);
  const body = (await res.json()) as { revoked?: boolean };
  return body.revoked === true;
}
