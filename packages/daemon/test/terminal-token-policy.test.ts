// workspaces-o9o.78: the daemon's terminal-token decision (domain/terminal-token-policy.ts), as index.ts takes it at startup.
import { describe, expect, it } from "vitest";
import { decideTerminalToken } from "../src/domain/terminal-token-policy.js";

const TOKEN = "t-" + "0".repeat(8);

describe("the terminal token the daemon requires (characterization: unchanged by the extraction)", () => {
  it("the environment's token wins", () => {
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1"], envToken: TOKEN })).toBe(TOKEN);
  });
  it("loopback only needs no token", () => {
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1"] })).toBeNull();
  });
});

// workspaces-o9o.78 (Jim, 2026-11-17: "Token when non-loopback"): terminal-class routes require the terminal token whenever the daemon
// listens beyond loopback (the tailnet included); loopback-only stays tokenless. With no OPENRIG_TERMINAL_BEARER_TOKEN, the daemon takes
// <OPENRIG_HOME>/terminal-token (made when absent), which the same host's CLI already sends.
describe("a daemon that listens beyond loopback requires the terminal token", () => {
  const FILE_TOKEN = "f-" + "2".repeat(8);
  const fromFile = () => FILE_TOKEN;

  it("the default bind with the tailnet (loopback + the tailscale address) requires a token: the file's", () => {
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1", "100.64.10.20"], readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("an explicit tailnet bind requires a token: the file's", () => {
    expect(decideTerminalToken({ bindHosts: ["100.64.10.20"], readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("a hostname is not known to be loopback, so it requires a token", () => {
    expect(decideTerminalToken({ bindHosts: ["sparky.lan"], readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("loopback only (127/8, ::1, localhost) stays tokenless and never makes the file", () => {
    let made = 0;
    const counted = () => { made++; return FILE_TOKEN; };
    expect(decideTerminalToken({ bindHosts: ["127.0.0.1", "::1", "localhost", "127.0.0.2"], readOrCreateFile: counted })).toBeNull();
    expect(made).toBe(0);
  });

  it("the environment's token wins over the file", () => {
    expect(decideTerminalToken({ bindHosts: ["100.64.10.20"], envToken: TOKEN, readOrCreateFile: fromFile })).toBe(TOKEN);
  });

  // workspaces-o9o.78 review F3 (CoS decision (c)): a public bind (0.0.0.0, a LAN address) takes the file like any bind beyond loopback;
  // the operator token is not an input to this decision at all.
  it("a public bind requires a token: the file's", () => {
    expect(decideTerminalToken({ bindHosts: ["0.0.0.0"], readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
    expect(decideTerminalToken({ bindHosts: ["192.168.1.50"], readOrCreateFile: fromFile })).toBe(FILE_TOKEN);
  });

  it("an IPv4-mapped loopback bind (::ffff:127.0.0.1) stays tokenless", () => {
    expect(decideTerminalToken({ bindHosts: ["::ffff:127.0.0.1"], readOrCreateFile: fromFile })).toBeNull();
  });
});
