// workspaces-o9o.78: the daemon's terminal-token decision (domain/terminal-token-policy.ts), as index.ts takes it at startup.
import { describe, expect, it } from "vitest";
import { decideTerminalToken } from "../src/domain/terminal-token-policy.js";

const TOKEN = "t-" + "0".repeat(8);
const OPERATOR = "op-" + "1".repeat(8);

describe("the terminal token the daemon requires (characterization: unchanged by the extraction)", () => {
  it("the environment's token wins", () => {
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1"], envToken: TOKEN, operatorToken: OPERATOR, explicitUntrusted: true })).toBe(TOKEN);
  });
  it("an explicit untrusted bind (LAN, 0.0.0.0) with no terminal token uses the operator token", () => {
    expect(decideTerminalToken({ bindHosts: ["0.0.0.0"], operatorToken: OPERATOR, explicitUntrusted: true })).toBe(OPERATOR);
  });
  it("loopback only needs no token", () => {
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1"], operatorToken: null, explicitUntrusted: false })).toBeNull();
  });
});

// workspaces-o9o.78 (Jim, 2026-11-17: "Token when non-loopback"): terminal-class routes require the terminal token whenever the daemon
// listens beyond loopback (the tailnet included); loopback-only stays tokenless. With no OPENRIG_TERMINAL_BEARER_TOKEN, the daemon takes
// <OPENRIG_HOME>/terminal-token (made when absent), which the same host's CLI already sends.
describe("a daemon that listens beyond loopback requires the terminal token", () => {
  const FILE_TOKEN = "f-" + "2".repeat(8);
  const fromFile = () => FILE_TOKEN;

  it("the default bind with the tailnet (loopback + the tailscale address) requires a token: the file's", () => {
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1", "100.64.10.20"], operatorToken: null, explicitUntrusted: false, readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("an explicit tailnet bind requires a token: the file's", () => {
    expect(decideTerminalToken({ bindHosts: ["100.64.10.20"], operatorToken: null, explicitUntrusted: false, readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("a hostname is not known to be loopback, so it requires a token", () => {
    expect(decideTerminalToken({ bindHosts: ["sparky.lan"], operatorToken: null, explicitUntrusted: false, readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("loopback only (127/8, ::1, localhost) stays tokenless and never makes the file", () => {
    let made = 0;
    const counted = () => { made++; return FILE_TOKEN; };
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1", "::1", "localhost", "127.0.0.2"], operatorToken: null, explicitUntrusted: false, readOrCreateFile: counted })).toBeNull();
    expect(made).toBe(0);
  });

  it("the environment's token still wins over the file, and the operator token on an explicit untrusted bind", () => {
    expect(decideTerminalToken({ bindHosts: ["100.64.10.20"], envToken: TOKEN, operatorToken: null, explicitUntrusted: false, readOrCreateFile: fromFile })).toBe(TOKEN);
    expect(decideTerminalToken({ bindHosts: ["0.0.0.0"], operatorToken: OPERATOR, explicitUntrusted: true, readOrCreateFile: fromFile })).toBe(OPERATOR);
  });
});
