import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "./hc-client.js";
import { SEAT_LABEL, hcTerminalName, seatEnvironment } from "./hc-seat.js";
import type { TmuxResult } from "./tmux.js";

/** Label a probe terminal carries instead of the seat label, so a probe is never read as a seat. */
export const PROBE_LABEL = "openrig.probe";

export type HcSignal = "TERM" | "KILL";

export interface HcLifecycleOptions {
  daemonEnv?: NodeJS.ProcessEnv;
  /** The tmux adapter's `deliveryGuard.maybeTarget`: true when a managed seat record names this session. A probe must
   *  not reuse one. */
  isManagedSeat?: (name: string) => boolean;
  /** Sends a signal to a local pid. Injected so unit tests never signal a real process. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

function failure(err: unknown, what: string): TmuxResult {
  // The kind, never the core's text: a launch call carried the seat's credentials.
  if (err instanceof HcError && err.kind === "not_found") return { ok: false, code: "session_not_found", message: `${what}: no such seat terminal` };
  if (err instanceof HcError) return { ok: false, code: "unknown", message: `hc refused ${what}: ${err.kind}` };
  if (err instanceof HcUnavailableError) return { ok: false, code: "transport_unavailable", message: `hc core unavailable: ${what}` };
  if (err instanceof HcOutcomeUnknownError) return { ok: false, code: "outcome_unknown", message: `no reply from hc for ${what}: check it before trying again` };
  throw err;
}

/** The seat host's lifecycle on herdr-core, behind the method names of the tmux adapter it replaces.
 *
 *  A seat is one terminal, found by its name (`hcTerminalName`) and carrying its canonical name in the `openrig.seat`
 *  label. A "pane target" in the tmux adapter becomes the seat's canonical name: a terminal's address changes on every
 *  respawn, the label is what follows (design gap 5). No delivery guard lives here; HcHost wraps these as it wraps
 *  createSession. */
export class HcLifecycle {
  constructor(private readonly client: HcClient = new HcClient(), private readonly options: HcLifecycleOptions = {}) {}

  /** End the seat's program (hangup, terminate, kill) and wait for hc's observed result. The finished record stays
   *  readable at its old address; nothing is removed. A seat with no live terminal is `session_not_found`, as a gone
   *  tmux session is. */
  async killSession(name: string): Promise<TmuxResult> {
    try {
      const found = await this.find(name);
      if (found === null || found.state !== "live") return { ok: false, code: "session_not_found", message: `${name}: no live terminal` };
      return await this.kill(name, found);
    } catch (err) {
      return failure(err, name);
    }
  }

  private async kill(name: string, live: HcTerminal): Promise<TmuxResult> {
    const ended = await this.client.call<HcTerminal>("terminal.kill", { terminal: live.address });
    if (ended.state !== "finished") return { ok: false, code: "kill_incomplete", message: `${name}: hc reports the terminal still ${ended.state}` };
    return { ok: true };
  }

