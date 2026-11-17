// workspaces-o9o.65 — which runtime executable a seat will launch, and its version, as the seat sees it.
//
// The relaunch preview used to run `pi --version` on the DAEMON's PATH, while a seat's Pi runner resolves `pi` on the PATH of
// the seat's terminal: the daemon's SHELL run as a login shell (hc-host createSession), whose profile can put another
// directory first. On sparky (2026-11-16) the daemon found ~/.local/bin/pi (1.5.0) and every seat ran ~/.pi/agent/bin/pi (1.4.0),
// so the preview named a Pi no seat ran. This asks that SHELL as a login shell for its PATH, resolves the name the way the runner does
// (resolveRuntimeExecutable: first executable on PATH, then its real path, through a mise shim), and runs that file's --version.
// Limit (build-arch, measured): `-l -c` is a NON-interactive login shell, so zsh skips .zshrc and bash skips .bashrc. A seat's
// terminal is an interactive login shell on a pty, so a PATH set only in those files (oh-my-zsh, brew, mise) is not seen here.
// workspaces-o9o.11 replaces this with a probe terminal; until then the notice says exactly what was measured.
import { execFile } from "node:child_process";
import { seatEnvironment } from "./hc-seat.js";
import { resolveRuntimeExecutable } from "./pi-runner.js";
import type { SeatRuntimeProbe } from "../domain/rigspec-preflight.js";

export type ProbeRun = (file: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<string>;

const run: ProbeRun = (file, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/** A probe that asks the daemon's SHELL (default /bin/sh) as a NON-interactive login shell (`-l -c`), with the
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
      throw Object.assign(new Error(`'${name}' is not on the PATH of a non-interactive login shell`), { code: "ENOENT" });
    }
    return { path: resolved.path, output: await exec(resolved.path, ["--version"], env, timeoutMs) };
  };
}
