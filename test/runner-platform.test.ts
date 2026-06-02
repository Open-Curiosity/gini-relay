import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import {
  PACKAGE_BIN_DIR,
  DEFAULT_VERSION,
  RELEASE_REPO,
  mapPlatform,
  mapArch,
  releaseDirName,
  archiveExtension,
  archiveName,
  binaryName,
  assetUrl,
  defaultCacheDir,
  binaryPath,
  resolveTarget,
} from "../src/client/runner/platform.ts";

describe("constants", () => {
  it("exposes the expected defaults", () => {
    expect(DEFAULT_VERSION).toBe("0.69.1");
    expect(RELEASE_REPO).toBe("fatedier/frp");
    expect(PACKAGE_BIN_DIR).toBe(join(import.meta.dir, "..", "bin"));
  });
});

describe("mapPlatform", () => {
  it("maps win32 to windows", () => {
    expect(mapPlatform("win32")).toBe("windows");
  });
  it("passes through linux and darwin", () => {
    expect(mapPlatform("linux")).toBe("linux");
    expect(mapPlatform("darwin")).toBe("darwin");
  });
  it("throws on unsupported platform", () => {
    expect(() => mapPlatform("sunos" as NodeJS.Platform)).toThrow(
      'frpc: unsupported platform "sunos"',
    );
  });
});

describe("mapArch", () => {
  it("maps x64/arm64/arm", () => {
    expect(mapArch("x64")).toBe("amd64");
    expect(mapArch("arm64")).toBe("arm64");
    expect(mapArch("arm")).toBe("arm_hf");
  });
  it("throws on unsupported arch", () => {
    expect(() => mapArch("sparc")).toThrow('frpc: unsupported architecture "sparc"');
  });
});

describe("name/path helpers", () => {
  it("releaseDirName", () => {
    expect(releaseDirName("0.69.1", "darwin", "arm64")).toBe("frp_0.69.1_darwin_arm64");
  });
  it("archiveExtension", () => {
    expect(archiveExtension("windows")).toBe(".zip");
    expect(archiveExtension("linux")).toBe(".tar.gz");
  });
  it("archiveName", () => {
    expect(archiveName("0.69.1", "linux", "amd64")).toBe("frp_0.69.1_linux_amd64.tar.gz");
    expect(archiveName("0.69.1", "windows", "amd64")).toBe("frp_0.69.1_windows_amd64.zip");
  });
  it("binaryName", () => {
    expect(binaryName("windows")).toBe("frpc.exe");
    expect(binaryName("linux")).toBe("frpc");
  });
  it("assetUrl", () => {
    expect(assetUrl("0.69.1", "linux", "amd64")).toBe(
      "https://github.com/fatedier/frp/releases/download/v0.69.1/frp_0.69.1_linux_amd64.tar.gz",
    );
  });
  it("binaryPath", () => {
    expect(binaryPath("0.69.1", "windows", "amd64", "/cache")).toBe(
      join("/cache", "frp_0.69.1_windows_amd64", "frpc.exe"),
    );
    expect(binaryPath("0.69.1", "linux", "amd64", "/cache")).toBe(
      join("/cache", "frp_0.69.1_linux_amd64", "frpc"),
    );
  });
});

describe("defaultCacheDir", () => {
  it("honors FRPC_CACHE_DIR", () => {
    expect(defaultCacheDir({ FRPC_CACHE_DIR: "/custom" })).toBe("/custom");
  });
  it("falls back to PACKAGE_BIN_DIR", () => {
    expect(defaultCacheDir({})).toBe(PACKAGE_BIN_DIR);
  });
  it("defaults to process.env when no arg", () => {
    // Just exercise the default-parameter seam; result is deterministic given env.
    expect(defaultCacheDir()).toBe(process.env.FRPC_CACHE_DIR ?? PACKAGE_BIN_DIR);
  });
});

describe("resolveTarget", () => {
  it("resolves all fields from explicit opts", () => {
    const t = resolveTarget({
      version: "1.2.3",
      platform: "win32",
      arch: "x64",
      cacheDir: "/cache",
      env: { FRPC_CACHE_DIR: "/ignored" },
    });
    expect(t).toEqual({
      version: "1.2.3",
      os: "windows",
      arch: "amd64",
      cacheDir: "/cache",
      url: "https://github.com/fatedier/frp/releases/download/v1.2.3/frp_1.2.3_windows_amd64.zip",
      archive: join("/cache", "frp_1.2.3_windows_amd64.zip"),
      binary: join("/cache", "frp_1.2.3_windows_amd64", "frpc.exe"),
    });
  });

  it("uses env-provided FRPC_CACHE_DIR when cacheDir omitted", () => {
    const t = resolveTarget({
      version: "0.69.1",
      platform: "linux",
      arch: "arm64",
      env: { FRPC_CACHE_DIR: "/env-cache" },
    });
    expect(t.cacheDir).toBe("/env-cache");
    expect(t.os).toBe("linux");
    expect(t.arch).toBe("arm64");
    expect(t.archive).toBe(join("/env-cache", "frp_0.69.1_linux_arm64.tar.gz"));
    expect(t.binary).toBe(join("/env-cache", "frp_0.69.1_linux_arm64", "frpc"));
  });

  it("falls back to all defaults when no opts", () => {
    const t = resolveTarget();
    expect(t.version).toBe(DEFAULT_VERSION);
    expect(t.os).toBe(mapPlatform(process.platform));
    expect(t.arch).toBe(mapArch(process.arch));
    expect(t.cacheDir).toBe(defaultCacheDir());
    expect(t.url).toBe(assetUrl(t.version, t.os, t.arch));
    expect(t.archive).toBe(join(t.cacheDir, archiveName(t.version, t.os, t.arch)));
    expect(t.binary).toBe(binaryPath(t.version, t.os, t.arch, t.cacheDir));
  });
});
