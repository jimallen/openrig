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
export async function carriedPlacement(client: HcClient, seat: string): Promise<{ labels: Record<string, string>; names: PlacementNames | null; warnings: string[] }> {
  let previous: HcTerminal;
  try {
    previous = await client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(seat) });
  } catch (err) {
    if (err instanceof HcError && err.kind === "not_found") return { labels: {}, names: null, warnings: [] };
    if (err instanceof HcError || err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError) {
      return { labels: {}, names: null, warnings: [`${seat}: its previous Herdr placement could not be read, so the new terminal may not show until the placer runs`] };
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
  return { labels, names: Object.keys(labels).length > 0 ? placementNamesOf(previous.labels) : null, warnings: [] };
}

/** The names the app showed a seat's space and tab under: what to put back when the app has to make them again. */
export interface PlacementNames { space: string; tab: string }

const CONTROL = /[\u0000-\u001f\u007f]/;
const WHERE_SEPARATOR = " / ";

/**
 * OF-281. The `where` label is written by the app, never by OpenRig or hc: `<space name> / <tab name>` (measured on Herdr 0.1.13 with hc 0.1.18:
 * `rig:hold / cos`, and a finished terminal keeps it). When a seat alone in its tab ends, the app removes the tab from its document, and the space with it
 * when it was the space's only tab, so the names go too (no grace: 8 ms between the kill and the run lost both); the ids do not, because the app uses a
 * label's value as the id of the space or tab it makes. This reads the names from the previous terminal, split at the FIRST " / ".
 * Null when the label is missing, has no separator, or leaves either name empty or holding a control character.
 */
export function placementNamesOf(labels: Readonly<Record<string, string>> | undefined): PlacementNames | null {
  const where = labels?.[WHERE_LABEL];
  if (typeof where !== "string") return null;
  const at = where.indexOf(WHERE_SEPARATOR);
  if (at < 0) return null;
  const space = where.slice(0, at).trim();
  const tab = where.slice(at + WHERE_SEPARATOR.length).trim();
  if (space === "" || tab === "" || CONTROL.test(space) || CONTROL.test(tab)) return null;
  return { space, tab };
}

/** The label the app writes to say where it shows a terminal. Read for the names; never carried. */
export const WHERE_LABEL = "where";

/** A label the APP owns (its placement bookkeeping, display and attention counters), as opposed to the carried placement and the
 *  labels that are OpenRig's: `herdr.*` other than the two carried, and `where`. A respawn drops these and keeps everything else. */
export function isAppOwnedLabel(key: string): boolean {
  if (CARRIED_PLACEMENT_LABELS.includes(key)) return false;
  return key.startsWith(PLACEMENT_LABEL_PREFIX) || key === WHERE_LABEL;
}

const PLACEMENT_LABEL_PREFIX = "herdr.";

/** The labels of a terminal as its replacement carries them: everything but the app's own. */
export function withoutAppOwnedLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => !isAppOwnedLabel(key)));
}
