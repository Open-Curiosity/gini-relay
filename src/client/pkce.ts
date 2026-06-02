/**
 * PKCE (RFC 7636) + state generation for the loopback OAuth flow. The verifier
 * is a high-entropy secret kept on the client; only its S256 challenge travels to
 * Google, so an intercepted auth code can't be redeemed without the verifier.
 */
import { randomBytes, createHash, randomUUID } from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Generates a PKCE verifier and its S256 challenge. `rng` is injectable for tests. */
export function createPkce(rng: () => Buffer = () => randomBytes(32)): Pkce {
  const verifier = rng().toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Generates an opaque OAuth `state` value. `gen` is injectable for tests. */
export function newState(gen: () => string = randomUUID): string {
  return gen();
}
