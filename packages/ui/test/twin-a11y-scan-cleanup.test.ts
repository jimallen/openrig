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
/**
 * workspaces-o9o.184 (verify-sec review): a stand-in the scanner failed to stop must not outlive the test, and no other
 * process may be signalled for it. Every stand-in records its pid AND its own start token (<name>.pid, <name>.start, in
 * owned-chrome.ts startToken's format), and is signalled only while that start token still matches: never a bare pid.
 */
async function stopRecordedStandIns(): Promise<void> {
  const { startToken } = await import("../twin/capture/owned-chrome.js");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".pid"))) {
    const pid = Number(readFileSync(path.join(dir, f), "utf8").trim());
    const startFile = path.join(dir, f.replace(/\.pid$/, ".start"));
    if (!existsSync(startFile)) continue;
    const start = readFileSync(startFile, "utf8").trim();
    if (start && startToken(pid) === start) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}
afterEach(async () => {
  await stopRecordedStandIns();
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in Chrome: records its pid and its arguments, optionally prints a DevTools line, then waits. */
function standIn(name: string, devtoolsLine: string | null): string {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho $$ > "${dir}/${name}.pid"\necho "$(if [ -r /proc/$$/stat ]; then echo "proc:$(sed 's/.*) //' /proc/$$/stat | cut -d' ' -f20)"; else echo "ps:$(ps -o lstart= -p $$ | sed 's/^ *//;s/ *$//')"; fi)" > "${dir}/${name}.start"\nprintf "%s\\n" "$@" > "${dir}/${name}.args"\n${devtoolsLine ? `echo "${devtoolsLine}" >&2\n` : ""}exec sleep 120\n`);
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
function standInWithHelper(name: string, devtoolsLine: string | null, scribble: boolean, opts: { killParent?: boolean; decoys?: boolean; flagInTitle?: boolean } = {}): string {
  const p = path.join(dir, name);
  const TOKEN = (v: string) => `$(if [ -r /proc/${v}/stat ]; then echo "proc:$(sed 's/.*) //' /proc/${v}/stat | cut -d' ' -f20)"; else echo "ps:$(ps -o lstart= -p ${v} | sed 's/^ *//;s/ *$//')"; fi)`;
  // $BASHPID inside $( ) would be the command substitution's own subshell: capture the subshell's pid first.
  const record = (file: string) => `me=$BASHPID; echo $me > "${dir}/${file}.pid"; echo "${TOKEN("$me")}" > "${dir}/${file}.start"`;
  const body = scribble
    ? `trap '' TERM; exec -a "chrome-helper --user-data-dir=$profile" bash -c 'trap "" TERM; while :; do mkdir -p "$0/Default" 2>/dev/null; date > "$0/Default/x.$RANDOM" 2>/dev/null; sleep 0.05; done' "$profile"`
    : `exec -a "chrome-helper --user-data-dir=$profile" sleep 120`;
  writeFileSync(p, [
    "#!/usr/bin/env bash",
    // The scanner dying before its reaper could look (o9o.184, verify-sec 1): the stand-in kills its parent first thing.
    opts.killParent ? "kill -KILL $PPID" : "",
    `echo $$ > "${dir}/${name}.pid"`,
    `echo "${TOKEN("$$")}" > "${dir}/${name}.start"`,
    `printf "%s\\n" "$@" > "${dir}/${name}.args"`,
    'profile=""; for a in "$@"; do case $a in --user-data-dir=*) profile=${a#--user-data-dir=} ;; esac; done',
    // Decoys name the profile only as a substring, never as the exact flag: not this run's Chrome (verify-sec 2).
    opts.decoys ? `( ${record(`${name}.decoy1`)}; exec -a "decoy --user-data-dir=$profile/sub" sleep 120 ) &` : "",
    opts.decoys ? `( ${record(`${name}.decoy2`)}; exec -a "decoy $profile" sleep 120 ) &` : "",
    `( ${record(`${name}.helper`)}; ${body} ) &`,
    devtoolsLine ? `echo "${devtoolsLine}" >&2` : "",
    // Real Chrome keeps the profile flag in its process title; a stand-in that `exec`s sleep loses it unless it re-sets it.
    opts.flagInTitle ? 'exec -a "chrome-standin --user-data-dir=$profile" sleep 120' : "exec sleep 120",
  ].join("\n") + "\n");
  chmodSync(p, 0o755);
  return p;
}

/** A stand-in npm on PATH: `npm run twin:build` returns at once, or never (`hang`). */
function fakeNpm(hang: boolean): string {
  const bin = path.join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  // A hanging stand-in records its pid, so afterEach stops it even when a broken scanner never times the build out.
  const TOKEN = `$(if [ -r /proc/$$/stat ]; then echo "proc:$(sed 's/.*) //' /proc/$$/stat | cut -d' ' -f20)"; else echo "ps:$(ps -o lstart= -p $$ | sed 's/^ *//;s/ *$//')"; fi)`;
  writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash\n${hang ? `echo $$ > "${dir}/npm.helper.pid"\necho "${TOKEN}" > "${dir}/npm.helper.start"\nexec sleep 600` : "exit 0"}\n`);
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

  it("the scanner dying before its reaper could look (killed by its own Chrome, first thing): Chrome, helper and profile are still reaped", async () => {
    const held: net.Socket[] = [];
    const server = net.createServer((sock) => { held.push(sock); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const name = "chrome-kills-parent";
      const r = await runScan2(standInWithHelper(name, `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/x`, false, { killParent: true, flagInTitle: true }),
        ["--start-timeout-ms", "20000", "--only", "/"]);
      expect(r.signal).toBe("SIGKILL");
      expect(await until(() => existsSync(path.join(dir, `${name}.helper.pid`)), 5_000), "positive control: the helper started").toBe(true);
      const pid = pidOf(name), helper = helperPidOf(name), profile = profileOf(name)!;
      expect(await until(() => !alive(pid) && !alive(helper) && !existsSync(profile), 10_000)).toBe(true);
    } finally {
      for (const s of held) s.destroy();
      server.close();
    }
  }, 45_000);

  it("a process naming the profile only as a substring is not this run's Chrome: it survives the reap", async () => {
    const held: net.Socket[] = [];
    const server = net.createServer((sock) => { held.push(sock); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const name = "chrome-with-decoys";
      const r = await runScan2(standInWithHelper(name, `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/x`, false, { decoys: true }),
        ["--start-timeout-ms", "20000", "--only", "/"], { killAfterPid: name });
      expect(r.signal).toBe("SIGKILL");
      const decoys = [1, 2].map((i) => Number(readFileSync(path.join(dir, `${name}.decoy${i}.pid`), "utf8").trim()));
      expect(decoys.every((d) => d > 0), "positive control: both decoys started").toBe(true);
      expect(await until(() => !alive(pidOf(name)) && !alive(helperPidOf(name)), 10_000), "Chrome and its exact-flag helper are reaped").toBe(true);
      expect(decoys.map(alive)).toEqual([true, true]);
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

// o9o.184 (verify-sec 3): nothing is selected or removed unless the profile is this run's: a non-empty, absolute,
// whitespace-free, real directory owned by this user, named twin-a11y-XXXXXX, directly in the run's temp folder.
describe("owned-chrome: the profile boundary (o9o.184)", () => {
  it("names each way a path is not this run's profile, and passes the real one", async () => {
    const mod = await import("../twin/capture/owned-chrome.js").catch(() => null);
    expect(mod?.profileProblem, "owned-chrome.ts exports profileProblem").toBeTypeOf("function");
    const { profileProblem } = mod!;
    const root = path.join(dir, "tmproot");
    mkdirSync(root, { recursive: true });
    const real = mkdtempSync(path.join(root, "twin-a11y-"));
    expect(profileProblem(real, root)).toBeNull();
    const other = mkdtempSync(path.join(root, "other-"));
    const elsewhere = mkdtempSync(path.join(dir, "twin-a11y-"));
    const link = path.join(root, "twin-a11y-LINKAA");
    (await import("node:fs")).symlinkSync(elsewhere, link);
    for (const [label, profile] of [
      ["empty", ""], ["relative", "twin-a11y-AAAAAA"], ["the temp folder itself", root], ["its parent", dir],
      ["a sibling not named twin-a11y-", other], ["a twin-a11y- folder in another folder", elsewhere],
      ["a symlink named like a profile", link], ["a profile that does not exist", path.join(root, "twin-a11y-ZZZZZZ")],
      ["whitespace", path.join(root, "twin-a11y-A B CD")],
    ] as const) expect(profileProblem(profile, root), label).not.toBeNull();
  });

  it("a signal goes only to the same process: a changed start time, or a missing exact profile flag, sends nothing", async () => {
    const mod = await import("../twin/capture/owned-chrome.js").catch(() => null);
    expect(mod?.signalIfStill, "owned-chrome.ts exports signalIfStill").toBeTypeOf("function");
    const { signalIfStill, startToken } = mod!;
    const child = spawn("bash", ["-c", "exec -a \"x --user-data-dir=/nowhere/twin-a11y-AAAAAA\" sleep 60"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const real = { pid: child.pid!, start: startToken(child.pid!) };
      expect(real.start, "positive control: the start token is readable").not.toBe("");
      expect(signalIfStill({ ...real, start: `${real.start}0` }, "SIGTERM", null), "a different start time").toBe(false);
      expect(signalIfStill(real, "SIGTERM", "/nowhere/twin-a11y-BBBBBB"), "another profile").toBe(false);
      expect(signalIfStill(real, "SIGTERM", "/nowhere/twin-a11y-AAAAA"), "a prefix of the profile").toBe(false);
      expect(alive(child.pid!)).toBe(true);
      expect(signalIfStill(real, "SIGTERM", "/nowhere/twin-a11y-AAAAAA"), "the same process, the exact flag").toBe(true);
    } finally { child.kill("SIGKILL"); }
  });

  it("reap refuses a profile that is not this run's: nothing is signalled, nothing is removed", async () => {
    const mod = await import("../twin/capture/owned-chrome.js").catch(() => null);
    expect(mod?.reap, "owned-chrome.ts exports reap").toBeTypeOf("function");
    const root = path.join(dir, "tmproot2");
    mkdirSync(root, { recursive: true });
    // A process carrying the EXACT flag for the would-be profile: a refusal must not signal it.
    const victim = spawn("bash", ["-c", `exec -a "x --user-data-dir=${root}" sleep 60`], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      for (const profile of ["", root, dir]) {
        const r = mod!.reap({ profile, tmpRoot: path.dirname(root) });
        expect(r.refused, `refused: ${profile}`).not.toBeNull();
        expect(r.signalled).toBe(0);
      }
      expect(existsSync(root)).toBe(true);
      expect(alive(victim.pid!)).toBe(true);
    } finally { victim.kill("SIGKILL"); }
  });
});
