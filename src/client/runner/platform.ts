/**
 * Pure mapping from the host platform to the frp release asset URL and the local
 * path where the extracted frpc binary lives. No IO. Derived from the Apache-2.0
 * Bun wrapper for frpc in fatedier/frp.
 */
import { join } from "node:path";

/** Directory bundled with the installed package where the binary is cached. */
export const PACKAGE_BIN_DIR = join(import.meta.dir, "..", "..", "..", "bin");

/** The frp release this client targets by default. Matches frps in docker-compose. */
export const DEFAULT_VERSION = "0.69.1";

/** GitHub owner/repo that publishes the prebuilt frpc binaries. */
export const RELEASE_REPO = "fatedier/frp";

const OS_TOKENS = new Set(["linux", "windows", "darwin", "freebsd", "openbsd", "android"]);

/** Maps `process.platform` onto the frp release OS token. Throws if unsupported. */
export function mapPlatform(platform: NodeJS.Platform): string {
  const os = platform === "win32" ? "windows" : platform;
  if (!OS_TOKENS.has(os)) throw new Error(`frpc: unsupported platform "${platform}"`);
  return os;
}

const ARCH_MAP: Record<string, string> = {
  x64: "amd64",
  ia32: "386",
  arm64: "arm64",
  arm: "arm_hf",
  mips: "mips",
  mipsel: "mipsle",
  riscv64: "riscv64",
  loong64: "loong64",
};

/** Maps `process.arch` onto the frp release arch token. Throws if unsupported. */
export function mapArch(arch: string): string {
  const mapped = ARCH_MAP[arch];
  if (!mapped) throw new Error(`frpc: unsupported architecture "${arch}"`);
  return mapped;
}

/** Extracted release directory name, e.g. `frp_0.69.1_darwin_arm64`. */
export function releaseDirName(version: string, os: string, arch: string): string {
  return `frp_${version}_${os}_${arch}`;
}

/** Archive file extension for the given OS. */
export function archiveExtension(os: string): string {
  return os === "windows" ? ".zip" : ".tar.gz";
}

/** Full archive file name, e.g. `frp_0.69.1_linux_amd64.tar.gz`. */
export function archiveName(version: string, os: string, arch: string): string {
  return releaseDirName(version, os, arch) + archiveExtension(os);
}

/** Name of the frpc executable for the given OS. */
export function binaryName(os: string): string {
  return os === "windows" ? "frpc.exe" : "frpc";
}

/** GitHub download URL for the release archive. */
export function assetUrl(version: string, os: string, arch: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${archiveName(version, os, arch)}`;
}

/** Cache directory for the binary; honors FRPC_CACHE_DIR, else the package bin/. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRPC_CACHE_DIR ?? PACKAGE_BIN_DIR;
}

/** Absolute path of the cached frpc binary for a version/os/arch. */
export function binaryPath(version: string, os: string, arch: string, cacheDir: string): string {
  return join(cacheDir, releaseDirName(version, os, arch), binaryName(os));
}

export interface ResolvedTarget {
  version: string;
  os: string;
  arch: string;
  cacheDir: string;
  url: string;
  archive: string;
  binary: string;
}

export interface ResolveTargetOptions {
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Resolves every platform-specific path/URL needed to fetch and locate frpc. */
export function resolveTarget(opts: ResolveTargetOptions = {}): ResolvedTarget {
  const env = opts.env ?? process.env;
  const version = opts.version ?? DEFAULT_VERSION;
  const os = mapPlatform(opts.platform ?? process.platform);
  const arch = mapArch(opts.arch ?? process.arch);
  const cacheDir = opts.cacheDir ?? defaultCacheDir(env);
  return {
    version,
    os,
    arch,
    cacheDir,
    url: assetUrl(version, os, arch),
    archive: join(cacheDir, archiveName(version, os, arch)),
    binary: binaryPath(version, os, arch, cacheDir),
  };
}
