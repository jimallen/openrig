// Tripwire for private hc cores (hc cutover, package W8; census-hc-tmux section 4, layer 2, adapted to hc).
//
// A test that needs a core starts one through `packages/daemon/test/helpers/hc-scratch.ts`: a short root
// `<base>/hcs-xxxxxx` holding the core's HOME, XDG paths and socket. `cleanup()` removes that root only AFTER it
// verified the core, its holders and its terminal programs are gone, and throws, keeping the root, when it cannot. So a
// root that is still on disk when the run ends means a test never cleaned up or cleanup could not verify. This module
// finds those roots at the end of the run (hermetic-env.global.ts `teardown`), so a leaked private core is a red run,
// not a quiet process on the machine.
//
// What it does not do, stated here as the other hermetic guards state theirs:
//  - It reports; it kills nothing and removes nothing. The orphan guard armed by hc-scratch is what reaps, and the
//    leftover root is the evidence.
//  - It sees only roots in the scan base (default /tmp, the base hc-scratch uses unless a test passes `baseDir`). A test
//    that passes another `baseDir` is outside this net.
//  - Another vitest run on the same machine may have a scratch core of its own at this moment. Such a root is not this
//    run's leak and is skipped, but only when the owner can be shown to be alive and outside this run's process tree: the
//    orphan guard's argv carries its owner pid (`reaper:hc-scratch <owner>`), and on Linux also `HC_SESSION=<session>`,
//    which links it to one root. Where the link cannot be made (no session in argv, i.e. off Linux) and any foreign live
//    guard exists, every candidate root is treated as possibly foreign: the tripwire stays silent rather than blaming a
//    concurrent run. That is a missed leak, never a false failure; it is reported in `unattributed`.
//  - A root created before this run started is not this run's.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const HC_SCRATCH_ROOT_PREFIX = "hcs-";
export const HC_SCRATCH_REAPER_LABEL = "reaper:hc-scratch";

export interface ProcessTable {
  /** pid -> parent pid, for every process `ps` listed. */
  parents: Map<number, number>;
  /** The full `ps` args text, searched for orphan-guard argv. May hold newlines (the guard's argv is a shell script). */
  argsText: string;
}

export interface TripwireInputs {
  /** Directory holding scratch roots. */
  scanBase: string;
  /** Epoch ms the run started; roots born earlier are not this run's. */
  runStartedMs: number;
  /** The run's main process; descendants of it are this run's workers. */
  mainPid: number;
  processes: ProcessTable;
  /** Whether a pid is alive. */
  alive: (pid: number) => boolean;
}

export interface TripwireFindings {
  /** Roots left behind by this run's tests: the failure. */
  leaked: string[];
  /** Candidate roots the tripwire could not rule foreign (silent, listed for the log). */
  unattributed: string[];
  /** Roots it attributed to another live run and skipped. */
  foreign: string[];
}

/** `ps` snapshot. A failure to list processes throws: a guard that cannot look must not report clean. */
export function readProcessTable(): ProcessTable {
  const tree = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const parents = new Map<number, number>();
  for (const line of tree.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) parents.set(Number(m[1]), Number(m[2]));
  }
  const argsText = execFileSync("ps", ["-axww", "-o", "args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { parents, argsText };
}

export const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const descendantOf = (parents: Map<number, number>, pid: number, ancestor: number): boolean => {
  const seen = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && !seen.has(at); at = parents.get(at)) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
};

/** Every orphan guard `hc-scratch` armed: its owner pid and, when argv carries it, the session it watches. */
function hcScratchGuards(argsText: string): Array<{ owner: number; sessions: string[] }> {
  const guards: Array<{ owner: number; sessions: string[] }> = [];
  const re = new RegExp(`${HC_SCRATCH_REAPER_LABEL} (\\d+)((?: env HC_SESSION=[a-z0-9]+)*)`, "g");
  for (const m of argsText.matchAll(re)) {
    const sessions = [...(m[2] ?? "").matchAll(/HC_SESSION=([a-z0-9]+)/g)].map((s) => s[1]!);
    guards.push({ owner: Number(m[1]), sessions });
  }
  return guards;
}

/** The session name hc-scratch derives from a root's directory name (`sessionOf` mirrors hc-scratch.ts: `s` + last six, lowercased). */
export const sessionOfRoot = (rootName: string): string => `s${rootName.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "0")}`;

export function findLeakedHcScratch(input: TripwireInputs): TripwireFindings {
  const findings: TripwireFindings = { leaked: [], unattributed: [], foreign: [] };
  let names: string[];
  try { names = fs.readdirSync(input.scanBase); } catch { return findings; }
  const guards = hcScratchGuards(input.processes.argsText);
  const foreignGuards = guards.filter(
    (g) => input.alive(g.owner) && !descendantOf(input.processes.parents, g.owner, input.mainPid),
  );
  for (const name of names) {
    if (!name.startsWith(HC_SCRATCH_ROOT_PREFIX)) continue;
    const root = path.join(input.scanBase, name);
    let born: number;
    try {
      const st = fs.statSync(root);
      if (!st.isDirectory()) continue;
      born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
    } catch { continue; }
    if (born < input.runStartedMs) continue;
    const session = sessionOfRoot(name);
    const linked = foreignGuards.some((g) => g.sessions.includes(session));
    if (linked) { findings.foreign.push(root); continue; }
    const linkable = guards.some((g) => g.sessions.length > 0);
    if (foreignGuards.length > 0 && !linkable) { findings.unattributed.push(root); continue; }
    findings.leaked.push(root);
  }
  findings.leaked.sort();
  findings.unattributed.sort();
  findings.foreign.sort();
  return findings;
}

export function describeLeak(findings: TripwireFindings): string {
  return (
    `hc scratch tripwire: ${findings.leaked.length} private hc core root(s) were left behind by this run: ` +
    `${findings.leaked.join(", ")}. hc-scratch removes its root only after it verified the core stopped, so a test did not ` +
    `call cleanup() or cleanup could not verify. A core may still be running (its HC_SESSION is s + the last six characters ` +
    `of the directory name); the orphan guard reaps it when its owner dies, the root is kept as evidence.`
  );
}
