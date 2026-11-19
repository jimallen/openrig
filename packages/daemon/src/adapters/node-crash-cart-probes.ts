// node-crash-cart-probes.ts — crash-cart's probe I/O (workspaces-o9o.161): the daemon.json read and the process-liveness signal.
// The rules stay in the domain (domain/crash-cart-probes.ts: classifyProbeError, probeHealthz, parseDaemonState).
import { join } from "node:path";
import { DAEMON_STATE_POLICY } from "../domain/credential-file.js";
import type { DaemonStateFile } from "../domain/crash-cart-detect.js";
import { parseDaemonState } from "../domain/crash-cart-probes.js";
import { readOwnFile } from "./node-credential-file-reader.js";

/** True if `pid` is a live process. `process.kill(pid, 0)` throws ESRCH when absent, EPERM when it
 *  exists but we can't signal it (still alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read + parse `$OPENRIG_HOME/daemon.json` → the {pid,port,host} record, or undefined if absent or
 *  malformed (treated as "no state file"). Read under the credential rule (workspaces-o9o.160): a link or another user's
 *  daemon.json is not used; group/other write on our own is narrowed. */
export function readDaemonJson(openrigHome: string): DaemonStateFile | undefined {
  const read = readOwnFile(join(openrigHome, "daemon.json"), DAEMON_STATE_POLICY);
  return read.ok ? parseDaemonState(read.content) : undefined;
}
