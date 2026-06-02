import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/client/store.ts";

let counter = 0;
const tmpDirs: string[] = [];

function freshDir(): string {
  const dir = join(tmpdir(), `gini-store-test-${process.pid}-${counter++}-${Date.now()}`);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createStore", () => {
  it("creates the home dir and exposes it", () => {
    const home = freshDir();
    const store = createStore({ home, genId: () => "fixed-id" });
    expect(store.home).toBe(home);
    expect(existsSync(home)).toBe(true);
  });

  it("deviceId() creates device.json on first call and reads it back on second", () => {
    const home = freshDir();
    const store = createStore({ home, genId: () => "fixed-id" });

    // First call: creates the file (genId branch).
    expect(store.deviceId()).toBe("fixed-id");
    const path = join(home, "device.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ device_id: "fixed-id" });

    // Second call: existing branch — even with a different genId, returns stored value.
    const store2 = createStore({ home, genId: () => "other-id" });
    expect(store2.deviceId()).toBe("fixed-id");
  });

  it("readSession() returns null when absent and round-trips after writeSession", () => {
    const home = freshDir();
    const store = createStore({ home, genId: () => "fixed-id" });

    expect(store.readSession()).toBeNull();

    const session = { token: "tok", subdomain: "sub", account: "acct" };
    store.writeSession(session);

    const path = join(home, "session.json");
    expect(existsSync(path)).toBe(true);
    expect(store.readSession()).toEqual(session);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(session);
  });

  it("writeSession works without the optional account field", () => {
    const home = freshDir();
    const store = createStore({ home, genId: () => "fixed-id" });
    const session = { token: "t", subdomain: "s" };
    store.writeSession(session);
    expect(store.readSession()).toEqual(session);
  });

  it("uses GINI_HOME default branch when no home option provided", () => {
    const home = freshDir();
    const prev = process.env.GINI_HOME;
    try {
      process.env.GINI_HOME = home;
      const store = createStore({});
      expect(store.home).toBe(home);
      expect(existsSync(home)).toBe(true);
      expect(store.deviceId()).toBeTruthy(); // exercises randomUUID default genId
    } finally {
      if (prev === undefined) delete process.env.GINI_HOME;
      else process.env.GINI_HOME = prev;
    }
  });

  it("clearSession() removes session.json so readSession() returns null again", () => {
    const home = freshDir();
    const store = createStore({ home, genId: () => "fixed-id" });

    store.writeSession({ token: "tok", subdomain: "sub", account: "acct" });
    const path = join(home, "session.json");
    expect(existsSync(path)).toBe(true);

    store.clearSession();
    expect(existsSync(path)).toBe(false);
    expect(store.readSession()).toBeNull();
  });

  it("clearSession() does not throw when no session exists (force)", () => {
    const home = freshDir();
    const store = createStore({ home, genId: () => "fixed-id" });

    expect(existsSync(join(home, "session.json"))).toBe(false);
    expect(() => store.clearSession()).not.toThrow();
    expect(store.readSession()).toBeNull();
  });

  it("falls back to homedirFn().gini-relay when neither home opt nor GINI_HOME set", () => {
    // Covers the `?? join(resolveHomedir(), ".gini-relay")` default branch via an
    // injected homedirFn, so the real home directory is never touched.
    const fakeHome = freshDir();
    const prevGini = process.env.GINI_HOME;
    try {
      delete process.env.GINI_HOME;
      const store = createStore({ homedirFn: () => fakeHome });
      expect(store.home).toBe(join(fakeHome, ".gini-relay"));
      expect(existsSync(store.home)).toBe(true);
    } finally {
      if (prevGini === undefined) delete process.env.GINI_HOME;
      else process.env.GINI_HOME = prevGini;
    }
  });
});
