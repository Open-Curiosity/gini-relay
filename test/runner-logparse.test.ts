import { describe, it, expect } from "bun:test";
import {
  isLoginSuccessLine,
  isProxyStartLine,
  isReadyLine,
  isFatalLine,
} from "../src/client/runner/logparse.ts";

describe("isLoginSuccessLine", () => {
  it("true on a matching line", () => {
    expect(isLoginSuccessLine("[I] login to server success")).toBe(true);
  });
  it("false on a non-matching line", () => {
    expect(isLoginSuccessLine("something else entirely")).toBe(false);
  });
});

describe("isProxyStartLine", () => {
  it("true on a matching line", () => {
    expect(isProxyStartLine("[I] start proxy success")).toBe(true);
  });
  it("false on a non-matching line", () => {
    expect(isProxyStartLine("nope")).toBe(false);
  });
});

describe("isReadyLine", () => {
  it("true via login line", () => {
    expect(isReadyLine("login to server success now")).toBe(true);
  });
  it("true via proxy line", () => {
    expect(isReadyLine("start proxy success now")).toBe(true);
  });
  it("false when neither matches", () => {
    expect(isReadyLine("just a line")).toBe(false);
  });
});

describe("isFatalLine", () => {
  it("true via 'login to the server failed'", () => {
    expect(isFatalLine("[E] login to the server failed: bad token")).toBe(true);
  });
  it("true via 'start error'", () => {
    expect(isFatalLine("[E] start error: port in use")).toBe(true);
  });
  it("false on a non-matching line", () => {
    expect(isFatalLine("all good here")).toBe(false);
  });
});
