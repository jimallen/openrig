import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { hcTerminalName } from "./hc-seat.js";

/** The labels the Herdr app reads to place a terminal (hc-placement.ts: `herdr.space`, `herdr.tab`). Everything under this prefix
 *  placed the seat's old terminal; nothing else of the old terminal (identity, session names) is carried. */
export const PLACEMENT_LABEL_PREFIX = "herdr.";

/**
 * OF-280. The placement a new terminal for an existing seat inherits: the `herdr.*` labels of the seat's most recent terminal.
 *
 * Source: the core. `terminal.get <name>` answers the live terminal, else the latest finished one, and a finished record keeps its
 * labels. Measured on a private core (hc 0.1.18, 2026-11-08): the labels set after creation (the placer's `hc label`) are on the record
 * after a kill, a planned `server restart`, `server stop` + `start`, and a `kill -9` of the core and its holder (a live terminal comes
 * back finished `stopped_by_restart`, labels intact); of three finished records under one name, the get answers the newest. The daemon
 * cannot be the source: it never sees the placement, which rig-here writes straight to the core.
 *
 * A seat with no earlier terminal, or one the core cannot answer for, carries nothing: the launch is never held up by the lookup.
 * An unreadable core is a warning, so a missing placement is not silent. A stale placement is harmless (an id the app does not
 * show draws nothing, and the placer re-places the seat). This only reads: it never creates or closes a tab or space.
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
    throw err;
  }
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(previous.labels ?? {})) {
    if (key.startsWith(PLACEMENT_LABEL_PREFIX)) labels[key] = value;
  }
  return { labels, warnings: [] };
}
