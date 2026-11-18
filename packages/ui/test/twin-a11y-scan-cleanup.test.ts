// workspaces-o9o.130 (verify-qa2 finding 2): a Chrome that never answers the DevTools protocol must leave no process and
// no profile behind. The scanner runs for real (tsx) against stand-in "Chrome" scripts in a private TMPDIR.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const UI = path.resolve(__dirname, "..");
const TSX = path.join(UI, "node_modules", ".bin", "tsx");
const TSX_ROOT = path.join(UI, "..", "..", "node_modules", ".bin", "tsx");

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "a11y-cleanup-test-")); });
afterEach(() => {
  // A stand-in the scanner failed to stop must not outlive the test (it would, under a mutated scanner).
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".pid"))) {
    try { process.kill(Number(readFileSync(path.join(dir, f), "utf8").trim()), "SIGKILL"); } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in Chrome: records its pid and its arguments, optionally prints a DevTools line, then waits. */
function standIn(name: string, devtoolsLine: string | null): string {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho $$ > "${dir}/${name}.pid"\nprintf "%s\\n" "$@" > "${dir}/${name}.args"\n${devtoolsLine ? `echo "${devtoolsLine}" >&2\n` : ""}exec sleep 120\n`);
  chmodSync(p, 0o755);
  return p;
}

/** Run the scanner; a scanner still running after 30 s is killed (code null), so a hang still reaches the leak checks. */
function runScan(chrome: string): Promise<{ code: number | null; stderr: string }> {
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  return new Promise((resolve) => {
    const bin = existsSync(TSX) ? TSX : TSX_ROOT;
    const child = spawn(bin, ["twin/capture/a11y-scan.ts", "--out", path.join(dir, "out"), "--chrome", chrome, "--start-timeout-ms", "800", "--only", "/"], {
      cwd: UI, env: { ...process.env, TMPDIR: tmp }, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const cap = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("exit", (code) => { clearTimeout(cap); resolve({ code, stderr }); });
  });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (name: string) => Number(readFileSync(path.join(dir, `${name}.pid`), "utf8").trim());
/** The --user-data-dir the scanner gave the stand-in. */
const profileOf = (name: string) => readFileSync(path.join(dir, `${name}.args`), "utf8").split("\n").find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);

describe("twin:a11y start-up failure leaves nothing behind (o9o.130)", () => {
  const cases: Array<[string, (port: number) => string | null, RegExp]> = [
    ["a Chrome that never prints its DevTools URL", () => null, /did not start within 800 ms/],
    ["a Chrome whose DevTools port accepts and never answers", (port) => `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/x`, /did not answer the DevTools protocol within 800 ms/],
  ];
  for (const [label, line, message] of cases) {
    it(`${label}: exits 1, its process is gone, its profile is gone, no report`, async () => {
      const held: net.Socket[] = [];
      const server = net.createServer((sock) => { held.push(sock); }); // accepts, never speaks
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as net.AddressInfo).port;
      try {
        const name = "chrome-standin";
        const { code, stderr } = await runScan(standIn(name, line(port)));
        // The symptom first: what the scanner leaves behind.
        const pid = pidOf(name);
        expect(pid).toBeGreaterThan(0);
        expect(alive(pid)).toBe(false);
        // The profile it was given was created in the private TMPDIR and is gone; no twin-a11y- entry is left (tsx keeps
        // its own cache there, which is not the scanner's).
        const profile = profileOf(name);
        expect(profile?.startsWith(path.join(dir, "tmp", "twin-a11y-"))).toBe(true);
        expect(existsSync(profile!)).toBe(false);
        expect(readdirSync(path.join(dir, "tmp")).filter((n) => n.startsWith("twin-a11y-"))).toEqual([]);
        expect(existsSync(path.join(dir, "out", "a11y-report.json"))).toBe(false);
        // Then how it ends: promptly, exit 1, saying why.
        expect(code).toBe(1);
        expect(stderr).toMatch(message);
      } finally {
        for (const s of held) s.destroy();
        server.close();
      }
    }, 45_000);
  }
});
