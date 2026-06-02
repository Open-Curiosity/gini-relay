/**
 * Thin abstraction over Bun's process spawning. Everything the runner needs from
 * a child process is captured by {@link SpawnedProcess}, and spawning itself goes
 * through {@link SpawnFn} so callers and tests can inject a fake.
 *
 * Derived from the Apache-2.0 Bun wrapper for frpc in fatedier/frp.
 */

export interface SpawnedProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface SpawnOptions {
  cwd?: string;
  /** "pipe" exposes the stream; "inherit" forwards to the parent's stdio. */
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
}

export type SpawnFn = (cmd: string[], options?: SpawnOptions) => SpawnedProcess;

/** Default spawner backed by `Bun.spawn`. */
export const bunSpawn: SpawnFn = (cmd, options = {}) => {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    stdin: "ignore",
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
  });
  return {
    pid: proc.pid,
    stdout: proc.stdout instanceof ReadableStream ? proc.stdout : null,
    stderr: proc.stderr instanceof ReadableStream ? proc.stderr : null,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal as number),
  };
};

/**
 * Yields complete lines from a byte stream, decoding incrementally and stripping
 * a trailing carriage return so Windows output is normalized. Uses
 * TextDecoderStream so multi-byte UTF-8 split across chunks is handled correctly.
 */
export async function* streamLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream.pipeThrough(
    new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>,
  )) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      yield stripCR(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer.length > 0) {
    yield stripCR(buffer);
  }
}

function stripCR(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
