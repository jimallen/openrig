import { createHash } from "node:crypto";
import { HcClient, HcError, HcOutcomeUnknownError, HcUnavailableError, type HcTerminal } from "./hc-client.js";
import type { SessionProbe } from "./tmux.js";

/** Label holding a seat's canonical name; hc's own name cannot hold it (`verify-qa@eztrack` is refused). */
export const SEAT_LABEL = "openrig.seat";

/** hc names are 1 to 32 of a-z 0-9 - _ . A digest keeps `name_taken`'s atomic refusal for any seat name. */
export function hcTerminalName(seat: string): string {
  return `s-${createHash("sha256").update(seat).digest("hex").slice(0, 24)}`;
}

/** The seat host on herdr-core, behind the method names of the tmux adapter it replaces. */
export class HcHost {
  constructor(private readonly client: HcClient = new HcClient()) {}

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
