/**
 * Supervises a single frpc process: resolves the binary, materializes the JSON
 * config, spawns the client, streams its logs as events, and exposes a clean
 * lifecycle. Built on the injectable {@link SpawnFn}. Derived from the Apache-2.0
 * Bun wrapper for frpc in fatedier/frp.
 */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isReadyLine, isFatalLine } from "./logparse.ts";
import { bunSpawn, streamLines, type SpawnFn, type SpawnedProcess } from "./process.ts";
import { ensureBinary, type EnsureBinaryOptions } from "./download.ts";

/** frpc detects config format by extension; JSON is mapped straight through. */
export const CONFIG_EXTENSION = ".json";

/** Serializes a config object to the JSON text frpc consumes. */
export function serializeConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}

export interface ResolveBinaryDeps {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  ensure?: (opts: EnsureBinaryOptions) => Promise<string>;
  ensureOptions?: EnsureBinaryOptions;
}

/**
 * Resolves the frpc binary: explicit path, then env override, then the
 * checksum-pinned download. There is deliberately NO implicit PATH lookup — a
 * `frpc` on PATH could shadow the verified binary and receive the token-bearing
 * config. Users who want their own binary set binaryPath or FRPC_BIN explicitly.
 */
export async function resolveBinary(deps: ResolveBinaryDeps = {}): Promise<string> {
  if (deps.binaryPath) return deps.binaryPath;
  const env = deps.env ?? process.env;
  if (env.FRPC_BIN) return env.FRPC_BIN;
  const ensure = deps.ensure ?? ensureBinary;
  return ensure(deps.ensureOptions ?? {});
}

export interface FrpcEvents {
  log: [line: string];
  ready: [];
  exit: [code: number];
  error: [error: Error];
}

export interface FrpcOptions {
  config?: Record<string, unknown>;
  configPath?: string;
  binaryPath?: string;
  cwd?: string;
  args?: string[];
  ensure?: EnsureBinaryOptions;
  tmpDir?: string;
  readyTimeoutMs?: number;
  /**
   * How long stop() waits after the first (graceful) signal before escalating
   * to SIGKILL. Overrides the FRPC_KILL_ESCALATION_MS env; defaults to 2000ms.
   */
  killEscalationMs?: number;
  /** Predicate for "ready". Defaults to login-or-proxy; gini pins it to proxy-up. */
  readyWhen?: (line: string) => boolean;

  // Injectable seams (primarily for testing).
  spawnFn?: SpawnFn;
  resolveBinaryFn?: (deps: ResolveBinaryDeps) => Promise<string>;
  writeConfigFn?: (path: string, content: string) => Promise<void>;
  configFilename?: string;
}

// Owner-only write so the config (which carries the bearer session token) is never
// world-readable in the temp dir.
const defaultWriteConfig = async (path: string, content: string): Promise<void> => {
  writeFileSync(path, content, { mode: 0o600 });
};

// How long stop() waits after the first (graceful) signal before escalating to
// SIGKILL. Read at call time so tests can tighten it. Defaults to 2s. A frpc
// that traps/ignores SIGTERM (or a reparented child whose control connection is
// wedged) would otherwise leave stop()'s promise pending forever and orphan the
// process on shutdown.
function killEscalationMs(): number {
  const v = Number(process.env.FRPC_KILL_ESCALATION_MS);
  return Number.isFinite(v) && v > 0 ? v : 2_000;
}

