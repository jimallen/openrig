import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * A test that starts a process which outlives the test runner (a tmux server, a daemon the CLI detaches) must not rely on
 * its own teardown alone: a vitest timeout, a killed worker or a swallowed stop failure never reaches it, and the process
 * then runs for days after its temp home is deleted.
 *
 * IDENTITY. A pid alone is not an identity (it can be stale or reused), and another process's environment cannot be read on
 * every platform (on macOS `ps -Ewwo` shows a same-user process's environment only for an unprotected program such as `hc`;
 * measured at macOS 27: `hc hold` and `hc serve` showed theirs, a `sleep` under them showed none). So a process the test means to stop is RECORDED when
 * it is found: its pid, its start time and its command line (`ps -o lstart=`, `ps -o command=`: the same on Linux and macOS).
 * Every signal is preceded by a check that all three still match; a pid that now belongs to something else is left alone.
 * tmux servers are found through an explicit `-S` socket in a directory the test created (never tmux's shared per-user
 * directory, see `assertOwnedTmuxSocket`), and the server found there is recorded and checked the same way before a signal.
 *
 * `reapWhenOwnerDies` starts a tiny detached watchdog that waits for the OWNER (the test worker) to die and then stops the
 * recorded identities and the tmux servers on the listed sockets. `disarm()` removes it once the test's own teardown has run
 * and VERIFIED the stop.
 */
export interface ProcessIdentity { pid: number; started: string; command: string }

export interface OrphanReaperTargets {
  /** tmux servers this test started, by explicit socket path. */
  tmuxSockets?: string[];
  /** Processes recorded with `identityOf`; stopped only while pid, start time and command all still match. */
  identities?: ProcessIdentity[];
  /**
   * Linux (it reads /proc/<pid>/environ) and macOS (`ps -Ewwo`): exact `NAME=value` entries that only this test's processes
   * carry. Covers a window in which no identity is known yet (a `rig daemon start` still running), and a process started after
   * the guard was armed (a terminal's holder). On macOS only an unprotected program shows its environment, so the sweep also
   * takes every DESCENDANT of a process that does (a terminal's program under its holder). Refused loudly elsewhere.
   */
  environ?: string[];
  /** The process whose death triggers the reaping; default: this process. */
  ownerPid?: number;
  /** Test seam: which clock orders start times, "proc" (Linux, /proc ticks; the default there) or "ps" (`ps -o lstart=`; the default elsewhere). A Linux test can run the macOS arm with "ps". */
  startSource?: "proc" | "ps";
  /** Test seam: the process whose ancestors are protected besides the owner's (default: this process, the one that arms). */
  armerPid?: number;
  /** Test seam: the cap on one sweep's selection (default WATCHDOG_SELECTION_CAP). */
  maxSelected?: number;
  /** Test seam: a file descriptor for the watchdog's stderr (default: this process's stderr). */
  stderrFd?: number;
  /** Names the watchdog in its argument list (`reaper:<label>`), so a test can tell one helper's watchdog from another's. */
  label?: string;
}

export const hasProcFs = (): boolean => existsSync("/proc/self/environ");

/** Whether an environment entry can be swept on this platform: /proc on Linux, `ps -Ewwo` on macOS. */
export const canSweepEnviron = (): boolean => hasProcFs() || process.platform === "darwin";

/** The recorded identity of a live process, or null when there is none (gone, or ps cannot say). */
export function identityOf(pid: number): ProcessIdentity | null {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return started === "" || command === "" ? null : { pid, started, command };
  } catch { return null; }
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Still the recorded process: alive, and the same start time and command (so not a reused pid). */
export function sameProcess(id: ProcessIdentity): boolean {
  if (!processAlive(id.pid)) return false;
  const now = identityOf(id.pid);
  return now !== null && now.started === id.started && now.command === id.command;
}

/** Epoch ms of a `ps lstart` string (second resolution, local time). */
export const startedAtMs = (lstart: string): number => Date.parse(lstart);

