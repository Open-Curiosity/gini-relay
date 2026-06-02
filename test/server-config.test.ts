import { describe, it, expect } from "bun:test";
import { loadServerConfig, assertStartable } from "../src/server/config.ts";

describe("loadServerConfig", () => {
  it("applies defaults for an empty env", () => {
    const cfg = loadServerConfig({});
    expect(cfg.port).toBe(9100);
    expect(cfg.dbPath).toBe("/tmp/gini-relay.db");
    expect(cfg.publicUrl).toBe("http://localhost:9100");
    expect(cfg.googleId).toBe("");
    expect(cfg.googleSecret).toBe("");
    expect(cfg.googleLive).toBe(false);
    expect(cfg.allowStub).toBe(false);
  });

  it("overrides every var", () => {
    const cfg = loadServerConfig({
      GINI_PLUGIN_PORT: "1234",
      GINI_DB: "/data/x.db",
      GINI_PUBLIC_URL: "https://relay.example",
      GINI_GOOGLE_CLIENT_ID: "  id  ",
      GINI_GOOGLE_CLIENT_SECRET: "  sec  ",
      GINI_ALLOW_STUB: "1",
    });
    expect(cfg.port).toBe(1234);
    expect(cfg.dbPath).toBe("/data/x.db");
    expect(cfg.publicUrl).toBe("https://relay.example");
    expect(cfg.googleId).toBe("id");
    expect(cfg.googleSecret).toBe("sec");
    expect(cfg.googleLive).toBe(true);
    expect(cfg.allowStub).toBe(true);
  });

  it("derives publicUrl from an overridden port", () => {
    const cfg = loadServerConfig({ GINI_PLUGIN_PORT: "8080" });
    expect(cfg.port).toBe(8080);
    expect(cfg.publicUrl).toBe("http://localhost:8080");
  });

  it("is not googleLive when only the id is set", () => {
    const cfg = loadServerConfig({ GINI_GOOGLE_CLIENT_ID: "id" });
    expect(cfg.googleLive).toBe(false);
  });

  it("is not googleLive when only the secret is set", () => {
    const cfg = loadServerConfig({ GINI_GOOGLE_CLIENT_SECRET: "sec" });
    expect(cfg.googleLive).toBe(false);
  });

  it("treats non-1 GINI_ALLOW_STUB as false", () => {
    expect(loadServerConfig({ GINI_ALLOW_STUB: "0" }).allowStub).toBe(false);
    expect(loadServerConfig({ GINI_ALLOW_STUB: "true" }).allowStub).toBe(false);
  });

  it("trims GINI_ALLOW_STUB before comparing", () => {
    expect(loadServerConfig({ GINI_ALLOW_STUB: "  1  " }).allowStub).toBe(true);
  });

  it("uses process.env by default", () => {
    const cfg = loadServerConfig();
    expect(typeof cfg.port).toBe("number");
  });
});

describe("assertStartable", () => {
  const base = loadServerConfig({});

  it("throws when not googleLive and not allowStub", () => {
    expect(() =>
      assertStartable({ ...base, googleLive: false, allowStub: false }),
    ).toThrow(/refusing to start in open stub auth mode/);
  });

  it("passes with googleLive", () => {
    expect(() =>
      assertStartable({ ...base, googleLive: true, allowStub: false }),
    ).not.toThrow();
  });

  it("passes with allowStub", () => {
    expect(() =>
      assertStartable({ ...base, googleLive: false, allowStub: true }),
    ).not.toThrow();
  });
});