export class Frpc extends EventEmitter<FrpcEvents> {
  private readonly options: FrpcOptions;
  private process: SpawnedProcess | null = null;
  private starting = false;
  private ready = false;
  private configFilePath: string | null = null;
  private ownsConfig = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FrpcOptions = {}) {
    super();
    this.options = options;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get configPath(): string | null {
    return this.configFilePath;
  }

  get exited(): Promise<number> {
    if (!this.process) return Promise.reject(new Error("frpc: not started"));
    return this.process.exited;
  }

  async start(): Promise<this> {
    // Synchronous guard: set `starting` before the first await so a second
    // concurrent start() can't slip past while the binary is resolving.
    if (this.process || this.starting) throw new Error("frpc: already started");
    this.starting = true;

    const o = this.options;
    let binary: string;
    try {
      binary = await (o.resolveBinaryFn ?? resolveBinary)({
        binaryPath: o.binaryPath,
        ensureOptions: o.ensure,
      });
      this.configFilePath = await this.materializeConfig();
    } catch (err) {
      this.starting = false; // let the caller retry after a setup failure
      throw err;
    }

    const cmd = [binary, "-c", this.configFilePath, ...(o.args ?? [])];
    const spawn = o.spawnFn ?? bunSpawn;
    let proc: SpawnedProcess;
    try {
      proc = spawn(cmd, { cwd: o.cwd, stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      // spawn can throw synchronously (e.g. ENOENT): don't wedge `starting` and
      // don't leave the token-bearing temp config on disk.
      this.cleanupConfig();
      this.starting = false;
      throw err;
    }
    this.process = proc;
    this.starting = false;

    const isReady = o.readyWhen ?? isReadyLine;
    const { promise, resolve, reject } = Promise.withResolvers<this>();
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    if (proc.stdout) void this.pump(proc.stdout, isReady, settle, resolve, reject);
    if (proc.stderr) void this.pump(proc.stderr, isReady, settle, resolve, reject);

    void proc.exited.then((code) => {
      this.cleanupConfig();
      this.emit("exit", code);
      settle(() => {
        const err = new Error(`frpc: exited before becoming ready (code ${code})`);
        this.emitError(err);
        reject(err);
      });
    });

    const timeout = o.readyTimeoutMs ?? 0;
    if (timeout > 0) {
      const timer = setTimeout(() => {
        settle(() => {
          this.process?.kill(); // don't orphan the child on a timeout
          this.cleanupConfig(); // remove the session-token config now, before the caller may process.exit
          const err = new Error(`frpc: not ready within ${timeout}ms`);
          this.emitError(err);
          reject(err);
        });
      }, timeout);
      timer.unref();
      const clear = () => clearTimeout(timer);
      promise.then(clear, clear);
    }

    promise.catch(() => {});
    return promise;
  }

  private async pump(
    stream: ReadableStream<Uint8Array>,
    isReady: (line: string) => boolean,
    settle: (fn: () => void) => void,
    resolve: (value: this) => void,
    reject: (err: Error) => void,
  ): Promise<void> {
    for await (const line of streamLines(stream)) {
      this.emit("log", line);
      if (!this.ready && isReady(line)) {
        this.ready = true;
        this.emit("ready");
        settle(() => resolve(this));
      } else if (isFatalLine(line)) {
        settle(() => {
          this.process?.kill(); // don't orphan the child on a fatal log line
          this.cleanupConfig(); // remove the session-token config now, before the caller may process.exit
          const err = new Error(`frpc: ${line}`);
          this.emitError(err);
          reject(err);
        });
      }
    }
  }

  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  // Best-effort removal of a config WE created (not a caller-supplied path).
  private cleanupConfig(): void {
    if (this.ownsConfig && this.configFilePath) {
      rmSync(this.configFilePath, { force: true });
      this.ownsConfig = false;
    }
  }

  private async materializeConfig(): Promise<string> {
    const o = this.options;
    if (o.configPath) return o.configPath;
    if (!o.config) throw new Error("frpc: either `config` or `configPath` must be provided");
    const dir = o.tmpDir ?? tmpdir();
    // Per-instance unique name so two Frpc instances in one process never collide.
    const name = o.configFilename ?? `frpc-${process.pid}-${randomUUID()}${CONFIG_EXTENSION}`;
    const path = join(dir, name);
    const write = o.writeConfigFn ?? defaultWriteConfig;
    await write(path, serializeConfig(o.config));
    this.ownsConfig = true;
    return path;
  }

  // Stop the child. Sends `signal` (default SIGTERM) and, if the child hasn't
  // exited within the escalation window, force-kills it with SIGKILL — so a frpc
  // that traps/ignores the graceful signal can't leave this promise pending
  // forever (which would orphan the child and stall a caller's shutdown drain).
  // Resolves the child's exit code. A repeat stop() re-sends the signal but does
  // not stack a second escalation timer.
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
    if (!this.process) throw new Error("frpc: not started");
    // Capture the process locally so the escalation timer never targets a
    // different/reassigned process if `this.process` changes.
    const proc = this.process;
    proc.kill(signal);
    if (this.killTimer === undefined) {
      const delay = this.options.killEscalationMs ?? killEscalationMs();
      this.killTimer = setTimeout(() => proc.kill(9), delay);
      // Don't keep the event loop alive just to force-kill (mirrors the
      // readiness timer in start()).
      this.killTimer.unref();
      // The moment the process exits (graceful or after the SIGKILL), clear the
      // timer so a force-kill never fires at a dead — possibly pid-reused —
      // process. Clear on both settle paths so a rejected `exited` can't leak it.
      const clear = (): void => {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      };
      void proc.exited.then(clear, clear);
    }
    return proc.exited;
  }
}

/** Convenience: construct, start, and return a running {@link Frpc}. */
export async function runFrpc(options: FrpcOptions = {}): Promise<Frpc> {
  const client = new Frpc(options);
  await client.start();
  return client;
}