/**
 * When a process started, in epoch ms, from the kernel's own clock: `starttime` (field 22 of /proc/<pid>/stat, in ticks of
 * 1/100 s since boot, the same CLOCK_BOOTTIME that /proc/uptime reports) set against `uptimeSeconds` read at `nowMs`. This
 * never goes through the boot time. `ps -o lstart=` does: it is /proc/stat `btime` (whole seconds, truncated) plus the same
 * start tick, cut to whole seconds again, so on Linux it can name a moment up to two seconds BEFORE the process started, by
 * an amount fixed for the boot (OF-219: 0.2 s on Sparky after its reboot onto kernel 7.0.0-1024-nvidia). null when `stat`
 * does not parse. The command name (field 2) may hold spaces and parentheses, so fields are counted after the LAST ")".
 */
export function procStartedAtMs(stat: string, uptimeSeconds: number, nowMs: number): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" "); // fields[0] is field 3 (state), so field 22 is fields[19]
  const ticks = Number(fields[19]);
  if (fields.length < 20 || !Number.isInteger(ticks) || ticks < 0 || !Number.isFinite(uptimeSeconds)) return null;
  return nowMs - (uptimeSeconds - ticks / 100) * 1000;
}

/** Read /proc for `pid`'s start (see `procStartedAtMs`); null off Linux, when the process is gone, or when it cannot be read. */
export function procStartedAtMsOf(pid: number): number | null {
  if (!hasProcFs()) return null;
  try {
    const before = Date.now();
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const after = Date.now();
    return procStartedAtMs(readFileSync(`/proc/${pid}/stat`, "utf8"), uptime, (before + after) / 2);
  } catch { return null; }
}

/** Error in `procStartedAtMs`: its 10 ms tick, the uptime read, and the clock moving between the two reads. */
const PROC_START_SLACK_MS = 50;

/**
 * Whether the process `id` started between `fromMs` and `toMs` (epoch ms). On Linux the answer comes from /proc, to within
 * `PROC_START_SLACK_MS`. Elsewhere only `ps`'s whole-second start is known (macOS reads it from the kernel's own process
 * record, with no boot time in between), so the window opens at the start of the second in which it began.
 */
export function startedWithin(id: ProcessIdentity, fromMs: number, toMs: number): boolean {
  const precise = procStartedAtMsOf(id.pid);
  if (precise !== null) return precise >= fromMs - PROC_START_SLACK_MS && precise <= toMs + PROC_START_SLACK_MS;
  const startedMs = startedAtMs(id.started);
  return startedMs >= Math.floor(fromMs / 1000) * 1000 && startedMs <= toMs;
}

/** Pids listening on a TCP port (lsof; present on Linux and macOS). Throws if it cannot be asked: never "none" by default. */
export function listenerPids(port: number): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    return out.split("\n").filter((l) => /^\d+$/.test(l.trim())).map(Number);
  } catch (error) {
    const e = error as { status?: number; code?: string };
    if (e.status === 1) return []; // lsof's own "nothing found"
    throw new Error(`cannot discover the listener on port ${port}: ${e.code ?? `lsof exit ${e.status}`}`);
  }
}

