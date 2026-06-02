/**
 * The `frp` CLI dispatcher:
 *   frp login              loopback Google sign-in; persists the session
 *   frp <port>             tunnel a local port over a supervised native frpc
 *   frp devices            list your account's devices/subdomains
 *   frp revoke <subdomain> revoke one (re-login mints a new session token)
 *   frp logout             revoke this device and clear the local session
 *
 * Every dependency is injectable so the dispatcher is fully testable; the thin
 * bin entry calls `runCli(process.argv.slice(2))` with real defaults.
 */
import { login as defaultLogin, type LoginDeps } from "./auth.ts";
import { buildTunnel as defaultBuildTunnel, validatePort, type TunnelOptions } from "./tunnel.ts";
import { startLoopback as defaultStartLoopback, openBrowser as defaultOpenBrowser, type StartLoopback } from "./loopback.ts";
import { listDevices as defaultListDevices, revokeDevice as defaultRevokeDevice, type Device, type DevicesDeps } from "./devices.ts";
import { createStore, type Store } from "./store.ts";
import { resolveDefaults, type RelayDefaults } from "./defaults.ts";

/** The subset of the supervised client the CLI drives. */
export interface TunnelHandle {
  on(event: "log", listener: (line: string) => void): unknown;
  start(): Promise<unknown>;
  readonly exited: Promise<number>;
}

export interface CliDeps {
  store?: Store;
  defaults?: RelayDefaults;
  login?: (deps: LoginDeps) => Promise<number>;
  buildTunnel?: (opts: TunnelOptions) => TunnelHandle;
  startLoopback?: StartLoopback;
  openBrowser?: (url: string) => void;
  listDevices?: (deps: DevicesDeps) => Promise<Device[]>;
  revokeDevice?: (deps: DevicesDeps, subdomain: string) => Promise<boolean>;
  log?: (m: string) => void;
  error?: (m: string) => void;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const store = deps.store ?? createStore();
  const defaults = deps.defaults ?? resolveDefaults();
  const cmd = argv[0];

  if (cmd === "login") {
    const login = deps.login ?? defaultLogin;
    return login({
      store,
      relayUrl: defaults.relayUrl,
      relayDomain: defaults.relayDomain,
      loopbackPorts: defaults.loopbackPorts,
      startLoopback: deps.startLoopback ?? defaultStartLoopback,
      openBrowser: deps.openBrowser ?? defaultOpenBrowser,
      log,
      error,
    });
  }

  if (cmd && /^[0-9]+$/.test(cmd)) {
    const session = store.readSession();
    if (!session) {
      error("not logged in — run `frp login` first");
      return 1;
    }
    const port = validatePort(cmd);
    if (port === null) {
      error(`invalid port: ${cmd} (must be 1-65535)`);
      return 1;
    }
    const deviceId = store.deviceId();
    log(`tunneling localhost:${cmd}  ->  https://${session.subdomain}.${defaults.relayDomain}`);
    const buildTunnel = (deps.buildTunnel ?? (defaultBuildTunnel as (opts: TunnelOptions) => TunnelHandle));
    const frpc = buildTunnel({ session, deviceId, port, defaults });
    frpc.on("log", (line) => log(line));
    try {
      await frpc.start();
    } catch (e) {
      error((e as Error).message);
      return 1;
    }
    return frpc.exited;
  }

  if (cmd === "devices") {
    try {
      const devices = await (deps.listDevices ?? defaultListDevices)({ store, relayUrl: defaults.relayUrl });
      if (devices.length === 0) {
        log("no devices yet — run `frp login`");
        return 0;
      }
      const current = store.readSession()?.subdomain;
      for (const d of devices) {
        const here = d.subdomain === current ? " (this device)" : "";
        const state = d.revoked ? "revoked" : "active";
        log(`${d.subdomain}.${defaults.relayDomain}  [${state}]  device=${d.device_id}${here}`);
      }
      return 0;
    } catch (e) {
      error((e as Error).message);
      return 1;
    }
  }

  if (cmd === "revoke") {
    const arg = argv[1];
    if (!arg) {
      error("usage: frp revoke <subdomain>");
      return 1;
    }
    // Accept either the bare subdomain or the full hostname `frp devices` prints.
    const suffix = `.${defaults.relayDomain}`;
    const subdomain = arg.endsWith(suffix) ? arg.slice(0, -suffix.length) : arg;
    try {
      const revoked = await (deps.revokeDevice ?? defaultRevokeDevice)({ store, relayUrl: defaults.relayUrl }, subdomain);
      log(revoked ? `revoked ${subdomain} — run \`frp login\` for a new session token` : `no active subdomain ${subdomain} to revoke`);
      return revoked ? 0 : 1;
    } catch (e) {
      error((e as Error).message);
      return 1;
    }
  }

  if (cmd === "logout") {
    const session = store.readSession();
    if (!session) {
      log("not logged in");
      return 0;
    }
    try {
      await (deps.revokeDevice ?? defaultRevokeDevice)({ store, relayUrl: defaults.relayUrl }, session.subdomain);
      store.clearSession();
      log("logged out (this device revoked; other devices unaffected)");
      return 0;
    } catch (e) {
      error((e as Error).message);
      return 1;
    }
  }

  error("usage: frp login | frp <port> | frp devices | frp revoke <subdomain> | frp logout");
  return 1;
}
