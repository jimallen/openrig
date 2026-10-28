import { execFile, execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A test that starts a process which outlives the test runner (a tmux server, a daemon the CLI detaches) must not rely on
 * its own teardown alone: a vitest timeout, a killed worker or a swallowed stop failure never reaches it, and the process
 * then runs for days after its temp home is deleted. `reapWhenOwnerDies` starts a tiny detached watchdog that waits for
 * the OWNER (the test worker) to die and then stops exactly what it was told to:
 *   - the tmux server on each listed socket (an explicit private path), and
 *   - every process whose environment holds a listed `NAME=value` entry exactly (the test's private OPENRIG_HOME): TERM,
 *     then KILL for those still carrying it. The identity is the private path, never a pid read from a file that could be
 *     stale or reused, and never a name pattern.
 * `disarm()` removes it once the test's own teardown has run and verified the stop.
 */
export interface OrphanReaperTargets {
  /** tmux servers this test started, by explicit socket path. */
  tmuxSockets?: string[];
  /** Exact `NAME=value` environment entries that only this test's processes carry. */
  environ?: string[];
  /** The process whose death triggers the reaping; default: this process. */
  ownerPid?: number;
}

const WATCHDOG = `owner=$1; shift
while kill -0 "$owner" 2>/dev/null; do sleep 1; done
holders() {
  if [ -d /proc/self ]; then
    for e in /proc/[0-9]*/environ; do
      p=\${e#/proc/}; p=\${p%/environ}
      [ "$p" = "$$" ] && continue
      tr '\\0' '\\n' < "$e" 2>/dev/null | grep -qxF -- "$1" && echo "$p"
    done
  else
    ps -axE -o pid=,command= 2>/dev/null | grep -F -- " $1" | while read -r p rest; do [ "$p" = "$$" ] || echo "$p"; done
  fi
}
for a in "$@"; do
  case "$a" in
    tmux:*) tmux -S "\${a#tmux:}" kill-server 2>/dev/null ;;
    env:*) for p in $(holders "\${a#env:}"); do kill -TERM "$p" 2>/dev/null; done ;;
  esac
done
sleep 3
for a in "$@"; do
  case "$a" in
    env:*) for p in $(holders "\${a#env:}"); do kill -KILL "$p" 2>/dev/null; done ;;
  esac
done
`;

export function reapWhenOwnerDies(targets: OrphanReaperTargets): { disarm: () => void; pid: number } {
  const args = [
    ...(targets.tmuxSockets ?? []).map((socket) => `tmux:${socket}`),
    ...(targets.environ ?? []).map((entry) => `env:${entry}`),
  ];
  const child = spawn("/bin/sh", ["-c", WATCHDOG, "reaper", String(targets.ownerPid ?? process.pid), ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not start the orphan reaper");
  return {
    pid,
    disarm: () => { try { process.kill(-pid, "SIGKILL"); } catch { /* already finished */ } },
  };
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Every process (other than this one) whose environment holds exactly `entry` (`NAME=value`). Linux reads /proc; elsewhere `ps -E`. */
export function pidsWithEnv(entry: string): number[] {
  const found: number[] = [];
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(entry)) found.push(Number(name));
      } catch { /* gone, or not ours to read */ }
    }
    return found;
  } catch { /* no /proc: macOS, below */ }
  try {
    for (const line of execFileSync("ps", ["-axE", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n")) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (m && Number(m[1]) !== process.pid && m[2]!.split(" ").includes(entry)) found.push(Number(m[1]));
    }
  } catch { /* no ps either */ }
  return found;
}

/** Whether `pid` is a live process carrying exactly `entry` in its environment: the identity check before any signal. */
export function processHasEnv(pid: number, entry: string): boolean {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(entry); } catch { /* no /proc entry: macOS, below */ }
  try { return execFileSync("ps", ["-E", "-p", String(pid), "-o", "command="], { encoding: "utf8" }).split(" ").includes(entry); } catch { return false; }
}

export async function waitGone(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (processAlive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** TERM, then KILL, each followed by `graceMs` of waiting, for processes this test has already identified as its own. */
export async function terminateOwned(pids: number[], graceMs: number): Promise<void> {
  const live = () => pids.filter(processAlive);
  for (const pid of live()) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  await Promise.all(pids.map((pid) => waitGone(pid, graceMs)));
  for (const pid of live()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await Promise.all(pids.map((pid) => waitGone(pid, graceMs)));
}

const NO_SERVER = /no server running|error connecting to|no such file or directory|failed to connect/i;

export interface TmuxStopOptions {
  /** The server's pid recorded when it was started (see `tmuxServerPid`); looked up if absent. */
  pid?: number;
  /** Bound on each tmux command (default 30 s). */
  commandTimeoutMs?: number;
  /** How long to wait for the server to exit after `kill-server`, and again after SIGKILL (default 15 s). */
  graceMs?: number;
}

/**
 * The pid of the tmux server on `socket`: null only when tmux positively says there is none. A timeout or any other failure
 * (a starved server) is retried and then THROWN, never read as "no server": a caller that deletes the socket directory on a
 * silent "nothing to stop" orphans the live server.
 */
export async function tmuxServerPid(socket: string, env: NodeJS.ProcessEnv, commandTimeoutMs = 30_000): Promise<number | null> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = (await run("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { env, timeout: commandTimeoutMs })).stdout.trim();
      if (/^\d+$/.test(out)) return Number(out);
      last = new Error(`unexpected display-message output: ${out}`);
    } catch (error) {
      const e = error as { killed?: boolean; signal?: string | null; stderr?: string; message?: string };
      const text = `${e.stderr ?? ""} ${e.message ?? ""}`;
      if (!e.killed && !e.signal && NO_SERVER.test(text)) return null;
      last = error;
    }
  }
  throw new Error(`the tmux server on ${socket} could not be located, so it cannot be verified stopped: ${String((last as Error)?.message ?? last).split("\n")[0]}`);
}

/**
 * Stop the tmux server this test started on `socket` and prove it is gone, or throw: the caller must then keep its watchdog
 * armed and its socket directory in place. `kill-server` gets a bound; a server still alive after it is SIGKILLed by the
 * pid (checked first to still be a tmux holding this socket).
 */
export async function stopOwnedTmuxServer(socket: string, env: NodeJS.ProcessEnv, options: TmuxStopOptions = {}): Promise<void> {
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000, graceMs = options.graceMs ?? 15_000;
  const pid = options.pid ?? await tmuxServerPid(socket, env, commandTimeoutMs);
  if (pid === null) return;
  if (!processAlive(pid)) return;
  await run("tmux", ["-S", socket, "kill-server"], { env, timeout: commandTimeoutMs }).catch(() => {});
  if (await waitGone(pid, graceMs)) return;
  const command = await run("ps", ["-o", "command=", "-p", String(pid)]).then((r) => r.stdout, () => "");
  if (command !== "" && !command.includes(socket)) return; // the pid was reused by something that is not our tmux server
  try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
  if (!(await waitGone(pid, graceMs))) throw new Error(`the tmux server (pid ${pid}) on ${socket} is still alive after SIGKILL`);
}
