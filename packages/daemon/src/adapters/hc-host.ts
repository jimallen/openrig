import { createHash } from "node:crypto";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "./hc-client.js";
import { PARENT_SESSION_ENV_KEYS, removeParentSessionEnv } from "../domain/parent-session-env.js";
import type { SessionProbe, TmuxResult } from "./tmux.js";

/** Label holding a seat's canonical name; hc's own name cannot hold it (`verify-qa@eztrack` is refused). */
export const SEAT_LABEL = "openrig.seat";

/** hc names are 1 to 32 of a-z 0-9 - _ . A digest keeps `name_taken`'s atomic refusal for any seat name. */
export function hcTerminalName(seat: string): string {
  return `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Set by a host the daemon may sit inside; hc sets its own for the seat. */
const HOST_ENV_KEYS = ["TMUX", "TMUX_PANE"];

export interface SeatEnvironment {
  /** Sent in `terminal.run.env`, which merges over the core's env: values cross the socket, never an argv. */
  env: Record<string, string>;
  /** Names the launch wrapper removes: the API cannot unset a core variable, and the core's env is not the daemon's. */
  unset: string[];
}

/** A seat's env, stated rather than inherited: the core's env is whatever started it (the app, a first CLI call), while
 *  the daemon's is what seats get today, since the daemon starts the tmux server. Throws naming the key, never a value. */
export function seatEnvironment(seat: Readonly<Record<string, string>> = {}, daemon: NodeJS.ProcessEnv = process.env): SeatEnvironment {
  const inherited: Record<string, string | undefined> = { ...daemon };
  removeParentSessionEnv(inherited);
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("HC_") || HOST_ENV_KEYS.includes(key)) delete inherited[key];
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) if (value !== undefined) env[key] = value;
  // An empty value keeps a stale policy from pinning over config.json, as on tmux. Explicit seat settings win.
  Object.assign(env, { OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "" }, seat);
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) throw new Error(`invalid environment name ${JSON.stringify(key)}`);  // hc accepts "A=B" and ""
    if (value.includes("\0")) throw new Error(`environment value of ${key} holds a NUL`);
  }
  const candidates = [...PARENT_SESSION_ENV_KEYS, "CLAUDE_EFFORT", ...HOST_ENV_KEYS];
  return { env, unset: candidates.filter((key) => !(key in env)) };
}

export interface HcHostOptions {
  /** The launch lease of a managed seat (the tmux adapter's deliveryGuard.ownsLifecycle). */
  ownsLifecycle?: (nodeId: string) => boolean;
  daemonEnv?: NodeJS.ProcessEnv;
}

/** The seat host on herdr-core, behind the method names of the tmux adapter it replaces. */
export class HcHost {
  constructor(private readonly client: HcClient = new HcClient(), private readonly options: HcHostOptions = {}) {}

  /** A seat's terminal, running a login shell as a tmux session does. No `keep`: a lost seat reads as lost. */
  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    const { ownsLifecycle } = this.options;
    if (ownsLifecycle && (!env?.OPENRIG_NODE_ID || !ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const daemon = this.options.daemonEnv ?? process.env;
    let seat: SeatEnvironment;
    try {
      seat = seatEnvironment(env, daemon);
    } catch (err) {
      return { ok: false, code: "invalid_env", message: (err as Error).message };
    }
    const argv = ["env", ...seat.unset.flatMap((key) => ["-u", key]), daemon.SHELL || "/bin/sh", "-l"];
    try {
      await this.client.call("terminal.run", {
        argv, env: seat.env, name: hcTerminalName(name), labels: { [SEAT_LABEL]: name },
        ...(cwd != null ? { cwd } : {}), no_parent: true, no_notify: true, outlive_parent: true,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof HcError && err.kind === "name_taken") {
        return { ok: false, code: "duplicate_session", message: `duplicate session: ${name}` };
      }
      // The kind, never the core's text: this call carried the seat's credentials.
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
