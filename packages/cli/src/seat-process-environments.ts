// workspaces-o9o.106: the seat processes on this host, read for `rig doctor`'s seat PATH head row. Linux only: each
// process's environment is read from /proc/<pid>/environ (its environment as it started, which is what matters here).
// Never /proc/<pid>/fd: opening a live process's pipe takes bytes from it. A process this user cannot read is passed over.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { SeatProcess } from "./seat-path-head.js";

export type { SeatProcess } from "./seat-path-head.js";

/** Where to read. No options is the whole host: every process under /proc, which only rig doctor and rig setup ask for. A test passes
 *  its own procRoot (a fixture tree) or its own pids (workspaces-o9o.185: a test never reads another process's environment). */
export interface SeatProcessReadOptions {
  procRoot?: string;
  pids?: readonly number[];
}

/** Every readable process carrying OPENRIG_SESSION_NAME, with its OPENRIG_HOME, its PATH split in order and its command line; null where /proc cannot be read. */
export function readSeatProcesses(options: SeatProcessReadOptions = {}): SeatProcess[] | null {
  const procRoot = options.procRoot ?? "/proc";
  if (options.procRoot === undefined && (process.platform !== "linux" || !existsSync("/proc/self/environ"))) return null;
  const found: SeatProcess[] = [];
  const names = options.pids ? options.pids.map(String) : readdirSync(procRoot);
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(`${procRoot}/${name}/environ`, "utf8");
    } catch {
      continue; // gone, or not this user's
    }
    let session: string | undefined;
    let pathValue: string | undefined;
    let home: string | null = null;
    for (const entry of raw.split("\0")) {
      if (entry.startsWith("OPENRIG_SESSION_NAME=")) session = entry.slice("OPENRIG_SESSION_NAME=".length);
      else if (entry.startsWith("PATH=")) pathValue = entry.slice("PATH=".length);
      else if (entry.startsWith("OPENRIG_HOME=")) home = entry.slice("OPENRIG_HOME=".length);
    }
    if (!session) continue;
    let argv: string[] = [];
    try {
      argv = readFileSync(`${procRoot}/${name}/cmdline`, "utf8").split("\0");
      if (argv.at(-1) === "") argv.pop(); // the NUL that ends the last argument
    } catch { /* gone since its environment was read */ }
    found.push({ pid: Number(name), session, home, path: pathValue ? pathValue.split(":") : [], argv });
  }
  return found;
}