/**
 * OF-274. What the watchdog may signal is BOUNDED, on both platforms, by code shared between the Linux (/proc) and macOS (`ps -E`) selectors, because a selector that
 * widens (a mutant, a typo, an unexpected `ps` format) once signalled every user process on a laptop and ended the login session:
 *  (a) never a process that started before the owner (the owner's start is read at arming and passed in; a user session, loginwindow and launchd services all predate a test worker);
 *  (b) never pid 1, the watchdog itself, or an ancestor of the owner or of the process that armed it (their chains are read in TypeScript at arming and passed in: an owner that dies first cannot be read);
 *  (c) if one sweep selects more than `cap` processes, it signals none and writes ONE line to stderr.
 * Every PID signal the watchdog sends goes through `may_signal` and, for the selected sets, the cap: the env holders, the macOS family (descendants), and the recorded `pid` identities
 * (tmux servers among them). ONE path is outside both: `tmux -S <socket> kill-server`, on the TERM sweep, before the cap is evaluated. It selects no pid; it names a socket, and the socket was
 * checked once, at arming, by assertOwnedTmuxSocket (an absolute path that is not in tmux's shared per-user directory; that check does NOT require the path to be inside a directory the test
 * created, so the bound on this path is the callers' (scenario-daemon.ts, hermetic-env.ts, hc-scratch.ts pass their own scaffold sockets), not a start-time or ancestor test). The last line ends
 * the watchdog's own process group only if the watchdog IS its group's leader (it is spawned detached, so the group holds only the watchdog and its children); run any other way, it kills nothing.
 * An entry containing a backslash or a tab is never matched by the macOS (awk) selector (awk -v processes escapes, and index() treats only spaces as separators); that errs toward selecting fewer processes.
 * The ancestor chains are read at arming, and a failed parent read while building either of them refuses to arm (fail closed, as for the owner's start time) rather than protecting a shorter chain.
 *
 * Start times: Linux compares /proc/<pid>/stat field 22 (ticks since boot, exact). `ps -o lstart=` on Linux can name a moment up to two seconds before the process started (OF-219),
 * so it does not order processes there. Off Linux the same `ps -o lstart=` instrument as elsewhere, read under LC_ALL=C into civil seconds (second granularity, local time).
 * A process in the SAME second as the owner is allowed, and that is justified: the exposure is bounded (only processes created in that one second, which cannot be a login session or
 * a service that predates the worker, and the cap still holds), and it is needed (the processes a test starts for itself can begin within a second of the stand-in owner it started
 * just before). The residue: a local-time change inside the window (a DST fall-back hour) can order two processes the wrong way; the cap bounds it.
 */
export const WATCHDOG_SELECTION_CAP = 32;

/** awk: `ps -o lstart=` ("Sat Nov  7 18:27:03 2026") on stdin -> civil seconds on stdout, and nothing when it does not parse. Exported so a test runs the very program the watchdog runs. */
export const LSTART_TO_SECONDS_AWK = `{ if (NF != 5 || $4 !~ /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$/ || $5 !~ /^[0-9][0-9][0-9][0-9]$/ || $3 !~ /^[0-9][0-9]?$/) exit
  mi = index("JanFebMarAprMayJunJulAugSepOctNovDec", $2); if (mi == 0 || (mi - 1) % 3 != 0) exit
  m = (mi - 1) / 3 + 1; y = $5 + 0; d = $3 + 0; if (m <= 2) y -= 1
  era = int(y / 400); yoe = y - era * 400; doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy; days = era * 146097 + doe - 719468
  split($4, t, ":"); printf "%.0f\\n", days * 86400 + t[1] * 3600 + t[2] * 60 + t[3] }`;

