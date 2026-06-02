/**
 * Ensures an frpc binary exists locally, downloading and extracting the matching
 * frp release archive on first use. All side-effecting IO goes through an
 * injectable {@link DownloadIO}. Derived from the Apache-2.0 Bun wrapper for frpc
 * in fatedier/frp.
 */
import { dirname, basename } from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveTarget, type ResolveTargetOptions } from "./platform.ts";
import { bunSpawn, type SpawnFn } from "./process.ts";
import { FRP_CHECKSUMS } from "./checksums.ts";

/** Minimal fetch signature the downloader needs (a single URL -> Response). */
export type FetchFn = (url: string) => Promise<Response>;

export interface DownloadIO {
  fetchFn: FetchFn;
  spawnFn: SpawnFn;
  exists: (path: string) => Promise<boolean>;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: ArrayBuffer) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
}

export const defaultIO: DownloadIO = {
  fetchFn: (url) => fetch(url),
  spawnFn: bunSpawn,
  exists: (path) => Bun.file(path).exists(),
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, data) => { await Bun.write(path, data); },
  chmod: (path, mode) => chmod(path, mode),
};

export interface EnsureBinaryOptions extends ResolveTargetOptions {
  force?: boolean;
  onLog?: (message: string) => void;
  io?: Partial<DownloadIO>;
  /** archive filename → expected sha256 (hex). Defaults to the pinned table for the version. */
  checksums?: Record<string, string>;
}

/** Builds the extraction command for the given archive type. */
export function extractCommand(os: string, archive: string, destDir: string): string[] {
  // Windows ships tar.exe (bsdtar) since Win10 1803 and it extracts .zip; `unzip`
  // is NOT present on a stock Windows install, so prefer tar for portability.
  if (os === "windows") return ["tar", "-xf", archive, "-C", destDir];
  return ["tar", "-xzf", archive, "-C", destDir];
}

/** Ensures an frpc binary exists locally and returns its absolute path. */
export async function ensureBinary(options: EnsureBinaryOptions = {}): Promise<string> {
  const io: DownloadIO = { ...defaultIO, ...options.io };
  const log = options.onLog ?? (() => {});
  const target = resolveTarget(options);

  if (!options.force && (await io.exists(target.binary))) {
    log(`frpc: using cached binary at ${target.binary}`);
    return target.binary;
  }

  await io.mkdir(target.cacheDir);
  log(`frpc: downloading ${target.url}`);
  const response = await io.fetchFn(target.url);
  if (!response.ok) {
    throw new Error(`frpc: failed to download ${target.url} (HTTP ${response.status})`);
  }
  const bytes = await response.arrayBuffer();

  // Verify integrity before touching disk/exec: compare against the pinned
  // digest for this release. Unknown archives (e.g. a custom version override)
  // can't be checked, so warn rather than block.
  const expected = (options.checksums ?? FRP_CHECKSUMS[target.version] ?? {})[basename(target.archive)];
  if (expected) {
    const actual = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if (actual !== expected) {
      throw new Error(`frpc: checksum mismatch for ${basename(target.archive)} (expected ${expected}, got ${actual})`);
    }
    log(`frpc: checksum verified (${basename(target.archive)})`);
  } else {
    log(`frpc: no pinned checksum for ${basename(target.archive)} — skipping verification`);
  }

  await io.writeFile(target.archive, bytes);

  log(`frpc: extracting ${target.archive}`);
  const cmd = extractCommand(target.os, target.archive, target.cacheDir);
  const proc = io.spawnFn(cmd, { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`frpc: extraction failed (\`${cmd[0]}\` exited with code ${code})`);
  }

  if (target.os !== "windows") {
    await io.chmod(target.binary, 0o755);
  }
  if (!(await io.exists(target.binary))) {
    throw new Error(`frpc: binary not found at ${target.binary} after extraction`);
  }
  log(`frpc: ready at ${target.binary}`);
  return target.binary;
}

/** The directory that will hold the cached binary, useful for cleanup. */
export function binaryCacheRoot(options: ResolveTargetOptions = {}): string {
  return dirname(resolveTarget(options).binary);
}
