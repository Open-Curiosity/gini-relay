import { describe, it, expect, mock } from "bun:test";
import { startLoopback, openBrowser } from "../src/client/loopback.ts";
import type { SpawnFn, SpawnedProcess } from "../src/client/runner/process.ts";

/** Probe a free port by binding :0, reading the assigned port, then stopping. */
function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
  const p = s.port!;
  s.stop(true);
  return p;
}

const fakeProc: SpawnedProcess = {
  pid: 1,
  stdout: null,
  stderr: null,
  exited: Promise.resolve(0),
  kill: () => {},
};

describe("startLoopback", () => {
  it("returns null when no ports are provided", () => {
    expect(startLoopback([], "st")).toBeNull();
  });

  it("binds a free port, resolves the code on a valid /cb callback", async () => {
    const port = freePort();
    const lb = startLoopback([port], "st");
    expect(lb).not.toBeNull();
    expect(lb!.redirectUri).toBe(`http://127.0.0.1:${port}/cb`);

    const res = await fetch(`http://127.0.0.1:${port}/cb?code=abc&state=st`);
    const body = await res.text();
    expect(body).toContain("Logged in");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await lb!.code).toBe("abc");
    lb!.stop();
  });

  it("rejects on bad state -> code null + Login failed", async () => {
    const port = freePort();
    const lb = startLoopback([port], "st");
    const res = await fetch(`http://127.0.0.1:${port}/cb?code=abc&state=WRONG`);
    const body = await res.text();
    expect(body).toContain("Login failed");
    expect(await lb!.code).toBeNull();
    lb!.stop();
  });

  it("rejects when code is missing -> null", async () => {
    const port = freePort();
    const lb = startLoopback([port], "st");
    const res = await fetch(`http://127.0.0.1:${port}/cb?state=st`);
    const body = await res.text();
    expect(body).toContain("Login failed");
    expect(await lb!.code).toBeNull();
    lb!.stop();
  });

  it("returns 404 for non-/cb paths", async () => {
    const port = freePort();
    const lb = startLoopback([port], "st");
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
    lb!.stop();
  });

  it("skips a busy port (catch) and binds the next free one", async () => {
    const busyPort = freePort();
    const occupier = Bun.serve({ port: busyPort, hostname: "127.0.0.1", fetch: () => new Response("busy") });
    const free = freePort();
    const lb = startLoopback([busyPort, free], "st");
    expect(lb).not.toBeNull();
    expect(lb!.redirectUri).toBe(`http://127.0.0.1:${free}/cb`);
    lb!.stop();
    occupier.stop(true);
  });
});

describe("openBrowser", () => {
  it("invokes the spawnFn with ['open', url]", () => {
    const spawnFn = mock<SpawnFn>(() => fakeProc);
    openBrowser("https://example.com", spawnFn);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0]![0]).toEqual(["open", "https://example.com"]);
    expect(spawnFn.mock.calls[0]![1]).toEqual({ stdout: "ignore", stderr: "ignore" });
  });

  it("swallows errors when the spawnFn throws (catch path)", () => {
    const throwing: SpawnFn = () => {
      throw new Error("no browser");
    };
    expect(() => openBrowser("https://example.com", throwing)).not.toThrow();
  });
});
