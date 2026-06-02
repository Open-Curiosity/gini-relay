import { describe, it, expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createPkce, newState } from "../src/client/pkce.ts";

describe("createPkce", () => {
  it("produces deterministic verifier and challenge with injected rng", () => {
    const buf = Buffer.from("0123456789abcdef0123456789abcdef");
    const { verifier, challenge } = createPkce(() => buf);

    const expectedVerifier = buf.toString("base64url");
    const expectedChallenge = createHash("sha256")
      .update(expectedVerifier)
      .digest("base64url");

    expect(verifier).toBe(expectedVerifier);
    expect(challenge).toBe(expectedChallenge);
  });

  it("default produces a verifier and a 43-char base64url challenge", () => {
    const { verifier, challenge } = createPkce();
    expect(typeof verifier).toBe("string");
    expect(verifier.length).toBeGreaterThan(0);
    // base64url of a 32-byte sha256 digest is 43 chars (no padding)
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);

    // challenge is the sha256 base64url of the verifier
    const recomputed = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(recomputed);
  });
});

describe("newState", () => {
  it("returns the injected generator's value", () => {
    expect(newState(() => "fixed-state")).toBe("fixed-state");
  });

  it("default returns a uuid-shaped string", () => {
    const state = newState();
    expect(state).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // sanity: matches the format produced by randomUUID
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
