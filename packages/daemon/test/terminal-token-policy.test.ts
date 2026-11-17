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