  /** Restart the seat's program in place: kill, then run again under the same name and labels. The address changes,
   *  so callers follow the label, not the address. Without `command` the seat gets a blank login shell: hc has no
   *  creation command to re-run (tmux's KI-14 hazard cannot happen). The predecessor's scrollback stays readable at
   *  its old address, as a finished terminal, until someone removes it; it is no longer above the new program's output.
   *  Unlike `respawn-pane` without `-k`, a live program is ended here, not refused. */
  async respawnPane(seat: string, command?: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<TmuxResult> {
    const daemon = this.options.daemonEnv ?? process.env;
    let launch: ReturnType<typeof seatEnvironment>;
    try {
      launch = seatEnvironment(opts?.env, daemon);
    } catch (err) {
      return { ok: false, code: "invalid_env", message: (err as Error).message };
    }
    let before: HcTerminal | null;
    try {
      before = await this.find(seat);
    } catch (err) {
      return failure(err, seat);
    }
    if (before === null) return { ok: false, code: "session_not_found", message: `${seat}: no terminal to respawn` };
    if (before.state === "live") {
      try {
        const killed = await this.kill(seat, before);
        if (!killed.ok) return killed;
      } catch (err) {
        return failure(err, seat);
      }
    }
    const shell = daemon.SHELL || "/bin/sh";
    const argv = ["env", ...launch.unset.flatMap((key) => ["-u", key]), ...(command != null && command.length > 0 ? ["/bin/sh", "-c", command] : [shell, "-l"])];
    const cwd = opts?.cwd ?? before.cwd;
    try {
      await this.client.call("terminal.run", {
        argv, env: launch.env, name: hcTerminalName(seat), cwd,
        // Everything that placed the old terminal (the app's space and tab labels) follows to the new one.
        labels: { ...before.labels, [SEAT_LABEL]: seat },
        no_parent: true, no_notify: true, outlive_parent: true,
      });
      return { ok: true };
    } catch (err) {
      const result = failure(err, seat);
      // The old program is already gone: say so, so the caller does not read "nothing happened".
      return result.ok ? result : { ...result, message: `${result.message} (the previous program had already ended)` };
    }
  }

  /** Signal one local process by pid, with no shell. */
  async signalPid(pid: number, signal: HcSignal): Promise<TmuxResult> {
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, code: "invalid_pid", message: `Refusing to signal pid ${pid}.` };
    try {
      (this.options.kill ?? process.kill.bind(process))(pid, `SIG${signal}`);
      return { ok: true };
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
      if (code === "ESRCH") return { ok: false, code: "process_not_found", message: `No process ${pid}.` };
      return { ok: false, code: "unknown", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Signal the seat's root process: with argv launch that is the login shell (`env` execs it), as a tmux pane's root is.
   *  Only a LIVE terminal is signalled: a finished terminal still reports its old pid, which the OS may have given to
   *  an unrelated process. */
  async signalPaneProcess(seat: string, signal: HcSignal): Promise<TmuxResult> {
    let terminal: HcTerminal | null;
    try {
      terminal = await this.find(seat);
    } catch (err) {
      return failure(err, seat);
    }
    if (terminal === null || terminal.state !== "live" || terminal.pid == null || terminal.address.includes("/")) {
      return { ok: false, code: "pane_pid_unavailable", message: `Could not resolve a live local pid for "${seat}".` };
    }
    return this.signalPid(terminal.pid, signal);
  }

  /** `remain-on-exit`. A finished hc terminal always stays readable (state `finished`, its exit code and reason, its
   *  history capped at 1,000 rows) until `terminal.rm`, and OpenRig never starts a seat with `rm`, so `on` holds
   *  already: this only proves the seat has a terminal. There is no way to turn it off for a running terminal, so `off`
   *  is accepted with a warning and changes nothing. */
  async setRemainOnExit(seat: string, on: boolean): Promise<TmuxResult> {
    try {
      if ((await this.find(seat)) === null) return { ok: false, code: "session_not_found", message: `${seat}: no terminal` };
    } catch (err) {
      return failure(err, seat);
    }
    return on ? { ok: true } : { ok: true, warnings: [`${seat}: hc keeps a finished terminal readable until it is removed; remain-on-exit cannot be turned off`] };
  }

  /** Has the seat's program ended? Also true when the terminal is gone (a known-missing pane proves the cutover). An
   *  unreachable core is not dead. */
  async isPaneDead(seat: string): Promise<boolean> {
    try {
      const terminal = await this.find(seat);
      return terminal === null || terminal.state === "finished";
    } catch {
      return false;
    }
  }

  /** The metadata probe's private terminal: a login shell under the probe's own name, labelled as a probe and never as
   *  a seat. It cannot reuse a live terminal of that name (`name_taken`, atomic) or a managed seat's name. Remove it
   *  with killSession. */
  async createProbeSession(name: string, cwd?: string): Promise<TmuxResult> {
    if (this.options.isManagedSeat?.(name)) return { ok: false, code: "guard_target_managed", message: "A probe cannot reuse a managed seat." };
    const daemon = this.options.daemonEnv ?? process.env;
    let launch: ReturnType<typeof seatEnvironment>;
    try {
      launch = seatEnvironment({}, daemon);
    } catch (err) {
      return { ok: false, code: "invalid_env", message: (err as Error).message };
    }
    const argv = ["env", ...launch.unset.flatMap((key) => ["-u", key]), daemon.SHELL || "/bin/sh", "-l"];
    try {
      await this.client.call("terminal.run", {
        argv, env: launch.env, name: hcTerminalName(name), labels: { [PROBE_LABEL]: name },
        ...(cwd != null ? { cwd } : {}), no_parent: true, no_notify: true, outlive_parent: true,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof HcError && err.kind === "name_taken") return { ok: false, code: "duplicate_session", message: `duplicate session: ${name}` };
      return failure(err, name);
    }
  }

  /** The terminal answering to this seat's name: the live one if there is one, else the latest finished record. */
  private async find(name: string): Promise<HcTerminal | null> {
    try {
      return await this.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(name) });
    } catch (err) {
      if (err instanceof HcError && err.kind === "not_found") return null;
      throw err;
    }
  }
}
