import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  extractCommand,
  ensureBinary,
  binaryCacheRoot,
  defaultIO,
  type DownloadIO,
} from "../src/client/runner/download.ts";
import { archiveName } from "../src/client/runner/platform.ts";
import type { SpawnedProcess } from "../src/client/runner/process.ts";

const FAKE_BYTES = new ArrayBuffer(4);
const FAKE_SHA256 = createHash("sha256")
  .update(Buffer.from(FAKE_BYTES))
  .digest("hex");
// Archive basename for the unknown-version baseOpts (linux/x64/9.9.9).
const FAKE_ARCHIVE = archiveName("9.9.9", "linux", "amd64");

function fakeProc(code: number): SpawnedProcess {
  return {
    pid: 1234,
    stdout: null,
    stderr: null,
    exited: Promise.resolve(code),
    kill: () => {},
  };
}

const baseOpts = {
  cacheDir: "/tmp/frpc-cache",
  version: "9.9.9",
  platform: "linux" as NodeJS.Platform,
  arch: "x64",
};

describe("extractCommand", () => {
  it("uses tar (bsdtar handles zip) on windows", () => {
    expect(extractCommand("windows", "a.zip", "/dest")).toEqual([
      "tar",
      "-xf",
      "a.zip",
      "-C",
      "/dest",
    ]);
  });

  it("uses tar on non-windows", () => {
    expect(extractCommand("linux", "a.tar.gz", "/dest")).toEqual([
      "tar",
      "-xzf",
      "a.tar.gz",
      "-C",
      "/dest",
    ]);
  });
});

describe("binaryCacheRoot", () => {
  it("returns the dirname of the resolved binary", () => {
    const root = binaryCacheRoot(baseOpts);
    expect(root).toBe("/tmp/frpc-cache/frp_9.9.9_linux_amd64");
  });
});

