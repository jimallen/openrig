// workspaces-o9o.65 — which runtime executable a seat will launch, and its version, as the seat sees it.
//
// The relaunch preview used to run `pi --version` on the DAEMON's PATH, while a seat's Pi runner resolves `pi` on the PATH of
// the seat's terminal: the daemon's SHELL run as a login shell (hc-host createSession), whose profile can put another
// directory first. On sparky (2026-11-16) the daemon found ~/.local/bin/pi (1.5.0) and every seat ran ~/.pi/agent/bin/pi (1.4.0),
// so the preview named a Pi no seat ran. This asks the same login shell for its PATH, resolves the name the way the runner does
// (resolveRuntimeExecutable: first executable on PATH, then its real path, through a mise shim), and runs that file's --version.
import { execFile } from "node:child_process";
import { seatEnvironment } from "./hc-seat.js";
import { resolveRuntimeExecutable } from "./pi-runner.js";
import type { SeatRuntimeProbe } from "../domain/rigspec-preflight.js";

export type ProbeRun = (file: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<string>;

const run: ProbeRun = (file, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** A probe that answers as a seat terminal of this daemon would: the daemon's SHELL (default /bin/sh) as a login shell, with the
 *  environment hc-host gives a seat terminal (seatEnvironment). Bounded: each step stops at `timeoutMs`. */
export function seatRuntimeProbe(opts: { daemonEnv?: NodeJS.ProcessEnv; run?: ProbeRun; timeoutMs?: number } = {}): SeatRuntimeProbe {
  const daemon = opts.daemonEnv ?? process.env;
  const exec = opts.run ?? run;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (name) => {
    const seat = seatEnvironment({}, daemon);
    const shell = daemon["SHELL"] || "/bin/sh";
    const argv = [...seat.unset.flatMap((key) => ["-u", key]), shell, "-l", "-c", 'printf "%s" "$PATH"'];
    const seatPath = await exec("env", argv, seat.env, timeoutMs);
    const env = { ...seat.env, PATH: seatPath };
    const resolved = resolveRuntimeExecutable(name, env);
    if (!resolved.ok) {
      // Bounded: the seat's PATH is not echoed (runtimeProbeFailure's rule for a probe's output).
      throw Object.assign(new Error(`'${name}' is not on the PATH of a seat's login shell`), { code: "ENOENT" });
    }
    return { path: resolved.path, output: await exec(resolved.path, ["--version"], env, timeoutMs) };
  };
}
