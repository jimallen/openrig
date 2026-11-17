// workspaces-o9o.106: the seat processes on this host, read for `rig doctor`'s seat PATH head row. Linux only: each
// process's environment is read from /proc/<pid>/environ (its environment as it started, which is what matters here).
// Never /proc/<pid>/fd: opening a live process's pipe takes bytes from it. A process this user cannot read is passed over.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { SeatProcess } from "./seat-path-head.js";

export type { SeatProcess } from "./seat-path-head.js";

/** Every readable process carrying OPENRIG_SESSION_NAME, with its OPENRIG_HOME and its PATH split in order; null where /proc cannot be read. */
export function readSeatProcesses(): SeatProcess[] | null {
  if (process.platform !== "linux" || !existsSync("/proc/self/environ")) return null;
  const found: SeatProcess[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${name}/environ`, "utf8");
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
    if (session) found.push({ pid: Number(name), session, home, path: pathValue ? pathValue.split(":") : [] });
  }
  return found;
}
