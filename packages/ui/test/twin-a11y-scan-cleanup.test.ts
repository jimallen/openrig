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

// workspaces-o9o.184: what the scanner leaves when IT dies, and a scan that hangs. Found on o9o.153: a twin:a11y run hung for
// two hours with no output; when its node was stopped, its Chrome (10 processes) kept running under systemd with its /tmp
// profile, and a later run's cleanup failed with ENOTEMPTY on a profile a helper was still writing.

/** A stand-in Chrome with a HELPER: the helper carries the profile path in its arguments, as Chrome's own helpers do, and
 *  (when `scribble`) keeps writing into the profile after the main process is gone. */
function standInWithHelper(name: string, devtoolsLine: string | null, scribble: boolean): string {
  const p = path.join(dir, name);
  const helper = scribble
    ? `( trap '' TERM; exec -a "chrome-helper --user-data-dir=$profile" bash -c 'trap "" TERM; while :; do mkdir -p "$0/Default" 2>/dev/null; date > "$0/Default/x.$RANDOM" 2>/dev/null; sleep 0.05; done' "$profile" ) &`
    : `( exec -a "chrome-helper --user-data-dir=$profile" sleep 120 ) &`;
  writeFileSync(p, [
    "#!/usr/bin/env bash",
    `echo $$ > "${dir}/${name}.pid"`,
    `printf "%s\\n" "$@" > "${dir}/${name}.args"`,
    'profile=""; for a in "$@"; do case $a in --user-data-dir=*) profile=${a#--user-data-dir=} ;; esac; done',
    helper,
    `echo $! > "${dir}/${name}.helper.pid"`,
    devtoolsLine ? `echo "${devtoolsLine}" >&2` : "",
    "exec sleep 120",
  ].join("\n") + "\n");
  chmodSync(p, 0o755);
  return p;
}

/** A stand-in npm on PATH: `npm run twin:build` returns at once, or never (`hang`). */
function fakeNpm(hang: boolean): string {
  const bin = path.join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash\n${hang ? "exec sleep 600" : "exit 0"}\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  return bin;
}

