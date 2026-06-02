#!/usr/bin/env bun
/**
 * Runs on `bun install` for the client package. Downloads the frpc binary
 * matching the host platform into the package's own bin/ directory so a tunnel
 * works immediately with no docker. Failures are non-fatal: the binary is
 * fetched lazily on first use if the network was unavailable here.
 */
import { ensureBinary } from "../src/client/runner/download.ts";
import { PACKAGE_BIN_DIR } from "../src/client/runner/platform.ts";

if (process.env.FRPC_SKIP_DOWNLOAD === "1") {
  console.log("frpc: FRPC_SKIP_DOWNLOAD=1 set, skipping binary download");
  process.exit(0);
}

try {
  const path = await ensureBinary({ cacheDir: PACKAGE_BIN_DIR, onLog: (m) => console.log(m) });
  console.log(`frpc: binary available at ${path}`);
} catch (err) {
  console.warn(
    `frpc: postinstall download failed (${(err as Error).message}); the binary will be fetched on first use.`,
  );
}
