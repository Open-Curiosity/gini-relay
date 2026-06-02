import { describe, it, expect } from "bun:test";
import { bunSpawn, streamLines } from "../src/client/runner/process.ts";

function streamFromChunks(chunks: (Uint8Array | string)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        const c = chunks[i++];
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      } else {
        controller.close();
      }
    },
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of gen) out.push(line);
  return out;
}

describe("streamLines", () => {
  it("yields lines, strips CR, and yields trailing partial", async () => {
    const stream = streamFromChunks(["a\nb\r\n", "tail-no-newline"]);
    const lines = await collect(streamLines(stream));
    expect(lines).toEqual(["a", "b", "tail-no-newline"]);
  });

  it("handles multi-byte UTF-8 split across chunks", async () => {
    // "é" is 0xC3 0xA9 in UTF-8; split it across two chunks.
    const stream = streamFromChunks([
      new Uint8Array([0xc3]),
      new Uint8Array([0xa9, 0x0a]), // second byte + "\n"
    ]);
    const lines = await collect(streamLines(stream));
    expect(lines).toEqual(["é"]);
  });

  it("yields nothing for an empty stream", async () => {
    const stream = streamFromChunks([]);
    const lines = await collect(streamLines(stream));
    expect(lines).toEqual([]);
  });

  it("handles multiple newlines in a single chunk", async () => {
    const stream = streamFromChunks(["x\ny\nz\n"]);
    const lines = await collect(streamLines(stream));
    expect(lines).toEqual(["x", "y", "z"]);
  });
});

describe("bunSpawn", () => {
  it("spawns a process, exposes pid, streams stdout, and exits 0", async () => {
    const proc = bunSpawn(["sh", "-c", "printf hi"], { stdout: "pipe" });
    expect(typeof proc.pid).toBe("number");
    expect(proc.stdout).toBeInstanceOf(ReadableStream);
    const lines = await collect(streamLines(proc.stdout!));
    expect(lines).toEqual(["hi"]);
    expect(await proc.exited).toBe(0);
  });

  it("captures stderr when piped", async () => {
    const proc = bunSpawn(["sh", "-c", "printf err 1>&2"], { stderr: "pipe" });
    expect(proc.stderr).toBeInstanceOf(ReadableStream);
    const lines = await collect(streamLines(proc.stderr!));
    expect(lines).toEqual(["err"]);
    await proc.exited;
  });

  it("returns null stdout/stderr when ignored", async () => {
    const proc = bunSpawn(["sh", "-c", "true"], { stdout: "ignore", stderr: "ignore" });
    expect(proc.stdout).toBeNull();
    expect(proc.stderr).toBeNull();
    await proc.exited;
  });

  it("respects cwd and defaults (no options)", async () => {
    const proc = bunSpawn(["sh", "-c", "pwd"]);
    const lines = await collect(streamLines(proc.stdout!));
    expect(lines.length).toBe(1);
    await proc.exited;
  });

  it("uses provided cwd", async () => {
    const proc = bunSpawn(["sh", "-c", "pwd"], { cwd: "/tmp", stdout: "pipe" });
    const lines = await collect(streamLines(proc.stdout!));
    // macOS /tmp resolves to /private/tmp; just assert it ends with /tmp.
    expect(lines[0]!.endsWith("/tmp")).toBe(true);
    await proc.exited;
  });

  it("kill terminates a long-running process", async () => {
    const proc = bunSpawn(["sleep", "5"]);
    expect(typeof proc.pid).toBe("number");
    proc.kill();
    const code = await proc.exited;
    expect(typeof code).toBe("number");
  });

  it("kill accepts an explicit signal", async () => {
    const proc = bunSpawn(["sleep", "5"]);
    proc.kill(9);
    const code = await proc.exited;
    expect(typeof code).toBe("number");
  });
});
