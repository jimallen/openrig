import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "./hc-client.js";
import { SEAT_LABEL, hcTerminalName, seatEnvironment, type SeatEnvironment, type SeatLaunchRecords } from "./hc-seat.js";
import { sessionEnvLabels } from "./hc-identity.js";
import { refusedLaunch } from "./hc-launch-refusal.js";
import { carriedPlacement } from "./hc-placement-carry.js";
import type { SeatLaunchHints, SessionProbe, TmuxResult } from "./tmux.js";

export { SEAT_LABEL, hcTerminalName, seatEnvironment, type SeatEnvironment } from "./hc-seat.js";

export interface HcHostOptions {
  /** The launch lease of a managed seat (the tmux adapter's deliveryGuard.ownsLifecycle). */
  ownsLifecycle?: (nodeId: string) => boolean;
  daemonEnv?: NodeJS.ProcessEnv;
  /** Where a created seat's env is kept for a later respawn (see SeatLaunchRecords). */
  launches?: SeatLaunchRecords;
}

/** The seat host on herdr-core, behind the method names of the tmux adapter it replaces. */
export class HcHost {
  constructor(private readonly client: HcClient = new HcClient(), private readonly options: HcHostOptions = {}) {}

  /** A seat's terminal, running a login shell as a tmux session does. No `keep`: a lost seat reads as lost. */
  async createSession(name: string, cwd?: string, env?: Record<string, string>, hints?: SeatLaunchHints): Promise<TmuxResult> {
    const { ownsLifecycle } = this.options;
    if (ownsLifecycle && (!env?.OPENRIG_NODE_ID || !ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const daemon = this.options.daemonEnv ?? process.env;
    let seat: SeatEnvironment;
    try {
      seat = seatEnvironment(env, daemon, hints);
    } catch (err) {
      return { ok: false, code: "invalid_env", message: (err as Error).message };
    }
    const argv = ["env", ...seat.unset.flatMap((key) => ["-u", key]), daemon.SHELL || "/bin/sh", "-l"];
    // OF-280: the seat's previous terminal (the core keeps a finished one readable under the seat's name) placed it in the app;
    // its `herdr.space` and `herdr.tab` labels follow to the new one (a restart in place carries all the old labels). Read before the run: the name is free by then.
    const previous = await carriedPlacement(this.client, name);
    const warnings = [...seat.warnings, ...previous.warnings];
    try {
      await this.client.call("terminal.run", {
        argv, env: seat.env, name: hcTerminalName(name), labels: { ...previous.labels, ...sessionEnvLabels(env ?? {}), [SEAT_LABEL]: name },
        ...(cwd != null ? { cwd } : {}), no_parent: true, no_notify: true, outlive_parent: true,
      });
      this.options.launches?.remember(name, { ...(cwd != null ? { cwd } : {}), env: env ?? {}, ...(hints ? { hints } : {}) });
      return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
    } catch (err) {
      if (err instanceof HcError && err.kind === "name_taken") {
        return { ok: false, code: "duplicate_session", message: `duplicate session: ${name}` };
      }
      // The kind, never the core's text: this call carried the seat's credentials.
      const refused = await refusedLaunch(this.client, err, name);
      if (refused) return refused;
      if (err instanceof HcError) return { ok: false, code: "unknown", message: `hc refused ${name}: ${err.kind}` };
      if (err instanceof HcUnavailableError) return { ok: false, code: "transport_unavailable", message: `hc core unavailable: ${name}` };
      if (err instanceof HcOutcomeUnknownError) {
        return { ok: false, code: "launch_outcome_unknown", message: `no reply launching ${name}: check it before launching again` };
      }
      throw err;
    }
  }

  /** Three outcomes, as OF-177's reconcileArchivedRigs needs: only positive evidence reads as absent. */
  async probeSession(name: string): Promise<SessionProbe> {
    let terminal: HcTerminal;
    try {
      terminal = await this.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(name) });
    } catch (err) {
      if (err instanceof HcError && err.kind === "not_found") return { state: "absent" };
      if (err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError) {
        return { state: "transport_unavailable", cause: err.message };
      }
      throw err;
    }
    if (terminal.state === "live") return { state: "present" };
    // spawn_pending: the holder may still be starting it, so it is not gone yet.
    if (terminal.state === "finished" && terminal.reason !== "spawn_pending") return { state: "absent" };
    return { state: "transport_unavailable", cause: `terminal ${terminal.address} is ${terminal.state}` };
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.probeSession(name)).state === "present";
  }
}