// `kill-server` runs in the background: against a stopped (starved) server the client never returns, and a watchdog waiting
// on it would never reach the targets after it.
export const WATCHDOG = `LC_ALL=C; export LC_ALL
owner=$1; ownerstart=$2; startsrc=$3; cap=$4; armed=$5; shift 5
protected=" 1 $$ $armed "
lstart_key() { awk '${LSTART_TO_SECONDS_AWK}'; }
startkey() {
  case "$startsrc" in
    proc) sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{ print $20 }' ;;
    *) ps -o lstart= -p "$1" 2>/dev/null | lstart_key ;;
  esac
}
may_signal() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -gt 1 ] || return 1
  case "$protected" in *" $1 "*) return 1 ;; esac
  [ -n "$ownerkey" ] || return 1
  k=$(startkey "$1"); case "$k" in ''|*[!0-9]*) return 1 ;; esac
  [ "$k" -ge "$ownerkey" ]
}
while kill -0 "$owner" 2>/dev/null; do sleep 1; done
# Read once the owner is gone, not at start: a forked subshell shows the watchdog's own argument list, and a test counts watchdogs by it.
case "$startsrc" in proc) ownerkey=$ownerstart ;; *) ownerkey=$(printf '%s\\n' "$ownerstart" | lstart_key) ;; esac
case "$ownerkey" in ''|*[!0-9]*) ownerkey= ;; esac
same() { [ "$(ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$2" ] && [ "$(ps -o command= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$3" ]; }
holders() {
  if [ -r /proc/self/environ ]; then
    for e in /proc/[0-9]*/environ; do
      p=\${e#/proc/}; p=\${p%/environ}
      [ "$p" = "$$" ] && continue
      tr '\\0' '\\n' < "$e" 2>/dev/null | grep -qxF -- "$1" && echo "$p"
    done
  else
    # awk picks the lines that name the entry; a shell read loop over this output (every process's whole environment, megabytes on a busy Mac) took seconds of CPU
    # per call, three calls per watchdog, so the first TERM went out 7 to 9 s after the owner died (OF-261).
    ps -axEwwo pid=,command= 2>/dev/null | awk -v self="$$" -v want=" $1 " '{ line = $0; sub(/^ *[0-9]+ +/, "", line); if ($1 != self && index(" " line " ", want) > 0) print $1 }' | while read -r p; do
      case " $(ps -o command= -p "$p" 2>/dev/null) " in *" $1 "*) continue ;; esac
      echo "$p"
    done
  fi
}
family() {
  [ -r /proc/self/environ ] && return 0
  seeds=$(holders "$1" | tr '\\n' ' ')
  [ -n "$seeds" ] || return 0
  ps -axo pid=,ppid= 2>/dev/null | awk -v seeds="$seeds" 'BEGIN { n = split(seeds, a, " "); for (i = 1; i <= n; i++) mark[a[i]] = 1 }
    { pp[$1] = $2; order[NR] = $1 }
    END { do { ch = 0; for (i = 1; i <= NR; i++) { p = order[i]; if (!(p in mark) && (pp[p] in mark)) { mark[p] = 1; ch = 1 } } } while (ch); for (p in mark) print p }' |
  while read -r p; do echo "$p|$(ps -o lstart= -p "$p" 2>/dev/null | sed 's/^ *//;s/ *$//')"; done
}
# Off Linux a terminal's program shows no environment: record the family while its holder is still alive, select it by pid and start time.
famtake() {
  while [ $# -gt 0 ]; do
    case "$1" in
      env) fam="$fam
$(family "$2")"; shift 2 ;;
      tmux) shift 2 ;;
      pid) shift 4 ;;
      *) shift ;;
    esac
  done
}
tmuxkill() {
  while [ $# -gt 0 ]; do
    case "$1" in
      tmux) tmux -S "$2" kill-server >/dev/null 2>&1 & shift 2 ;;
      env) shift 2 ;;
      pid) shift 4 ;;
      *) shift ;;
    esac
  done
}
selected() {
  while [ $# -gt 0 ]; do
    case "$1" in
      tmux) shift 2 ;;
      env)
        holders "$2"
        printf '%s\\n' "$fam" | while IFS='|' read -r p st; do
          [ -n "$p" ] && [ "$(ps -o lstart= -p "$p" 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$st" ] && echo "$p"
        done
        shift 2 ;;
      pid) if same "$2" "$3" "$4"; then echo "$2"; fi; shift 4 ;;
      *) shift ;;
    esac
  done
}
sweep() {
  sig=$1; shift
  if [ "$sig" = TERM ]; then famtake "$@"; tmuxkill "$@"; fi
  list=$(selected "$@" | sort -un)
  n=0; for p in $list; do n=$((n + 1)); done
  if [ "$n" -gt "$cap" ]; then
    echo "reaper: $n processes selected for $sig, more than the cap of $cap; signalling none" >&2
    return 0
  fi
  for p in $list; do may_signal "$p" && kill -$sig "$p" 2>/dev/null; done
  return 0
}
fam=
sweep TERM "$@"
sleep 3
sweep KILL "$@"
[ "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')" = "$$" ] && kill -KILL 0
exit 0
`;

/** The token the watchdog compares start times against, read for `pid` NOW (at arming, while the owner lives): /proc stat field 22 on Linux, `ps -o lstart=` under LC_ALL=C elsewhere. "" when unreadable. */
export function startToken(pid: number, source: "proc" | "ps"): string {
  if (source === "proc") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const field = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
      return /^\d+$/.test(field) ? field : "";
    } catch { return ""; }
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, " ") : "";
}

