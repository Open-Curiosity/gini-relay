import { describe, it, expect } from "bun:test";
import { BANDWIDTH, CAP_BYTES, SUPPORTED_PROXY, parseBw } from "../src/server/bandwidth.ts";

describe("bandwidth constants", () => {
  it("BANDWIDTH is the frp string form", () => {
    expect(BANDWIDTH).toBe("1220KB");
  });

  it("CAP_BYTES is 1220*1024", () => {
    expect(CAP_BYTES).toBe(1220 * 1024);
    expect(CAP_BYTES).toBe(1249280);
  });

  it("SUPPORTED_PROXY has http and not tcp", () => {
    expect(SUPPORTED_PROXY.has("http")).toBe(true);
    expect(SUPPORTED_PROXY.has("tcp")).toBe(false);
  });
});

describe("parseBw", () => {
  it("parses KB", () => {
    expect(parseBw("1220KB")).toBe(1249280);
  });

  it("parses MB", () => {
    expect(parseBw("5MB")).toBe(5 * 1024 * 1024);
  });

  it("parses decimals", () => {
    expect(parseBw("1.5MB")).toBe(Math.round(1.5 * 1024 * 1024));
  });

  it("rejects non-string", () => {
    expect(parseBw(123)).toBeNull();
    expect(parseBw(null)).toBeNull();
    expect(parseBw(undefined)).toBeNull();
    expect(parseBw({})).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseBw("")).toBeNull();
  });

  it("rejects garbage with unit", () => {
    expect(parseBw("garbageMB")).toBeNull();
  });

  it("rejects unsupported unit", () => {
    expect(parseBw("10GB")).toBeNull();
  });

  it("rejects non-positive (0KB)", () => {
    expect(parseBw("0KB")).toBeNull();
  });

  it("rejects negative (regex rejects)", () => {
    expect(parseBw("-5MB")).toBeNull();
  });
});
