import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-seat.js";
import { SPACE_LABEL, TAB_LABEL } from "./hc-placement.js";

/** The labels that place a terminal in the app (hc-placement.ts) and nothing else. Other `herdr.*` keys are the app's own bookkeeping
 *  (`herdr.seen` is written by the app and its meaning is unmeasured), and the old terminal's identity and session labels are the old
 *  terminal's: none of them is carried. */
export const CARRIED_PLACEMENT_LABELS: readonly string[] = [SPACE_LABEL, TAB_LABEL];

/**
 * OF-280. The placement a new terminal for an existing seat inherits: the `herdr.space` and `herdr.tab` labels of the seat's most recent terminal.
 *
 * Source: the core. `terminal.get <name>` answers the live terminal, else the latest finished one, and a finished record keeps its
 * labels. Measured on a private core (hc 0.1.18, 2026-11-08): the labels set after creation (the placer's `hc label`) are on the record
 * after a kill, a planned `server restart`, `server stop` + `start`, and a `kill -9` of the core and its holder (a live terminal comes
 * back finished `stopped_by_restart`, labels intact); of three finished records under one name, the get answers the newest. The daemon
 * cannot be the source: it never sees the placement, which rig-here writes straight to the core.
 *
 * A seat with no earlier terminal, or one the core cannot answer for, carries nothing: the launch is never held up by the lookup.
 * An unreadable core is a warning, so a missing placement is not silent. A stale placement is NOT inert: the app's guide says an id
 * it does not know becomes a new, unnamed space or tab, so a relaunch into a space or tab that was closed since can make the app
 * draw a stray one (the placer re-places the seat). OpenRig itself only reads here: it creates and closes no tab or space.
 */
export async function carriedPlacement(client: HcClient, seat: string): Promise<{ labels: Record<string, string>; warnings: string[] }> {
  let previous: HcTerminal;
  try {
    previous = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
  } catch (err) {
    if (err instanceof HcError && err.kind === "not_found") return { labels: {}, warnings: [] };
    if (err instanceof HcError || err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError) {
      return { labels: {}, warnings: [`${seat}: its previous Herdr placement could not be read, so the new terminal may not show until the placer runs`] };
    }
    // Unreachable with the current client: every error out of HcClient.call is one of the three types above. Kept so that an error
    // of any other kind (a bug, not a core answer) is not mistaken for "no placement".
    throw err;
  }
  const labels: Record<string, string> = {};
  for (const key of CARRIED_PLACEMENT_LABELS) {
    const value = previous.labels?.[key];
    if (value !== undefined) labels[key] = value;
  }
  return { labels, warnings: [] };
}