/** A DevTools endpoint: a real WebSocket handshake, every method answered with a plain result except `silent`, never answered. */
async function fakeDevtools(silent: string): Promise<{ url: string; close: () => void }> {
  const { createHash } = await import("node:crypto");
  const socks: net.Socket[] = [];
  const server = net.createServer((sock) => {
    socks.push(sock);
    let buf = Buffer.alloc(0); let open = false;
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf("\r\n\r\n"); if (end < 0) return;
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(buf.subarray(0, end).toString())![1]!;
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buf = buf.subarray(end + 4); open = true;
      }
      while (buf.length >= 2) {
        let len = buf[1]! & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const body = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]!));
        const opcode = buf[0]! & 0x0f;
        buf = buf.subarray(off + 4 + len);
        if (opcode !== 1) continue;
        const msg = JSON.parse(body.toString()) as { id: number; method: string };
        if (msg.method === silent) continue;
        const result = msg.method === "Target.createTarget" ? { targetId: "t1" } : msg.method === "Target.attachToTarget" ? { sessionId: "s1" } : {};
        const out = Buffer.from(JSON.stringify({ id: msg.id, result }));
        const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 0xff]);
        sock.write(Buffer.concat([head, out]));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/devtools/browser/x`, close: () => { for (const s of socks) s.destroy(); server.close(); } };
}

/** Run the scanner with extra arguments and PATH entries; `killAfterPid` SIGKILLs the scanner once that stand-in started. */
function runScan2(chrome: string, extra: string[], opts: { pathHead?: string; killAfterPid?: string; capMs?: number } = {}): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  return new Promise((resolve) => {
    const env = { ...process.env, TMPDIR: tmp, ...(opts.pathHead ? { PATH: `${opts.pathHead}:${process.env.PATH}` } : {}) };
    // The scanner IS the child (node with tsx's loader), not a tsx launcher above it: killing it is the scanner's own death,
    // and the test's cap leaves no scanner orphaned under a dead launcher.
    const child = spawn(process.execPath, ["--import", "tsx", "twin/capture/a11y-scan.ts", "--out", path.join(dir, "out"), "--chrome", chrome, ...extra], { cwd: UI, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const cap = setTimeout(() => child.kill("SIGKILL"), opts.capMs ?? 30_000);
    if (opts.killAfterPid) {
      const poll = setInterval(() => { if (existsSync(path.join(dir, `${opts.killAfterPid}.helper.pid`))) { clearInterval(poll); setTimeout(() => child.kill("SIGKILL"), 300); } }, 50);
      child.on("exit", () => clearInterval(poll));
    }
    child.on("exit", (code, signal) => { clearTimeout(cap); resolve({ code, signal, stdout, stderr }); });
  });
}
const helperPidOf = (name: string) => Number(readFileSync(path.join(dir, `${name}.helper.pid`), "utf8").trim());
const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return ok(); };

describe("twin:a11y leaves nothing behind when the scanner itself dies, or a helper is busy (o9o.184)", () => {
  afterEach(() => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".helper.pid"))) {
      try { process.kill(Number(readFileSync(path.join(dir, f), "utf8").trim()), "SIGKILL"); } catch { /* gone */ }
    }
  });

  it("the scanner killed mid-run (SIGKILL): its Chrome, Chrome's helper and the profile are gone within seconds", async () => {
    const held: net.Socket[] = [];
    const server = net.createServer((sock) => { held.push(sock); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const name = "chrome-owner-death";
      const r = await runScan2(standInWithHelper(name, `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/x`, false), ["--start-timeout-ms", "20000", "--only", "/"], { killAfterPid: name });
      expect(r.signal).toBe("SIGKILL");
      const pid = pidOf(name), helper = helperPidOf(name), profile = profileOf(name)!;
      // Positive control: the scan had started its Chrome and the helper (both pids recorded), and given them a profile.
      expect(pid).toBeGreaterThan(0);
      expect(helper).toBeGreaterThan(0);
      expect(profile.startsWith(path.join(dir, "tmp", "twin-a11y-"))).toBe(true);
      expect(await until(() => !alive(pid) && !alive(helper) && !existsSync(profile), 10_000)).toBe(true);
    } finally {
      for (const s of held) s.destroy();
      server.close();
    }
  }, 45_000);

  it("a helper still writing the profile after Chrome exits is stopped and the profile removed, not an ENOTEMPTY failure", async () => {
    const name = "chrome-busy-helper";
    const r = await runScan2(standInWithHelper(name, null, true), ["--start-timeout-ms", "800", "--only", "/"]);
    expect(r.stderr).not.toMatch(/ENOTEMPTY/);
    expect(r.stderr).toMatch(/did not start within 800 ms/);
    expect(r.code).toBe(1);
    expect(await until(() => !alive(helperPidOf(name)), 5_000)).toBe(true);
    expect(existsSync(profileOf(name)!)).toBe(false);
  }, 45_000);

  for (const [label, silent, hang, message] of [
    ["a page command that never returns", "Runtime.evaluate", false, /FAILED: timed out after 2000 ms.*\/ \[light\]/],
    ["a twin build that never returns", "", true, /FAILED: twin:build timed out after 2000 ms.*\/ \[light\]/],
  ] as const) {
    it(`${label}: the surface fails by name within its timeout and the scan ends with its report`, async () => {
      const dev = await fakeDevtools(silent);
      try {
        const name = "chrome-hang";
        const r = await runScan2(standInWithHelper(name, `DevTools listening on ${dev.url}`, false),
          ["--only", "/", "--surface-timeout-ms", "2000", "--build-timeout-ms", "2000"], { pathHead: fakeNpm(hang), capMs: 40_000 });
        expect(r.signal, `the scan ended by itself, not by the test's cap; stdout: ${r.stdout.slice(-400)} stderr: ${r.stderr.slice(-400)}`).toBeNull();
        expect(r.stdout).toMatch(message);
        expect(existsSync(path.join(dir, "out", "a11y-report.json"))).toBe(true);
        expect(await until(() => !alive(pidOf(name)) && !alive(helperPidOf(name)), 10_000)).toBe(true);
      } finally { dev.close(); }
    }, 60_000);
  }
});
