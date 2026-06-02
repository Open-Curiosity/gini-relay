/**
 * Public client surface — the ONLY entry point consumers get.
 *
 * Because bun can't install a single sub-package out of a monorepo, a
 * `bun add git+ssh://…/gini-relay.git` installs the whole repo and reads its
 * root package.json, whose `exports`/`main` point here. So even though the
 * server code ships in the repo, importing "gini-relay" yields only this client
 * API.
 *
 *   import { login, buildTunnel, runCli, resolveDefaults } from "gini-relay";
 *
 * This barrel deliberately exposes the meaningful client API (login, tunnel,
 * config, store, defaults, and the native frpc supervisor) — not the low-level
 * runner plumbing (release-asset name helpers, spawn primitives), which stay
 * internal so they aren't locked into the package's compatibility surface.
 */
export { runCli, type CliDeps, type TunnelHandle } from "./cli.ts";
export { login, loginUrl, type LoginDeps, type LoginUrlDeps, type LoginHandle } from "./auth.ts";
export { buildTunnel, validatePort, type TunnelOptions } from "./tunnel.ts";
export { listDevices, revokeDevice, type Device, type DevicesDeps } from "./devices.ts";
export { buildFrpcConfig, type BuildConfigOptions, type FrpcConfig } from "./config.ts";
export { startLoopback, openBrowser, type Loopback, type StartLoopback } from "./loopback.ts";
export { createStore, type Store, type StoreOptions, type Session } from "./store.ts";
export { createPkce, newState, type Pkce } from "./pkce.ts";
export { resolveDefaults, DEFAULTS, PACKAGE_ROOT, type RelayDefaults } from "./defaults.ts";

// Native frpc runner: the supervisor lifecycle, binary resolution, and the
// downloader — enough to drive a tunnel, without the asset-name internals.
export {
  Frpc,
  runFrpc,
  resolveBinary,
  type FrpcOptions,
  type FrpcEvents,
  type ResolveBinaryDeps,
} from "./runner/supervisor.ts";
export { ensureBinary, type EnsureBinaryOptions, type DownloadIO, type FetchFn } from "./runner/download.ts";
export { resolveTarget, DEFAULT_VERSION, type ResolvedTarget, type ResolveTargetOptions } from "./runner/platform.ts";
export { isReadyLine, isProxyStartLine, isFatalLine } from "./runner/logparse.ts";
