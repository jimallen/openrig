import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * A test that starts a process which outlives the test runner (a tmux server, a daemon the CLI detaches) must not rely on
 * its own teardown alone: a vitest timeout, a killed worker or a swallowed stop failure never reaches it, and the process
 * then runs for days after its temp home is deleted. `reapWhenOwnerDies` starts a tiny detached watchdog that waits for
 * the OWNER (the test worker) to die and then stops exactly what it was told to: the listed pids (TERM, then KILL) and
 * the tmux servers on the listed sockets. It never matches by name or pattern. `disarm()` removes it once the test's
 * own teardown has run.
 */
export interface OrphanReaperTargets {
  /** Pids this test started (and read back from its own state files). */
  pids?: number[];
  /** tmux servers this test started, by explicit socket path. */
  tmuxSockets?: string[];
  /** The process whose death triggers the reaping; default: this process. */
  ownerPid?: number;
}

const WATCHDOG = `owner=$1; shift
while kill -0 "$owner" 2>/dev/null; do sleep 1; done
for a in "$@"; do
  case "$a" in
    pid:*) kill -TERM "\${a#pid:}" 2>/dev/null ;;
    tmux:*) tmux -S "\${a#tmux:}" kill-server 2>/dev/null ;;
  esac
done
sleep 3
for a in "$@"; do
  case "$a" in
    pid:*) kill -KILL "\${a#pid:}" 2>/dev/null ;;
  esac
done
`;

export function reapWhenOwnerDies(targets: OrphanReaperTargets): { disarm: () => void; pid: number } {
  const args = [
    ...(targets.pids ?? []).map((pid) => `pid:${pid}`),
    ...(targets.tmuxSockets ?? []).map((socket) => `tmux:${socket}`),
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

export async function waitGone(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (processAlive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Stop the tmux server this test started on `socket`, and prove it is gone. A bare `kill-server` swallowed on a timeout
 * left the server (and its sessions) running once the socket directory was deleted; here the server's own pid is read
 * first, `kill-server` gets a generous bound, and a server that is still alive is killed by pid.
 */
export async function stopOwnedTmuxServer(socket: string, env: NodeJS.ProcessEnv): Promise<void> {
  let pid: number | null = null;
  try {
    const out = (await run("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { env, timeout: 30_000 })).stdout.trim();
    pid = /^\d+$/.test(out) ? Number(out) : null;
  } catch { /* no server on this socket */ }
  if (pid === null) return;
  await run("tmux", ["-S", socket, "kill-server"], { env, timeout: 30_000 }).catch(() => {});
  if (await waitGone(pid, 15_000)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
  await waitGone(pid, 15_000);
}