/** The parent of `pid` now (null when unreadable): /proc stat field 4 for source "proc", `ps -o ppid=` for "ps". */
function parentOf(pid: number, source: "proc" | "ps"): number | null {
  if (source === "proc") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return Number.isInteger(ppid) ? ppid : null;
    } catch { return null; }
  }
  const r = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  const ppid = Number(r.stdout.trim());
  return r.status === 0 && r.stdout.trim() !== "" && Number.isInteger(ppid) ? ppid : null;
}

/**
 * `pid` and its ancestors up to (not including) pid 1, read at arming, while the owner is alive: the watchdog must never signal them (OF-274 b). Passed in, because the watchdog cannot read an
 * owner that dies first. A parent that cannot be read THROWS: a chain shortened by one failed `ps` would silently protect less, so the watchdog is not armed instead.
 */
export function ancestorsOf(pid: number, source: "proc" | "ps"): number[] {
  const chain: number[] = [];
  for (let p = pid; p > 1 && chain.length < 64 && !chain.includes(p);) {
    chain.push(p);
    const parent = parentOf(p, source);
    if (parent === null) throw new Error(`cannot read the parent of pid ${p} (while building the ancestors of pid ${pid}); the watchdog cannot show which processes it must never signal, so it is not armed`);
    p = parent;
  }
  return chain;
}

export function reapWhenOwnerDies(targets: OrphanReaperTargets): { disarm: () => void; pid: number } {
  for (const socket of targets.tmuxSockets ?? []) assertOwnedTmuxSocket(socket);
  if ((targets.environ?.length ?? 0) > 0 && !canSweepEnviron()) {
    throw new Error("environ-based reaping needs /proc (Linux) or `ps -E` (macOS); on this platform record process identities instead");
  }
  const owner = targets.ownerPid ?? process.pid;
  const source = targets.startSource ?? (hasProcFs() ? "proc" : "ps");
  const ownerStart = startToken(owner, source);
  if (ownerStart === "") throw new Error(`cannot read the start time of the owner (pid ${owner}); the watchdog signals nothing that it cannot show started after its owner, so it is not armed`);
  const args = [
    ...(targets.tmuxSockets ?? []).flatMap((socket) => ["tmux", socket]),
    ...(targets.environ ?? []).flatMap((entry) => ["env", entry]),
    ...(targets.identities ?? []).flatMap((id) => ["pid", String(id.pid), id.started, id.command]),
  ];
  const child = spawn("/bin/sh", ["-c", WATCHDOG, `reaper:${targets.label ?? "test"}`, String(owner), ownerStart, source, String(targets.maxSelected ?? WATCHDOG_SELECTION_CAP), [...new Set([...ancestorsOf(owner, source), ...ancestorsOf(targets.armerPid ?? process.pid, source)])].join(" "), ...args], {
    detached: true,
    // stdout is unused; stderr carries the one overflow line (to this process's own stderr unless a test gives a file).
    stdio: ["ignore", "ignore", targets.stderrFd ?? 2],
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not start the orphan reaper");
  return {
    pid,
    disarm: () => { try { process.kill(-pid, "SIGKILL"); } catch { /* already finished */ } },
  };
}

/** Linux only: whether process `pid` holds exactly `entry` in its environment (false when it cannot be read). */
export function hasEnvEntry(pid: number, entry: string): boolean {
  if (!hasProcFs()) throw new Error("hasEnvEntry needs /proc (Linux)");
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(entry); } catch { return false; }
}

/**
 * Processes whose environment holds exactly `entry`. On Linux, read from /proc. On macOS, from `ps -Ewwo` (the entry as a whole
 * space-delimited word after the command; a process whose own argument list carries the entry, such as a watchdog, is not a
 * holder), widened by every descendant of such a process, because a protected program (a terminal's `sleep`) shows no environment.
 */
export function pidsWithEnv(entry: string): number[] {
  if (!canSweepEnviron()) throw new Error("pidsWithEnv needs /proc (Linux) or `ps -E` (macOS)");
  if (!hasProcFs()) return pidsWithEnvDarwin(entry);
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(entry)) found.push(Number(name));
    } catch { /* gone, or not ours to read */ }
  }
  return found;
}

