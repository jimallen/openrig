// workspaces-o9o.65, reconciled in workspaces-o9o.11 — which runtime executable a seat will launch, and its version, as the seat
// sees it. ONE mechanism, used by spec preflight's Pi notice and by `rig doctor`'s runtime rows.
//
// The relaunch preview used to run `pi --version` on the DAEMON's PATH, while a seat's Pi runner resolves `pi` on the PATH of the
// seat's terminal. On sparky (2026-11-16) the daemon found ~/.local/bin/pi (1.5.0) and every seat ran ~/.pi/agent/bin/pi (1.4.0).
// o9o.65 asked `$SHELL -l -c` for that PATH; that is a NON-interactive login shell, which skips .zshrc and .bashrc (measured by
// build-arch: a PATH entry set in .zshrc is missing there and present in an interactive login shell on a pty). A seat's terminal
// is an interactive login shell, so the PATH now comes from a `SeatPathSource`: in the daemon, the probe terminal of
// HostReadinessService (a login shell started the way a seat's is). This module only resolves a name on a given PATH, the way the
// runner does (resolveRuntimeExecutable: first executable on PATH, then its real path, through a mise shim), and runs that file's
// --version.
import { execFile } from "node:child_process";
import { seatEnvironment } from "./hc-seat.js";
import { resolveRuntimeExecutable } from "./pi-runner.js";
import type { SeatRuntimeProbe } from "../domain/rigspec-preflight.js";

export type ProbeRun = (file: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<string>;

/** A seat's PATH. Rejects (never guesses) when it cannot be read; the error's message says why. */
export type SeatPathSource = () => Promise<string>;

const run: ProbeRun = (file, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

/** Resolve on the PATH `pathSource` gives, in `env`, and run --version. `where` names that PATH in a not-found error. */
export function runtimeProbeOnPath(pathSource: SeatPathSource, opts: { env: Record<string, string>; where: string; run?: ProbeRun; timeoutMs?: number }): SeatRuntimeProbe {
  const exec = opts.run ?? run;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (name) => {
    let path: string;
    try {
      path = await pathSource();
    } catch (err) {
      throw Object.assign(new Error(`the PATH of ${opts.where} could not be read (${(err as Error).message})`), { code: "EPROTO" });
    }
    const env = { ...opts.env, PATH: path };
    const resolved = resolveRuntimeExecutable(name, env);
    if (!resolved.ok) {
      // Bounded: the PATH is not echoed (runtimeProbeFailure's rule for a probe's output).
      throw Object.assign(new Error(`'${name}' is not on the PATH of ${opts.where}`), { code: "ENOENT" });
    }
    return { path: resolved.path, output: await exec(resolved.path, ["--version"], env, timeoutMs) };
  };
}

/** The runtime a seat launches: its terminal's PATH from `seatPath`, in the environment hc-host gives a seat terminal. */
export function seatRuntimeProbe(opts: { seatPath: SeatPathSource; daemonEnv?: NodeJS.ProcessEnv; run?: ProbeRun; timeoutMs?: number }): SeatRuntimeProbe {
  const seat = seatEnvironment({}, opts.daemonEnv ?? process.env);
  return runtimeProbeOnPath(opts.seatPath, { env: seat.env, where: "a seat's login shell", ...(opts.run ? { run: opts.run } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
}

/** The runtime the daemon's own checks see: the daemon's PATH, in the daemon's environment. */
export function daemonRuntimeProbe(opts: { daemonEnv?: NodeJS.ProcessEnv; run?: ProbeRun; timeoutMs?: number } = {}): SeatRuntimeProbe {
  const env = stringEnv(opts.daemonEnv ?? process.env);
  return runtimeProbeOnPath(async () => env["PATH"] ?? "", { env, where: "the daemon", ...(opts.run ? { run: opts.run } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
}
