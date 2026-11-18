import { execFileSync } from "node:child_process";
// workspaces-o9o.78 (Jim, 2026-11-17: "Token when non-loopback"): terminal-class routes require the terminal token whenever the daemon
// listens beyond loopback (the tailnet included); loopback-only stays tokenless. This file pins the parts around the decision itself
// (test/terminal-token-policy.test.ts): the token file, the listener check, the routes now under the terminal guard, and the 401 a peer
// gets. Fake tokens are built at runtime (no credential-shaped literal).
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { Hono } from "hono";
import { readOrCreateTerminalToken } from "../src/adapters/terminal-token-file.js";
import { isLoopbackAddress, listenerTokenProblem, TERMINAL_TOKEN_FILE } from "../src/domain/terminal-token-policy.js";
import { transcriptRoutes } from "../src/routes/transcripts.js";
import { askRoutes } from "../src/routes/ask.js";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(nodePath.join(tmpdir(), "o9o78-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const TOKEN = "tok-" + "a".repeat(16);

describe("the instance's terminal token file", () => {
  it("is made when absent: 64 hex characters, mode 0600; the next start reads the same token", () => {
    const home = temp();
    const first = readOrCreateTerminalToken(home);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(nodePath.join(home, TERMINAL_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    expect(readOrCreateTerminalToken(home)).toBe(first);
  });

  it("an existing token is used as written, and a file others can read is narrowed to 0600", () => {
    const home = temp();
    const file = nodePath.join(home, TERMINAL_TOKEN_FILE);
    writeFileSync(file, `${TOKEN}\n`);
    chmodSync(file, 0o644);
    expect(readOrCreateTerminalToken(home)).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a link at that path is refused, not followed", () => {
    const home = temp();
    const elsewhere = nodePath.join(temp(), "other");
    writeFileSync(elsewhere, `${TOKEN}\n`);
    symlinkSync(elsewhere, nodePath.join(home, TERMINAL_TOKEN_FILE));
    expect(() => readOrCreateTerminalToken(home)).toThrow(/symbolic link/); // o9o.151: the credential rule's wording
  });

  it("an empty file is refused (an empty token would be no token)", () => {
    const home = temp();
    writeFileSync(nodePath.join(home, TERMINAL_TOKEN_FILE), "\n");
    expect(() => readOrCreateTerminalToken(home)).toThrow(/is empty/);
  });

  // workspaces-o9o.151: the file is read under the credential rule, so it has a size cap like every other secret file.
  it("a file over the 4096-byte cap is refused, naming it, and is not read whole", () => {
    const home = temp();
    const file = nodePath.join(home, TERMINAL_TOKEN_FILE);
    writeFileSync(file, "a".repeat(5000), { mode: 0o600 });
    expect(() => readOrCreateTerminalToken(home)).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}.*4096-byte limit`));
  });

  it("a FIFO at that path is refused without hanging the start", () => {
    const home = temp();
    execFileSync("mkfifo", ["-m", "600", nodePath.join(home, TERMINAL_TOKEN_FILE)]);
    expect(() => readOrCreateTerminalToken(home)).toThrow(/not a regular file/);
  });
});

describe("loopback, and the listener check", () => {
  it.each([["127.0.0.1", true], ["127.4.5.6", true], ["::1", true], ["[::1]", true], ["::ffff:127.0.0.1", true], ["localhost", true],
    ["0.0.0.0", false], ["::", false], ["100.64.1.2", false], ["192.168.1.9", false], ["sparky.lan", false], ["", false]])("%j is loopback: %s", (a, want) => {
    expect(isLoopbackAddress(a)).toBe(want);
  });

  it("a listener beyond loopback with no token is a problem (the daemon stops); with one, or on loopback, it is not", () => {
    expect(listenerTokenProblem("100.64.1.2", null)).toMatch(/beyond loopback, with no terminal token/);
    expect(listenerTokenProblem("100.64.1.2", TOKEN)).toBeNull();
    expect(listenerTokenProblem("127.0.0.1", null)).toBeNull();
  });
});

describe("a seat's screen history is a terminal-class read: transcripts and /api/ask take the terminal guard", () => {
  const app = (token: string | null) => {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("terminalBearerToken" as never, token as never); await next(); });
    a.route("/api/transcripts", transcriptRoutes());
    a.route("/api/ask", askRoutes);
    return a;
  };

  it.each([
    ["GET", "/api/transcripts/dev@r/tail"], ["GET", "/api/transcripts/dev@r/grep?pattern=x"], ["GET", "/api/transcripts/dev@r/full"],
    ["POST", "/api/ask"],
  ])("%s %s answers 401 without the token when one is required", async (method, path) => {
    const res = await app(TOKEN).request(path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
    expect(res.status).toBe(401);
  });

  it("the guard passes the right token through (the route then answers for itself, not 401)", async () => {
    const res = await app(TOKEN).request("/api/transcripts/dev@r/tail", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).not.toBe(401);
  });

  it("a loopback-only daemon (no token) stays open, as before", async () => {
    const res = await app(null).request("/api/transcripts/dev@r/tail");
    expect(res.status).not.toBe(401);
  });

  it("the 401 a peer gets names the provisioning step: the token file on the daemon's host, and bearer_file in the caller's hosts.yaml", async () => {
    const body = await (await app(TOKEN).request("/api/transcripts/dev@r/full")).text();
    expect(body).toContain("terminal-token");
    expect(body).toContain("bearer_file");
    expect(body).toContain("hosts.yaml");
  });
});

describe("the source copy of the CLI side (the same host's CLI already sends the file)", () => {
  it("cli client.ts reads <OPENRIG_HOME>/terminal-token when OPENRIG_TERMINAL_BEARER_TOKEN is unset", () => {
    const src = readFileSync(nodePath.resolve(import.meta.dirname, "../../cli/src/client.ts"), "utf8");
    expect(src).toContain(`path.join(homeDir, "${TERMINAL_TOKEN_FILE}")`);
  });
});
