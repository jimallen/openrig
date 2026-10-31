/**
 * The Herdr app labels a seat carries to show in a space and tab (design-hc-cutover-20261031.md section 5).
 *
 * The scheme is the daemon's, imported from `@openrig/daemon/hc` (hc-surface.ts, from adapters/hc-placement.ts). This
 * file only turns a view's seats into the tabs the daemon's plan would give them, and says nothing when it cannot.
 */
import { KERNEL_RIG, SPACE_LABEL, TAB_LABEL, planRigTabs, rigOfSeat, rigSpaceId } from "@openrig/daemon/hc";

export interface ExpectedTab {
  space: string;
  name: string;
  tab: string;
  seats: string[];
}

/**
 * Where the seats of a view are placed by label (the daemon's `planRigTabs`: the lead alone in `cos`, the rest in `team`).
 * Returns nothing when any seat is not canonical, when a seat is a kernel seat (the daemon plans those on its own: one
 * human seat alone), a repeated seat, or a rig name the daemon's plan refuses: the CLI states a placement only when it can derive all of it.
 */
export function expectedViewerTabs(seats: readonly string[]): ExpectedTab[] {
  const byRig = new Map<string, string[]>();
  try {
    for (const seat of seats) {
      const rig = rigOfSeat(seat);
      if (rig === KERNEL_RIG) return [];
      byRig.set(rig, [...(byRig.get(rig) ?? []), seat]);
    }
    const out: ExpectedTab[] = [];
    for (const [rig, list] of byRig) {
      for (const tab of planRigTabs(rig, list)) out.push({ space: rigSpaceId(rig), name: tab.name, tab: tab.id, seats: tab.seats });
    }
    return out;
  } catch {
    return [];
  }
}

/** One line per expected tab, for a note. */
export function describeExpectedTabs(tabs: readonly ExpectedTab[]): string | undefined {
  if (tabs.length === 0) return undefined;
  return `Seats are placed by label (${SPACE_LABEL}, ${TAB_LABEL}): ${tabs.map((t) => `${t.tab} holds ${t.seats.join(", ")}`).join("; ")}. Closing a tab or space ends the seats shown in it.`;
}
