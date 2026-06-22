/**
 * Bandwidth tier: the single per-device cap and the strict parser the policy
 * uses to vet what a client declares in NewProxy.
 */

/** Per-device cap as frp's string form. 10*1024*1024 = 10 MiB/s = 83.886 Mbit/s. */
export const BANDWIDTH = "10MB";

/** The cap in bytes/s; a declared limit must parse to <= this. */
export const CAP_BYTES = 10 * 1024 * 1024;

/** Only http subdomain tunnels are supported (TLS terminates at Caddy). */
export const SUPPORTED_PROXY = new Set(["http"]);

/**
 * Parses an frp bandwidth string ("1220KB", "5MB") to bytes/s. Strict: digits +
 * unit and nothing else; returns null for anything malformed, non-positive, or
 * non-finite so a garbage value can't slip past the tier check as NaN.
 */
export function parseBw(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)(KB|MB)$/.exec(s);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]!) * (m[2] === "MB" ? 1024 * 1024 : 1024));
  return Number.isFinite(n) && n > 0 ? n : null;
}
