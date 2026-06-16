import { describe, it, expect, afterEach } from "bun:test";
import {
  CONFIG_EXTENSION,
  serializeConfig,
  resolveBinary,
  Frpc,
  runFrpc,
} from "../src/client/runner/supervisor.ts";
import type { SpawnedProcess, SpawnFn } from "../src/client/runner/process.ts";

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> that emits the given lines (newline-terminated). */
function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line + "\n"));
      controller.close();
    },
  });
}

/** A stream that emits nothing and never closes — keeps pump pending. */
function pendingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      /* never enqueue, never close */
    },
  });
}

interface FakeProcOpts {
  pid?: number;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited?: Promise<number>;
}

function fakeProc(opts: FakeProcOpts = {}): {
  proc: SpawnedProcess;
  killed: { signal?: number | NodeJS.Signals; called: boolean };
  resolveExit: (code: number) => void;
} {
  const killed: { signal?: number | NodeJS.Signals; called: boolean } = { called: false };
  let resolveExit!: (code: number) => void;
  const exited =
    opts.exited ??
    new Promise<number>((res) => {
      resolveExit = res;
    });
  const proc: SpawnedProcess = {
    pid: opts.pid ?? 4242,
    stdout: opts.stdout === undefined ? null : opts.stdout,
    stderr: opts.stderr === undefined ? null : opts.stderr,
    exited,
    kill: (signal) => {
      killed.called = true;
      killed.signal = signal;
      resolveExit?.(0);
    },
  };
  return { proc, killed, resolveExit };
}

// ---------------------------------------------------------------------------
// serializeConfig + CONFIG_EXTENSION
// ---------------------------------------------------------------------------

