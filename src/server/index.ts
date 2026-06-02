/**
 * Server-internal barrel. The relay brain is deployed via Docker (src/server/bin.ts),
 * not consumed as a library — the root package exports only the client. This
 * barrel exists so tests and the bin entry import from one place.
 */
export { BANDWIDTH, CAP_BYTES, SUPPORTED_PROXY, parseBw } from "./bandwidth.ts";
export {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  LOOPBACK_PORTS,
  LOOPBACK_REDIRECTS,
  googleAuthUrl,
  exchangeGoogleCode,
  decodeJwtClaims,
  type ExchangeDeps,
} from "./oauth.ts";
export { openDb, createRegistry, sha256hex, type Registry, type DeviceRow, type RegistryOptions } from "./registry.ts";
export { createApp, type AppDeps } from "./handlers.ts";
export { loadServerConfig, assertStartable, type ServerConfig } from "./config.ts";