describe("defaultIO", () => {
  it("exposes the six IO keys", () => {
    expect(Object.keys(defaultIO).sort()).toEqual(
      ["chmod", "exists", "fetchFn", "mkdir", "spawnFn", "writeFile"].sort(),
    );
  });

  it("exercises each default IO member", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = join(tmpdir(), `frpc-defaultio-${process.pid}-${Date.now()}`);
    const dir = join(base, "sub");
    const file = join(base, "f.bin");
    try {
      // mkdir (recursive) then verify via a file written inside it
      await defaultIO.mkdir(dir);
      const inDir = join(dir, "inner.bin");
      await defaultIO.writeFile(inDir, new Uint8Array([9]).buffer);
      expect(await defaultIO.exists(inDir)).toBe(true);
      // writeFile
      await defaultIO.writeFile(file, new Uint8Array([1, 2, 3]).buffer);
      expect(await defaultIO.exists(file)).toBe(true);
      // exists false for a non-existent path
      expect(await defaultIO.exists(join(base, "nope"))).toBe(false);
      // chmod
      await defaultIO.chmod(file, 0o644);
      // fetchFn (intercept global fetch so no real network)
      const origFetch = globalThis.fetch;
      let fetchedUrl = "";
      // @ts-expect-error override for test
      globalThis.fetch = async (u: string) => {
        fetchedUrl = u;
        return new Response("ok", { status: 200 });
      };
      try {
        const res = await defaultIO.fetchFn("http://example.test/x");
        expect(fetchedUrl).toBe("http://example.test/x");
        expect(res.status).toBe(200);
      } finally {
        globalThis.fetch = origFetch;
      }
      // spawnFn (real, trivial command that exits quickly)
      const proc = defaultIO.spawnFn(["true"], { stdout: "ignore", stderr: "ignore" });
      const code = await proc.exited;
      expect(code).toBe(0);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("ensureBinary", () => {
  it("returns cached binary without downloading", async () => {
    let fetched = false;
    const io: Partial<DownloadIO> = {
      exists: async () => true,
      fetchFn: async () => {
        fetched = true;
        return new Response(new ArrayBuffer(4), { status: 200 });
      },
    };
    const logs: string[] = [];
    const result = await ensureBinary({ ...baseOpts, io, onLog: (m) => logs.push(m) });
    expect(result).toBe("/tmp/frpc-cache/frp_9.9.9_linux_amd64/frpc");
    expect(fetched).toBe(false);
    expect(logs.some((l) => l.includes("using cached"))).toBe(true);
  });

  it("downloads, extracts, chmods on success (non-windows)", async () => {
    const existsCalls: boolean[] = [false, true];
    let chmodPath = "";
    let chmodMode = -1;
    let wrote: ArrayBuffer | null = null;
    let mkdirCalled = "";
    let spawnCmd: string[] = [];
    const io: Partial<DownloadIO> = {
      exists: async () => existsCalls.shift()!,
      fetchFn: async () => new Response(new ArrayBuffer(4), { status: 200 }),
      spawnFn: (cmd) => {
        spawnCmd = cmd;
        return fakeProc(0);
      },
      mkdir: async (p) => {
        mkdirCalled = p;
      },
      writeFile: async (_p, d) => {
        wrote = d;
      },
      chmod: async (p, m) => {
        chmodPath = p;
        chmodMode = m;
      },
    };
    const result = await ensureBinary({ ...baseOpts, io });
    expect(result).toBe("/tmp/frpc-cache/frp_9.9.9_linux_amd64/frpc");
    expect(mkdirCalled).toBe("/tmp/frpc-cache");
    expect(wrote).toBeInstanceOf(ArrayBuffer);
    expect(chmodPath).toBe(result);
    expect(chmodMode).toBe(0o755);
    expect(spawnCmd[0]).toBe("tar");
  });

  it("does not chmod on windows and uses tar", async () => {
    const existsCalls: boolean[] = [false, true];
    let chmodCalled = false;
    let spawnCmd: string[] = [];
    const io: Partial<DownloadIO> = {
      exists: async () => existsCalls.shift()!,
      fetchFn: async () => new Response(new ArrayBuffer(4), { status: 200 }),
      spawnFn: (cmd) => {
        spawnCmd = cmd;
        return fakeProc(0);
      },
      mkdir: async () => {},
      writeFile: async () => {},
      chmod: async () => {
        chmodCalled = true;
      },
    };
    const result = await ensureBinary({
      ...baseOpts,
      platform: "win32",
      io,
    });
    expect(result).toBe("/tmp/frpc-cache/frp_9.9.9_windows_amd64/frpc.exe");
    expect(chmodCalled).toBe(false);
    expect(spawnCmd[0]).toBe("tar");
  });

  it("throws when response is not ok", async () => {
    const io: Partial<DownloadIO> = {
      exists: async () => false,
      fetchFn: async () => new Response(new ArrayBuffer(0), { status: 404 }),
      mkdir: async () => {},
    };
    await expect(ensureBinary({ ...baseOpts, io })).rejects.toThrow(
      /failed to download.*HTTP 404/,
    );
  });

  it("throws when extraction exits non-zero", async () => {
    const io: Partial<DownloadIO> = {
      exists: async () => false,
      fetchFn: async () => new Response(new ArrayBuffer(4), { status: 200 }),
      spawnFn: () => fakeProc(2),
      mkdir: async () => {},
      writeFile: async () => {},
    };
    await expect(ensureBinary({ ...baseOpts, io })).rejects.toThrow(
      /extraction failed.*exited with code 2/,
    );
  });

  it("throws when binary missing after extraction", async () => {
    const io: Partial<DownloadIO> = {
      exists: async () => false,
      fetchFn: async () => new Response(new ArrayBuffer(4), { status: 200 }),
      spawnFn: () => fakeProc(0),
      mkdir: async () => {},
      writeFile: async () => {},
      chmod: async () => {},
    };
    await expect(ensureBinary({ ...baseOpts, io })).rejects.toThrow(
      /binary not found.*after extraction/,
    );
  });

  it("re-downloads even when cached if force is true", async () => {
    let fetched = false;
    const existsCalls: boolean[] = [true, true];
    const io: Partial<DownloadIO> = {
      exists: async () => existsCalls.shift()!,
      fetchFn: async () => {
        fetched = true;
        return new Response(new ArrayBuffer(4), { status: 200 });
      },
      spawnFn: () => fakeProc(0),
      mkdir: async () => {},
      writeFile: async () => {},
      chmod: async () => {},
    };
    const result = await ensureBinary({ ...baseOpts, force: true, io });
    expect(fetched).toBe(true);
    expect(result).toBe("/tmp/frpc-cache/frp_9.9.9_linux_amd64/frpc");
  });

  it("verifies a matching checksum and proceeds", async () => {
    const existsCalls: boolean[] = [false, true];
    const logs: string[] = [];
    const io: Partial<DownloadIO> = {
      exists: async () => existsCalls.shift()!,
      fetchFn: async () => new Response(new ArrayBuffer(4), { status: 200 }),
      spawnFn: () => fakeProc(0),
      mkdir: async () => {},
      writeFile: async () => {},
      chmod: async () => {},
    };
    const result = await ensureBinary({
      ...baseOpts,
      io,
      onLog: (m) => logs.push(m),
      checksums: { [FAKE_ARCHIVE]: FAKE_SHA256 },
    });
    expect(result).toBe("/tmp/frpc-cache/frp_9.9.9_linux_amd64/frpc");
    expect(logs.some((l) => l.includes("checksum verified"))).toBe(true);
  });

  it("throws on a checksum mismatch", async () => {
    const io: Partial<DownloadIO> = {
      exists: async () => false,
      fetchFn: async () => new Response(new ArrayBuffer(4), { status: 200 }),
      mkdir: async () => {},
    };
    await expect(
      ensureBinary({
        ...baseOpts,
        io,
        checksums: { [FAKE_ARCHIVE]: "00ff00ff00ff00ff" },
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });

  it("uses default onLog noop when not provided", async () => {
    const io: Partial<DownloadIO> = {
      exists: async () => true,
    };
    const result = await ensureBinary({ ...baseOpts, io });
    expect(result).toBe("/tmp/frpc-cache/frp_9.9.9_linux_amd64/frpc");
  });
});
