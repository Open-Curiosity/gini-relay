/**
 * Helpers that classify frpc log lines. The exact strings come from
 * `client/service.go` and `client/control.go` in fatedier/frp.
 */

/** True once the client has authenticated with the server. */
export function isLoginSuccessLine(line: string): boolean {
  return line.includes("login to server success");
}

/** True when an individual proxy has been established on the server. */
export function isProxyStartLine(line: string): boolean {
  return line.includes("start proxy success");
}

/** True when frpc has reached a usable state (logged in or a proxy is up). */
export function isReadyLine(line: string): boolean {
  return isLoginSuccessLine(line) || isProxyStartLine(line);
}

/** True for lines that indicate a fatal startup failure. */
export function isFatalLine(line: string): boolean {
  return line.includes("login to the server failed") || line.includes("start error");
}
