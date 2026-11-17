// workspaces-o9o.81: one way for a test to get a loopback port that something ELSE will bind later (a child daemon, a gate, a server
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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_PORT_HOST = "127.0.0.1";

/** Resolved once: a test that stubs TMPDIR later must not move the claims of this process. */
export const TEST_PORT_CLAIMS_DIR = join(tmpdir(), "openrig-test-ports");


/** The OS's choice of a free loopback port, released at once. */
export function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, TEST_PORT_HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("the OS offered no port"))));
    });
  });
}




/** RED commit of workspaces-o9o.81: no claims yet. Every caller is handed what the OS offered, as before the change. */
export function claimPort(_port: number): boolean { return true; }

/** RED commit: nothing to release. */
export function releasePort(_port: number): void { /* no claims yet */ }

export interface ClaimOptions {
  /** Where candidate numbers come from: the OS by default (a test seam). */
  probe?: () => Promise<number>;
  /** How many offers to try before giving up. */
  attempts?: number;
}

/**
 * A loopback port for a server that something else binds later, or that must stay refused: the OS's free port, claimed for this
 * process so no other test process using this helper is handed it until this process exits (or releases it).
 */
export async function claimTestPort(opts: ClaimOptions = {}): Promise<number> {
  const probe = opts.probe ?? probeFreePort;
  const attempts = opts.attempts ?? 50;
  for (let i = 0; i < attempts; i += 1) {
    const port = await probe();
    if (claimPort(port)) return port;
  }
  throw new Error(`no unclaimed loopback port after ${attempts} offers (claims in ${TEST_PORT_CLAIMS_DIR})`);
}

/** The same, for a caller that cannot await: runs the probe in a child process. */
export function claimTestPortSync(): number {
  for (let i = 0; i < 50; i += 1) {
    const port = Number(spawnSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" }).stdout.trim());
    if (!Number.isInteger(port) || port <= 0) continue;
    if (claimPort(port)) return port;
  }
  throw new Error(`no unclaimed loopback port after 50 offers (claims in ${TEST_PORT_CLAIMS_DIR})`);
}
