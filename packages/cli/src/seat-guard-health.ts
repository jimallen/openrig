// workspaces-o9o.173: whether each running Claude seat's rig-body guard can run. A Claude seat is launched with one
// `--settings` JSON whose Bash PreToolUse hook runs the guard as `/bin/sh -c <wrapper> sh <node> <guard script> <seconds>`
// (claudeRigBodyGuardGroup in the daemon). When that node or script is gone (a node upgrade removes the daemon's node from
// under every seat; a package directory is replaced), the wrapper falls to its degraded check and refuses every kill and
// every rig body with a substitution. This row says so before a refusal does. The paths are read from each seat's own
// command line, so a seat launched by an older daemon is judged by what it actually runs. Pure: the caller reads the
// processes and passes the file checks.
import path from "node:path";
import type { SeatProcess } from "./seat-path-head.js";

export interface SeatGuardPaths { node: string; script: string }

const QUOTED = String.raw`'((?:'"'"'|[^'])*)'`;
const GUARD_TAIL = new RegExp(String.raw` sh ${QUOTED} ${QUOTED} (\d+)$`);
const unquote = (s: string): string => s.split(`'"'"'`).join("'");

/** The guard's node and script from a Claude command line (`--settings <json>` or `--settings=<json>`); null when it carries no guard hook. */
export function guardPathsFromArgv(argv: readonly string[]): SeatGuardPaths | null {
  let raw: string | undefined;
  argv.forEach((a, i) => {
    if (a === "--settings") raw = argv[i + 1];
    else if (a.startsWith("--settings=")) raw = a.slice("--settings=".length);
  });
  if (raw === undefined) return null;
  let settings: unknown;
  try { settings = JSON.parse(raw); } catch { return null; }
  const groups = (settings as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    const hooks = (group as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const command = (hook as { command?: unknown } | null)?.command;
      if (typeof command !== "string" || !command.startsWith("/bin/sh -c ")) continue;
      const m = GUARD_TAIL.exec(command);
      if (!m) continue;
      const script = unquote(m[2]!);
      if (path.basename(script) !== "rig-body-guard.cjs") continue;
      return { node: unquote(m[1]!), script };
    }
  }
  return null;
}

export interface SeatGuardFiles {
  /** An executable regular file (the wrapper tests `-x`). */
  isExecutable: (file: string) => boolean;
  /** A regular file (the wrapper tests `-f`). */
  isFile: (file: string) => boolean;
}

/** The doctor row. `null` processes: this platform's process command lines cannot be read, so nothing is claimed. */
export function buildSeatGuardCheck(
  processes: SeatProcess[] | null,
  openrigHome: string,
  files: SeatGuardFiles,
): { name: string; status: "pass" | "warn" | "skipped"; message: string } {
  const name = "running_seats_guard";
  if (processes === null) {
    return { name, status: "skipped", message: "Seat guard not checked: process command lines are read from /proc, which this platform does not have." };
  }
  const home = path.resolve(openrigHome);
  const seats = new Map<string, string[]>();
  for (const p of processes) {
    if (p.home === null || path.resolve(p.home) !== home) continue;
    const paths = guardPathsFromArgv(p.argv ?? []);
    if (paths === null) continue;
    const missing: string[] = [];
    if (!files.isExecutable(paths.node)) missing.push(`node ${paths.node}`);
    if (!files.isFile(paths.script)) missing.push(`guard script ${paths.script}`);
    seats.set(p.session, [...(seats.get(p.session) ?? []), ...missing]);
  }
  if (seats.size === 0) return { name, status: "skipped", message: `Seat guard not checked: no Claude seat of ${home} on this host carries the guard.` };
  const down = [...seats].filter(([, missing]) => missing.length > 0).sort(([a], [b]) => a.localeCompare(b));
  if (down.length === 0) {
    return { name, status: "pass", message: `${seats.size} Claude ${seats.size === 1 ? "seat" : "seats"} of ${home} on this host can run the seat guard (its node and script are there).` };
  }
  return {
    name,
    status: "warn",
    message: `seat guard unavailable on ${down.length} of ${seats.size} Claude ${seats.size === 1 ? "seat" : "seats"} of ${home}: `
      + down.map(([session, missing]) => `${session} (missing: ${[...new Set(missing)].join(", ")})`).join("; ")
      + ". While it is down, every kill command and every rig body with a substitution is refused. Relaunch or restore the seat.",
  };
}
