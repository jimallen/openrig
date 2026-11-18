// workspaces-o9o.184 (verify-sec review): the ONE place twin:a11y decides which processes it may signal and which folder it
// may remove. No signal goes to a pid without proof that it is this run's: a process is Chrome's only while one of its
// arguments is exactly `--user-data-dir=<this run's profile>`, and its start time is read again right before each signal.
// No folder is removed unless it is this run's profile: a mkdtemp child named twin-a11y-XXXXXX directly in the temp folder the
// run used, a real directory owned by this user. No shell is involved, so no pattern ever reaches one.
//
// Run directly, it is the owner-death reaper: `node owned-chrome.ts reap-when-gone <ownerPid> <ownerStart> <profile> <tmpRoot>`.
// The scanner starts it BEFORE Chrome, with its own identity already captured, then writes `chrome <pid> <start>` to its stdin
// right after spawning Chrome. A scanner that dies before the reaper's first look is still seen as gone (its start time no
// longer matches, and its end of the stdin pipe closes); one that dies before handing over Chrome's identity still has its
// Chrome reaped by the exact profile flag, which Chrome's own process carries (measured: every process of the tree).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ProcessIdentity { pid: number; start: string }

const PROFILE_NAME = /^twin-a11y-[A-Za-z0-9]{6}$/;

/** The start time of `pid`, or "" when it is gone: /proc's start ticks on Linux, `ps -o lstart=` elsewhere. Compared only with itself. */
export function startToken(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  if (existsSync("/proc/self/stat")) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return `proc:${stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] ?? ""}`;
    } catch { return ""; }
  }
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return out.status === 0 && out.stdout.trim() ? `ps:${out.stdout.trim()}` : "";
}

/**
 * The arguments of `pid` as whitespace-separated tokens. Chrome rewrites its process title, so its whole command line is one
 * NUL-terminated string (measured on Linux, Playwright chromium-1243: every process of the tree); splitting on whitespace as
 * well as NUL gives its arguments back. A profile path holds no whitespace (validProfile), so one token is the whole flag.
 */
export function argTokens(pid: number): string[] {
  if (existsSync("/proc/self/cmdline")) {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0\s]+/).filter(Boolean); } catch { return []; }
  }
  const out = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim().split(/\s+/).filter(Boolean) : [];
}

/** Whether `pid` is one of this run's Chrome processes: one argument is exactly `--user-data-dir=<profile>`. */
export function holdsProfile(pid: number, profile: string): boolean {
  return argTokens(pid).includes(`--user-data-dir=${profile}`);
}

/** Why `profile` is not this run's profile, or null when it is (see the header). Checked before any selection or removal. */
export function profileProblem(profile: string, tmpRoot: string): string | null {
  if (typeof profile !== "string" || profile === "") return "the profile path is empty";
  if (!path.isAbsolute(profile) || !path.isAbsolute(tmpRoot)) return `the profile path is not absolute: ${profile}`;
  if (/\s/.test(profile)) return `the profile path holds whitespace: ${profile}`;
  if (path.dirname(profile) !== path.resolve(tmpRoot)) return `the profile is not directly in the run's temp folder ${tmpRoot}: ${profile}`;
  if (!PROFILE_NAME.test(path.basename(profile))) return `the profile is not named twin-a11y-XXXXXX: ${profile}`;
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(profile); } catch { return `the profile does not exist: ${profile}`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `the profile is not a real directory: ${profile}`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `the profile is not owned by this user: ${profile}`;
  return null;
}

/** This run's Chrome processes now, each with its start time, found by the exact profile flag. Never this process itself. */
export function profileHolders(profile: string): ProcessIdentity[] {
  const out = spawnSync("ps", ["-axo", "pid="], { encoding: "utf8" }).stdout ?? "";
  const found: ProcessIdentity[] = [];
  for (const line of out.split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!holdsProfile(pid, profile)) continue;
    const start = startToken(pid);
    if (start) found.push({ pid, start });
  }
  return found;
}

/**
 * Signal `id` only if it is still the same process (its start time unchanged) and, when `profile` is given, still holds that
 * exact profile flag: both read again right before the signal. True when the signal was sent.
 */
export function signalIfStill(id: ProcessIdentity, signal: NodeJS.Signals, profile: string | null): boolean {
  if (startToken(id.pid) !== id.start) return false;
  if (profile !== null && !holdsProfile(id.pid, profile)) return false;
  try { process.kill(id.pid, signal); return true; } catch { return false; }
}

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Stop this run's Chrome (its own identity when given, and every process holding the exact profile flag), TERM then KILL,
 * then remove the profile. Refuses, signalling and removing nothing, unless the profile is this run's (profileProblem).
 */
export function reap(input: { profile: string; tmpRoot: string; chrome?: ProcessIdentity }): { refused: string | null; signalled: number } {
  const problem = profileProblem(input.profile, input.tmpRoot);
  if (problem !== null) return { refused: problem, signalled: 0 };
  let signalled = 0;
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    const holders = profileHolders(input.profile);
    const chromeAlive = input.chrome !== undefined && startToken(input.chrome.pid) === input.chrome.start;
    if (holders.length === 0 && !chromeAlive) break;
    if (chromeAlive && signalIfStill(input.chrome!, sig, null)) signalled++;
    for (const id of holders) if (signalIfStill(id, sig, input.profile)) signalled++;
    sleepSync(1000);
  }
  if (profileProblem(input.profile, input.tmpRoot) === null) rmSync(input.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { refused: null, signalled };
}

/** The reaper: wait until the owner (pid and start time, captured by the scanner) is gone, then reap. */
function reapWhenGone(argv: string[]): void {
  const [ownerPid, ownerStart, profile, tmpRoot] = argv;
  const owner: ProcessIdentity = { pid: Number(ownerPid), start: ownerStart ?? "" };
  if (!owner.start || !profile || !tmpRoot) return;
  let chrome: ProcessIdentity | undefined;
  let done = false;
  const check = () => {
    if (done || startToken(owner.pid) === owner.start) return;
    done = true;
    clearInterval(timer);
    reap({ profile, tmpRoot, ...(chrome ? { chrome } : {}) });
    process.exit(0);
  };
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => {
    pending += d;
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const m = /^chrome (\d+) (\S.*)$/.exec(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      if (m) chrome = { pid: Number(m[1]), start: m[2]! };
    }
  });
  process.stdin.on("end", check); // the scanner's end of the pipe closed: look now, not at the next tick
  process.stdin.on("error", check);
  const timer = setInterval(check, 1000);
  check();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "reap-when-gone") {
  reapWhenGone(process.argv.slice(3));
}