describe("serializeConfig / CONFIG_EXTENSION", () => {
  it("serializes a config to pretty JSON", () => {
    expect(serializeConfig({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
  it("exposes the .json extension", () => {
    expect(CONFIG_EXTENSION).toBe(".json");
  });
});

// ---------------------------------------------------------------------------
// resolveBinary
// ---------------------------------------------------------------------------

describe("resolveBinary", () => {
  it("returns an explicit binaryPath", async () => {
    expect(await resolveBinary({ binaryPath: "/bin/frpc" })).toBe("/bin/frpc");
  });

  it("returns env.FRPC_BIN when no binaryPath", async () => {
    expect(await resolveBinary({ env: { FRPC_BIN: "/env/frpc" } })).toBe("/env/frpc");
  });

  it("falls back to ensure() when no binaryPath and FRPC_BIN is unset", async () => {
    let opts: unknown;
    const out = await resolveBinary({
      env: {}, // FRPC_BIN undefined
      ensure: async (o) => {
        opts = o;
        return "/downloaded/frpc";
      },
      ensureOptions: { version: "x" } as never,
    });
    expect(out).toBe("/downloaded/frpc");
    expect(opts).toEqual({ version: "x" });
  });

  it("passes empty ensureOptions when none provided", async () => {
    let opts: unknown;
    const out = await resolveBinary({
      env: {},
      ensure: async (o) => {
        opts = o;
        return "/e/frpc";
      },
    });
    expect(out).toBe("/e/frpc");
    expect(opts).toEqual({});
  });

  it("uses the default env (process.env) when no env is provided", async () => {
    // No env override -> exercises the `deps.env ?? process.env` fallback line.
    // Explicitly clear FRPC_BIN (restoring after) so the result is deterministic
    // regardless of the ambient environment, then inject ensure to avoid network.
    const prev = process.env.FRPC_BIN;
    delete process.env.FRPC_BIN;
    try {
      let ensured = false;
      const out = await resolveBinary({
        ensure: async () => {
          ensured = true;
          return "/downloaded/frpc";
        },
      });
      expect(out).toBe("/downloaded/frpc");
      expect(ensured).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FRPC_BIN;
      else process.env.FRPC_BIN = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Frpc lifecycle
// ---------------------------------------------------------------------------

describe("Frpc.start ready paths", () => {
  it("resolves on a ready line; fires ready/log; getters reflect state", async () => {
    const { proc } = fakeProc({
      pid: 99,
      stdout: streamOf(["booting", "login to server success"]),
    });
    const logs: string[] = [];
    let readyFired = false;
    const cmds: string[][] = [];
    const spawnFn: SpawnFn = (cmd) => {
      cmds.push(cmd);
      return proc;
    };
    const frpc = new Frpc({
      config: { foo: "bar" },
      resolveBinaryFn: async () => "/bin/frpc",
      writeConfigFn: async () => {},
      spawnFn,
      tmpDir: "/tmp/x",
      configFilename: "cfg.json",
      args: ["--extra"],
    });
    frpc.on("log", (l) => logs.push(l));
    frpc.on("ready", () => {
      readyFired = true;
    });

    expect(frpc.isReady).toBe(false);
    expect(frpc.pid).toBeNull();
    expect(frpc.configPath).toBeNull();

    const result = await frpc.start();
    expect(result).toBe(frpc);
    expect(frpc.isReady).toBe(true);
    expect(frpc.pid).toBe(99);
    expect(frpc.configPath).toBe("/tmp/x/cfg.json");
    expect(readyFired).toBe(true);
    expect(logs).toContain("login to server success");
    expect(cmds[0]).toEqual(["/bin/frpc", "-c", "/tmp/x/cfg.json", "--extra"]);

    // exited getter returns the process's exited promise after start
    expect(frpc.exited).toBeInstanceOf(Promise);
  });

  it("throws when started twice", async () => {
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/cfg.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    await frpc.start();
    await expect(frpc.start()).rejects.toThrow("frpc: already started");
  });

  it("uses default args ([]) when none provided", async () => {
    const cmds: string[][] = [];
    const { proc } = fakeProc({ stdout: streamOf(["start proxy success"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: (cmd) => {
        cmds.push(cmd);
        return proc;
      },
    });
    await frpc.start();
    expect(cmds[0]).toEqual(["/bin/frpc", "-c", "/c.json"]);
  });

  it("resolves when a custom readyWhen predicate matches a line", async () => {
    const { proc } = fakeProc({
      stdout: streamOf(["nothing useful", "GINI READY MARKER"]),
    });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      readyWhen: (line) => line.includes("GINI READY MARKER"),
    });
    await frpc.start();
    expect(frpc.isReady).toBe(true);
  });

  it("throws 'already started' on two concurrent (un-awaited) start() calls", async () => {
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    // Do NOT await the first call: the synchronous `starting` sentinel must
    // make the second call throw before the first resolves.
    const first = frpc.start();
    expect(() => frpc.start()).toThrow("frpc: already started");
    await first;
  });

  it("resets `starting` after resolveBinaryFn rejects, allowing a retry", async () => {
    let calls = 0;
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      spawnFn: () => proc,
      resolveBinaryFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom: resolve failed");
        return "/bin/frpc";
      },
    });
    await expect(frpc.start()).rejects.toThrow("boom: resolve failed");
    // The catch block reset `starting`, so a fresh start() on the SAME instance proceeds.
    await frpc.start();
    expect(frpc.isReady).toBe(true);
  });

  it("reads from stderr stream too", async () => {
    const { proc } = fakeProc({
      stdout: null,
      stderr: streamOf(["login to server success"]),
    });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    await frpc.start();
    expect(frpc.isReady).toBe(true);
  });
});

describe("Frpc.start failure paths", () => {
  // Temp config paths created by the spawn-throw test; cleaned up defensively.
  const spawnThrowPaths: string[] = [];
  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    for (const p of spawnThrowPaths.splice(0)) rmSync(p, { force: true });
  });

  it("rejects on a fatal line, kills the child, and emits error when listener attached", async () => {
    const { proc, killed } = fakeProc({ stdout: streamOf(["login to the server failed: nope"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    let errMsg = "";
    frpc.on("error", (e) => {
      errMsg = e.message;
    });
    await expect(frpc.start()).rejects.toThrow(/frpc: login to the server failed/);
    expect(errMsg).toMatch(/login to the server failed/);
    // The child is killed before rejecting so it isn't orphaned.
    expect(killed.called).toBe(true);
  });

  it("rejects on exit-before-ready without an error listener (emitError no-op branch)", async () => {
    // exited resolves immediately; no stdout/stderr streams.
    const { proc } = fakeProc({ exited: Promise.resolve(7) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    const exitCodes: number[] = [];
    frpc.on("exit", (c) => exitCodes.push(c));
    await expect(frpc.start()).rejects.toThrow("frpc: exited before becoming ready (code 7)");
    expect(exitCodes).toEqual([7]);
  });

  it("rejects when readyTimeoutMs elapses and kills the child", async () => {
    const killed: { signal?: number | NodeJS.Signals; called: boolean } = { called: false };
    const proc: SpawnedProcess = {
      pid: 1,
      stdout: pendingStream(),
      stderr: null,
      exited: new Promise<number>(() => {}), // never resolves
      kill: (signal) => {
        killed.called = true;
        killed.signal = signal;
      },
    };
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      readyTimeoutMs: 20,
    });
    await expect(frpc.start()).rejects.toThrow("frpc: not ready within 20ms");
    expect(killed.called).toBe(true);
  });

  it("clears the timeout timer on successful ready", async () => {
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      readyTimeoutMs: 5000,
    });
    await frpc.start();
    expect(frpc.isReady).toBe(true);
  });

  it("rejects and resets `starting` when spawnFn throws synchronously", async () => {
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => {
        throw new Error("spawn boom: ENOENT");
      },
    });
    await expect(frpc.start()).rejects.toThrow("spawn boom: ENOENT");
    // The catch block reset `starting`, so a fresh start() on the SAME instance
    // proceeds (no "already started"). Swap in a good spawn for the retry.
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    (frpc as any).options.spawnFn = () => proc;
    await frpc.start();
    expect(frpc.isReady).toBe(true);
  });

  it("removes the owned temp config when spawnFn throws (cleanupConfig in catch)", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const fname = `frpc-spawnthrow-${process.pid}-${Date.now()}.json`;
    const path = join(tmpdir(), fname);
    spawnThrowPaths.push(path);

    const frpc = new Frpc({
      config: { secret: "gsk_test" },
      resolveBinaryFn: async () => "/bin/frpc",
      // REAL default writeConfig (no writeConfigFn) so the file is actually created.
      tmpDir: tmpdir(),
      configFilename: fname,
      spawnFn: () => {
        throw new Error("spawn boom");
      },
    });
    expect(existsSync(path)).toBe(false);
    await expect(frpc.start()).rejects.toThrow("spawn boom");
    // cleanupConfig in the catch removed the session-token-bearing temp config.
    expect(existsSync(path)).toBe(false);
  });
});

describe("Frpc materializeConfig", () => {
  it("returns configPath verbatim when provided", async () => {
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/explicit/cfg.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    await frpc.start();
    expect(frpc.configPath).toBe("/explicit/cfg.json");
  });

  it("writes config via injected writeConfigFn using default filename + tmpdir", async () => {
    let written: { path: string; content: string } | null = null;
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      config: { hello: "world" },
      resolveBinaryFn: async () => "/bin/frpc",
      writeConfigFn: async (path, content) => {
        written = { path, content };
      },
      spawnFn: () => proc,
    });
    await frpc.start();
    expect(written).not.toBeNull();
    // Default filename is now UUID-unique: frpc-<pid>-<uuid>.json
    expect(written!.path).toMatch(/frpc-\d+-[0-9a-f-]+\.json$/);
    expect(written!.content).toBe(serializeConfig({ hello: "world" }));
    expect(frpc.configPath).toBe(written!.path);
  });

  it("throws when neither config nor configPath provided", async () => {
    const frpc = new Frpc({
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => fakeProc().proc,
    });
    await expect(frpc.start()).rejects.toThrow(
      "frpc: either `config` or `configPath` must be provided",
    );
  });

  it("uses the default writeConfig (node:fs writeFileSync, mode 0600) when not injected", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdirSync, readFileSync, statSync, rmSync } = await import("node:fs");
    const dir = join(tmpdir(), `frpc-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fname = `cfg-${Date.now()}.json`;
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      config: { real: true },
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      tmpDir: dir,
      configFilename: fname,
      // no writeConfigFn -> exercises defaultWriteConfig
    });
    await frpc.start();
    const path = join(dir, fname);
    expect(readFileSync(path, "utf8")).toBe(serializeConfig({ real: true }));
    // Owner-only permissions so the session-token-bearing config isn't world-readable.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Frpc.exited getter / stop", () => {
  it("rejects exited before start", async () => {
    const frpc = new Frpc({ configPath: "/c.json" });
    await expect(frpc.exited).rejects.toThrow("frpc: not started");
  });

  it("stop() before start throws", async () => {
    const frpc = new Frpc({ configPath: "/c.json" });
    await expect(frpc.stop()).rejects.toThrow("frpc: not started");
  });

  it("stop() after start kills with default signal and resolves exit code", async () => {
    const { proc, killed } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    await frpc.start();
    const code = await frpc.stop();
    expect(killed.signal).toBe("SIGTERM");
    expect(code).toBe(0);
  });

  it("stop() forwards a custom signal", async () => {
    const { proc, killed } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    await frpc.start();
    await frpc.stop("SIGKILL");
    expect(killed.signal).toBe("SIGKILL");
  });

  // A process whose `exited` only resolves when the test calls resolveExit, and
  // whose kill() records every signal WITHOUT resolving exited — so it models a
  // child that ignores SIGTERM. resolveExit lets the test settle it on demand
  // (e.g. once the SIGKILL "lands").
  function ignoresSigtermProc(): {
    proc: SpawnedProcess;
    signals: (number | NodeJS.Signals | undefined)[];
    resolveExit: (code: number) => void;
  } {
    const signals: (number | NodeJS.Signals | undefined)[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((res) => {
      resolveExit = res;
    });
    const proc: SpawnedProcess = {
      pid: 99,
      stdout: streamOf(["login to server success"]),
      stderr: null,
      exited,
      kill: (signal) => {
        signals.push(signal);
      },
    };
    return { proc, signals, resolveExit };
  }

  it("stop() escalates to SIGKILL when the child ignores the graceful signal", async () => {
    const { proc, signals, resolveExit } = ignoresSigtermProc();
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      killEscalationMs: 5,
    });
    await frpc.start();
    const stopped = frpc.stop();
    // Poll for the escalation rather than sleeping a fixed time.
    for (let i = 0; i < 600 && !signals.includes(9); i += 1) await Bun.sleep(2);
    expect(signals).toEqual(["SIGTERM", 9]);
    // The SIGKILL "takes": resolve exited so stop() settles with the code.
    resolveExit(137);
    expect(await stopped).toBe(137);
  });

  it("stop() does not stack a second escalation timer when called twice", async () => {
    const { proc, signals, resolveExit } = ignoresSigtermProc();
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      killEscalationMs: 5,
    });
    await frpc.start();
    const first = frpc.stop();
    const second = frpc.stop(); // re-sends the graceful signal, no new timer
    // Two graceful signals (one per call), then exactly ONE SIGKILL from the
    // single escalation timer.
    for (let i = 0; i < 600 && !signals.includes(9); i += 1) await Bun.sleep(2);
    // Give any erroneously-stacked second timer the same window to also fire.
    await Bun.sleep(20);
    expect(signals.filter((s) => s === 9)).toHaveLength(1);
    expect(signals.filter((s) => s === "SIGTERM")).toHaveLength(2);
    resolveExit(0);
    await Promise.all([first, second]);
  });

  it("stop() clears the escalation timer when the process exits before the delay", async () => {
    const { proc, signals, resolveExit } = ignoresSigtermProc();
    const frpc = new Frpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      killEscalationMs: 10_000, // long: the exit must clear it well before it fires
    });
    await frpc.start();
    const stopped = frpc.stop();
    resolveExit(0); // graceful exit beats the escalation window
    expect(await stopped).toBe(0);
    // Give the (now-cleared) timer ample time to fire if it leaked — it must not.
    await Bun.sleep(30);
    expect(signals).toEqual(["SIGTERM"]); // no SIGKILL ever sent
  });

  it("stop() falls back to the FRPC_KILL_ESCALATION_MS env when no option is set", async () => {
    const prev = process.env.FRPC_KILL_ESCALATION_MS;
    process.env.FRPC_KILL_ESCALATION_MS = "5";
    try {
      const { proc, signals, resolveExit } = ignoresSigtermProc();
      const frpc = new Frpc({
        configPath: "/c.json",
        resolveBinaryFn: async () => "/bin/frpc",
        spawnFn: () => proc,
      });
      await frpc.start();
      const stopped = frpc.stop();
      for (let i = 0; i < 600 && !signals.includes(9); i += 1) await Bun.sleep(2);
      expect(signals).toEqual(["SIGTERM", 9]);
      resolveExit(137);
      expect(await stopped).toBe(137);
    } finally {
      if (prev === undefined) delete process.env.FRPC_KILL_ESCALATION_MS;
      else process.env.FRPC_KILL_ESCALATION_MS = prev;
    }
  });

  it("stop() uses the 2s default when FRPC_KILL_ESCALATION_MS is invalid", async () => {
    const prev = process.env.FRPC_KILL_ESCALATION_MS;
    process.env.FRPC_KILL_ESCALATION_MS = "not-a-number"; // hits the !isFinite default branch
    try {
      const { proc, signals, resolveExit } = ignoresSigtermProc();
      const frpc = new Frpc({
        configPath: "/c.json",
        resolveBinaryFn: async () => "/bin/frpc",
        spawnFn: () => proc,
      });
      await frpc.start();
      const stopped = frpc.stop();
      // The default is 2000ms — far longer than this test should wait. Resolve
      // the exit immediately so the (created, unref'd) default timer is cleared
      // before it fires; we only need to prove the default-path code ran.
      resolveExit(0);
      expect(await stopped).toBe(0);
      await Bun.sleep(20);
      expect(signals).toEqual(["SIGTERM"]); // 2s SIGKILL never fired
    } finally {
      if (prev === undefined) delete process.env.FRPC_KILL_ESCALATION_MS;
      else process.env.FRPC_KILL_ESCALATION_MS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// cleanupConfig on exit
// ---------------------------------------------------------------------------

describe("Frpc cleanupConfig on exit", () => {
  it("removes a config WE created (ownsConfig) when the process exits", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdirSync, existsSync, rmSync } = await import("node:fs");
    const dir = join(tmpdir(), `frpc-cleanup-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fname = `owned-${Date.now()}.json`;
    const path = join(dir, fname);

    // Controllable exit: stays pending so start() settles on the ready line first,
    // then we trigger the exit and assert the owned config is cleaned up.
    const { proc, resolveExit } = fakeProc({
      stdout: streamOf(["login to server success"]),
    });
    const frpc = new Frpc({
      config: { owned: true },
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
      tmpDir: dir,
      configFilename: fname,
      // no writeConfigFn -> real defaultWriteConfig writes the file
    });
    await frpc.start();
    expect(existsSync(path)).toBe(true);
    resolveExit(0);
    await frpc.exited;
    expect(existsSync(path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a caller-supplied configPath intact when the process exits", async () => {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const dir = join(tmpdir(), `frpc-keep-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "caller.json");
    writeFileSync(path, "{}");

    const { proc, resolveExit } = fakeProc({
      stdout: streamOf(["login to server success"]),
    });
    const frpc = new Frpc({
      configPath: path,
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    await frpc.start();
    resolveExit(0);
    await frpc.exited;
    // ownsConfig is false for a caller-supplied path: the file survives.
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runFrpc convenience
// ---------------------------------------------------------------------------

describe("runFrpc", () => {
  it("constructs, starts, and returns a running Frpc", async () => {
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    const client = await runFrpc({
      configPath: "/c.json",
      resolveBinaryFn: async () => "/bin/frpc",
      spawnFn: () => proc,
    });
    expect(client).toBeInstanceOf(Frpc);
    expect(client.isReady).toBe(true);
  });

  it("runs with default options object", async () => {
    const { proc } = fakeProc({ stdout: streamOf(["login to server success"]) });
    // default param branch of runFrpc + Frpc constructor default
    const client = await runFrpc({
      config: { a: 1 },
      resolveBinaryFn: async () => "/bin/frpc",
      writeConfigFn: async () => {},
      spawnFn: () => proc,
    });
    expect(client.isReady).toBe(true);
  });
});