function pidsWithEnvDarwin(entry: string): number[] {
  const listing = spawnSync("ps", ["-axEwwo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  const argv = new Map<number, string>();
  for (const line of spawnSync("ps", ["-axwwo", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) argv.set(Number(m[1]), m[2]!);
  }
  const seeds = new Set<number>();
  for (const line of listing.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || !` ${m[2]} `.includes(` ${entry} `)) continue;
    if (` ${argv.get(pid) ?? ""} `.includes(` ${entry} `)) continue; // the entry is in its arguments, not its environment
    seeds.add(pid);
  }
  if (seeds.size === 0) return [];
  const parent = new Map<number, number>();
  for (const line of spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }
  const found = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!found.has(pid) && found.has(ppid) && pid !== process.pid) { found.add(pid); grew = true; }
  }
  return [...found];
}

export async function waitGone(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (processAlive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export async function waitNotSame(ids: ProcessIdentity[], withinMs: number): Promise<void> {
  const until = Date.now() + withinMs;
  while (ids.some(sameProcess) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * TERM, then KILL, each followed by `graceMs` of waiting, for recorded identities: a signal goes to a pid only while that
 * pid is still the recorded process. Returns the identities that are STILL the recorded process afterwards (survivors).
 */
export async function terminateIdentified(ids: ProcessIdentity[], graceMs: number): Promise<ProcessIdentity[]> {
  for (const id of ids) if (sameProcess(id)) { try { process.kill(id.pid, "SIGTERM"); } catch { /* gone */ } }
  await waitNotSame(ids, graceMs);
  for (const id of ids) if (sameProcess(id)) { try { process.kill(id.pid, "SIGKILL"); } catch { /* gone */ } }
  await waitNotSame(ids, graceMs);
  return ids.filter(sameProcess);
}

const NO_SERVER = /no server running|error connecting to|no such file or directory|failed to connect/i;

export interface TmuxCallResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * Run one tmux client command with a HARD bound. `execFile`'s timeout is not enough against a stopped (SIGSTOPped) server:
 * a tmux client hands its stdout/stderr descriptors to the server, so while the server is stopped the pipes never close and
 * `execFile` never calls back (measured on macOS: the test hung to its 60 s limit), and a SIGTERMed client exits 0 as if
 * it had succeeded. Here the client gets stdio it can pass on without consequence being waited for: the call settles on the
 * client's own `exit` (after a brief drain), a timeout SIGKILLs the client and is reported as `timedOut`, and the pipes are
 * destroyed rather than awaited.
 */
export function tmuxCall(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<TmuxCallResult> {
  return new Promise((resolve) => {
    let client: ChildProcess;
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.stdout?.destroy();
      client.stderr?.destroy();
      resolve({ code, signal, stdout, stderr, timedOut });
    };
    client = spawn("tmux", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; try { client.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    client.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    client.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    client.once("error", (error) => { stderr += error.message; finish(null, null); });
    client.once("exit", (code, signal) => { setTimeout(() => finish(code, signal), 50); });
  });
}

/**
 * `tmuxCall`, synchronously, for teardown that cannot await (the hermetic scaffold's `cleanup()`). The client writes into
 * files, not pipes: a client of a stopped server hands its descriptors to that server, and a synchronous spawn would wait on
 * pipes that never close. A timeout SIGKILLs the client and is reported as `timedOut`.
 */
export function tmuxCallSync(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): TmuxCallResult {
  const dir = mkdtempSync(join(tmpdir(), "tmux-call-"));
  const outPath = join(dir, "out"), errPath = join(dir, "err");
  const out = openSync(outPath, "w"), err = openSync(errPath, "w");
  try {
    const r = spawnSync("tmux", args, { env, stdio: ["ignore", out, err], timeout: timeoutMs, killSignal: "SIGKILL" });
    const failure: NodeJS.ErrnoException | undefined = r.error;
    const timedOut = failure?.code === "ETIMEDOUT";
    const stderr = readFileSync(errPath, "utf8") + (failure && !timedOut ? failure.message : "");
    return { code: r.status, signal: r.signal, stdout: readFileSync(outPath, "utf8"), stderr, timedOut };
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(dir, { recursive: true, force: true });
  }
}

const realpathOr = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/**
 * tmux's shared per-user socket directories, taken from this process's environment when the module loads (before any test
 * stubs it): the default server and every run's `-L` servers live there, so no test owns a socket in them.
 */
const SHARED_TMUX_DIRS: ReadonlySet<string> = new Set(
  ["/tmp", tmpdir(), process.env.TMUX_TMPDIR ?? ""].filter((base) => base !== "")
    .map((base) => join(realpathOr(base), `tmux-${process.getuid?.() ?? 0}`)),
);

/**
 * Refuse, before any tmux command is sent, a socket a test must never stop: a `-L` name or a relative path (tmux resolves
 * those in a shared directory), or any socket in tmux's shared per-user directory. An owned socket is an explicit `-S` path
 * inside a directory the test created.
 */
export function assertOwnedTmuxSocket(socket: string): void {
  if (!isAbsolute(socket)) {
    throw new Error(`refusing to stop tmux on "${socket}": not an absolute -S path (a -L name or a relative path selects a shared socket directory)`);
  }
  const dir = realpathOr(dirname(socket));
  if (SHARED_TMUX_DIRS.has(dir)) {
    throw new Error(`refusing to stop tmux on ${socket}: ${dir} is tmux's shared per-user socket directory (the default server and other runs' -L servers), not one this test created`);
  }
}

/**
 * The explicit socket of the default server a test starts with `TMUX_TMPDIR` pointed at its own directory: tmux's rule is
 * `<realpath of TMUX_TMPDIR>/tmux-<uid>/default` (pinned against tmux's own `#{socket_path}` in orphan-reaper.test.ts).
 */
export const ownedDefaultSocket = (tmuxTmpDir: string): string =>
  join(realpathSync(tmuxTmpDir), `tmux-${process.getuid?.() ?? 0}`, "default");

type PidAnswer = { pid: number } | { absent: true } | { unknown: string };

/** One `display-message -p #{pid}` answer: the pid, a positive "no server", or anything else (never read as "none"). */
function pidAnswer(r: TmuxCallResult, commandTimeoutMs: number): PidAnswer {
  const out = r.stdout.trim();
  if (!r.timedOut && r.code === 0 && /^\d+$/.test(out)) return { pid: Number(out) };
  if (!r.timedOut && r.code !== 0 && NO_SERVER.test(r.stderr)) return { absent: true };
  return { unknown: r.timedOut ? `no answer within ${commandTimeoutMs} ms` : `exit ${r.code ?? r.signal}: ${(r.stderr || out).split("\n")[0]}` };
}

const pidLookupFailed = (socket: string, last: string) =>
  new Error(`the tmux server on ${socket} could not be located, so it cannot be verified stopped: ${last}`);

/**
 * The pid of the tmux server on `socket`: null only when tmux positively says there is none. A timeout or any other failure
 * (a starved server) is retried and then THROWN, never read as "no server": a caller that deletes the socket directory on a
 * silent "nothing to stop" orphans the live server.
 */
export async function tmuxServerPid(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): Promise<number | null> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = pidAnswer(await tmuxCall(["-S", socket, "display-message", "-p", "#{pid}"], env, commandTimeoutMs), commandTimeoutMs);
    if ("pid" in a) return a.pid;
    if ("absent" in a) return null;
    last = a.unknown;
  }
  throw pidLookupFailed(socket, last);
}

/** `tmuxServerPid`, synchronously. */
export function tmuxServerPidSync(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): number | null {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = pidAnswer(tmuxCallSync(["-S", socket, "display-message", "-p", "#{pid}"], env, commandTimeoutMs), commandTimeoutMs);
    if ("pid" in a) return a.pid;
    if ("absent" in a) return null;
    last = a.unknown;
  }
  throw pidLookupFailed(socket, last);
}

/**
 * The tmux server on an owned `socket`, as a recorded identity (pid + start time + command, see `identityOf`), or null when
 * tmux positively says there is none (or the server it named has already exited). Record it when the server starts, so a
 * later stop never signals a pid that has since been reused.
 */
export async function ownedTmuxServer(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): Promise<ProcessIdentity | null> {
  assertOwnedTmuxSocket(socket);
  const pid = await tmuxServerPid(socket, env, commandTimeoutMs);
  return pid === null ? null : identityOf(pid);
}

/** `ownedTmuxServer`, synchronously. */
export function ownedTmuxServerSync(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): ProcessIdentity | null {
  assertOwnedTmuxSocket(socket);
  const pid = tmuxServerPidSync(socket, env, commandTimeoutMs);
  return pid === null ? null : identityOf(pid);
}

export interface TmuxStopOptions {
  /** The server recorded when it was started (`ownedTmuxServer`); looked up through the socket if absent. */
  server?: ProcessIdentity;
  /** Bound on each tmux command (default 30 s). */
  commandTimeoutMs?: number;
  /** How long to wait for the server to exit after `kill-server`, and again after SIGKILL (default 15 s). */
  graceMs?: number;
}

const stillAliveAfterKill = (server: ProcessIdentity, socket: string) =>
  new Error(`the tmux server (pid ${server.pid}) on ${socket} is still alive after SIGKILL`);
const keepsAnswering = (socket: string) =>
  new Error(`a tmux server still answers on ${socket} after it was stopped three times`);

/**
 * Stop the tmux server this test started on its OWNED `socket` (an explicit `-S` path in a directory the test created; see
 * `assertOwnedTmuxSocket`) and prove it is gone, or throw: the caller must then keep its watchdog armed and its socket
 * directory in place. `kill-server` is bounded; a server still alive after it is SIGKILLed, but only while it is still the
 * recorded process (same pid, start time and command), so a reused pid is never signalled. Done only when tmux itself says
 * no server answers on the socket: a server started there after the one recorded is stopped too.
 */
export async function stopOwnedTmuxServer(socket: string, env: NodeJS.ProcessEnv, options: TmuxStopOptions = {}): Promise<void> {
  assertOwnedTmuxSocket(socket);
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000, graceMs = options.graceMs ?? 15_000;
  let server = options.server ?? await ownedTmuxServer(socket, env, commandTimeoutMs);
  for (let round = 0; round < 3; round++) {
    if (server !== null && sameProcess(server)) {
      await tmuxCall(["-S", socket, "kill-server"], env, commandTimeoutMs);
      await waitNotSame([server], graceMs);
      if (sameProcess(server)) {
        try { process.kill(server.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
        await waitNotSame([server], graceMs);
        if (sameProcess(server)) throw stillAliveAfterKill(server, socket);
      }
    }
    server = await ownedTmuxServer(socket, env, commandTimeoutMs);
    if (server === null) return;
  }
  throw keepsAnswering(socket);
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitNotSameSync(ids: ProcessIdentity[], withinMs: number): void {
  const until = Date.now() + withinMs;
  while (ids.some(sameProcess) && Date.now() < until) sleepSync(25);
}

/** `stopOwnedTmuxServer`, synchronously, for teardown that cannot await (the same checks, the same refusals). */
export function stopOwnedTmuxServerSync(socket: string, env: NodeJS.ProcessEnv, options: TmuxStopOptions = {}): void {
  assertOwnedTmuxSocket(socket);
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000, graceMs = options.graceMs ?? 15_000;
  let server = options.server ?? ownedTmuxServerSync(socket, env, commandTimeoutMs);
  for (let round = 0; round < 3; round++) {
    if (server !== null && sameProcess(server)) {
      tmuxCallSync(["-S", socket, "kill-server"], env, commandTimeoutMs);
      waitNotSameSync([server], graceMs);
      if (sameProcess(server)) {
        try { process.kill(server.pid, "SIGKILL"); } catch { /* gone meanwhile */ }
        waitNotSameSync([server], graceMs);
        if (sameProcess(server)) throw stillAliveAfterKill(server, socket);
      }
    }
    server = ownedTmuxServerSync(socket, env, commandTimeoutMs);
    if (server === null) return;
  }
  throw keepsAnswering(socket);
}
