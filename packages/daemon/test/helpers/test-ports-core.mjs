// workspaces-o9o.81: the one implementation (plain ESM, so node --test scripts under scripts/ can use it too; test-ports.ts re-exports it
// with types from test-ports-core.d.mts). One way for a test to get a loopback port that something ELSE will bind later (a child daemon, a gate, a server
// started after the number is in hand), or that must stay refused.
//
// Asking the OS for a free port (listen on 0, read the port, close) and handing the number on leaves a window: until the later bind,
// the port is free again, and another test process doing the same can be handed the same number. Measured on release 4's suites: two
// copies of delivery-review.real (two heavy-run slots) took one port, so /api/health answered from the other run's daemon, and a
// scenario daemon died on EADDRINUSE. The OS cannot be told to keep the number; so every test process that probes this way records a
// claim on the number first, and skips a number another live test process has claimed:
//  - a claim is a file `<os.tmpdir()>/openrig-test-ports/<port>` created exclusively (O_EXCL), holding the claimant's pid;
//  - a claim whose pid is gone is reclaimable (moved aside atomically, so two reclaimers cannot both win);
//  - a process removes its own claims when it exits.
// What it cannot stop: a process that does not use this helper (an in-process server's own listen(0), anything outside the suites)
// taking the number in the window. It closes the case that was measured: one test process against another.
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_PORT_HOST = "127.0.0.1";

/** Resolved once: a test that stubs TMPDIR later must not move the claims of this process. */
export const TEST_PORT_CLAIMS_DIR = join(tmpdir(), "openrig-test-ports");

const mine = new Set();
let exitHook = false;

/** The OS's choice of a free loopback port, released at once. */
export function probeFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {   // loopback only, spelled out for the loopback census (test-listen-loopback-census)
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("the OS offered no port"))));
    });
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** How long a claim that is empty or does not hold a pid is still treated as held: what a writer paused (or crashed) mid-write leaves. */
export const CLAIM_WRITE_GRACE_MS = 60_000;

/** A claim file's state: "absent", or "held" with its owner pid, or "unreadable" (empty or not a pid) with its age in ms. */
function claimState(file) {
  let text;
  let ageMs;
  try { text = readFileSync(file, "utf8"); ageMs = Date.now() - statSync(file).mtimeMs; } catch (e) { return e.code === "ENOENT" ? { state: "absent" } : { state: "unreadable", ageMs: 0 }; }
  const trimmed = text.trim();
  return /^[1-9][0-9]*$/.test(trimmed) ? { state: "held", owner: Number(trimmed) } : { state: "unreadable", ageMs };
}

function ownerOf(file) {
  const seen = claimState(file);
  return seen.state === "held" ? seen.owner : Number.NaN;
}

/** Publishes this process's claim on `file` atomically (workspaces-o9o.81, verify-qa review): the pid goes into a unique temp file, which is
 *  then hard-linked to the claim's name; link() fails with EEXIST when a claim is there, so a claim is either absent or complete, never half
 *  written. The temp file is removed whatever happens. */
function create(file) {
  const tmp = `${file}.writing-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, String(process.pid), { flag: "wx" });
    try { linkSync(tmp, file); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Claims `port` for this process; false when another test process holds it. The states of a claim file, each with its answer:
 *  - absent: claimed now (atomically, above);
 *  - held by this process: false (never taken twice);
 *  - held by a live process: false;
 *  - held by a process that is gone: moved aside atomically and claimed (a claim made live meanwhile is put back);
 *  - empty or not a pid (a writer mid-write, or one that crashed mid-write): held for CLAIM_WRITE_GRACE_MS, then reclaimed like a dead one.
 * A port that is not a positive integer is refused, and no file is written for it.
 */
export function claimPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  mkdirSync(TEST_PORT_CLAIMS_DIR, { recursive: true });
  const file = join(TEST_PORT_CLAIMS_DIR, String(port));
  if (create(file)) { remember(port); return true; }
  const seen = claimState(file);
  if (seen.state === "absent") return false;   // released meanwhile: the next offer will do
  if (seen.state === "held" && (seen.owner === process.pid || alive(seen.owner))) return false;
  if (seen.state === "unreadable" && seen.ageMs < CLAIM_WRITE_GRACE_MS) return false;
  // A dead claimant's file: move it aside first. Only one reclaimer's rename succeeds; a claim made live meanwhile is put back.
  const aside = `${file}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try { renameSync(file, aside); } catch { return false; }
  const moved = claimState(aside);
  const stillHeld = (moved.state === "held" && alive(moved.owner)) || (moved.state === "unreadable" && moved.ageMs < CLAIM_WRITE_GRACE_MS);
  if (stillHeld) { try { linkSync(aside, file); } catch { /* a newer claim is already there */ } unlinkSync(aside); return false; }
  unlinkSync(aside);
  if (create(file)) { remember(port); return true; }
  return false;
}

function remember(port) {
  mine.add(port);
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => { for (const p of mine) releasePort(p); });
}

/** Drops this process's claim on `port` (never another process's). */
export function releasePort(port) {
  const file = join(TEST_PORT_CLAIMS_DIR, String(port));
  if (ownerOf(file) === process.pid) { try { unlinkSync(file); } catch { /* already gone */ } }
  mine.delete(port);
}


/**
 * A loopback port for a server that something else binds later, or that must stay refused: the OS's free port, claimed for this
 * process so no other test process using this helper is handed it until this process exits (or releases it).
 */
export async function claimTestPort(opts = {}) {
  const probe = opts.probe ?? probeFreePort;
  const attempts = opts.attempts ?? 50;
  for (let i = 0; i < attempts; i += 1) {
    const port = await probe();
    if (claimPort(port)) return port;
  }
  throw new Error(`no unclaimed loopback port after ${attempts} offers (claims in ${TEST_PORT_CLAIMS_DIR})`);
}

/** The same, for a caller that cannot await: runs the probe in a child process. */
export function claimTestPortSync() {
  for (let i = 0; i < 50; i += 1) {
    const port = Number(spawnSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" }).stdout.trim());
    if (!Number.isInteger(port) || port <= 0) continue;
    if (claimPort(port)) return port;
  }
  throw new Error(`no unclaimed loopback port after 50 offers (claims in ${TEST_PORT_CLAIMS_DIR})`);
}
