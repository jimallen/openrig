/**
 * The Herdr app labels a seat carries to show in a space and tab (design-hc-cutover-20261031.md section 5).
 *
 * The source of truth is packages/daemon/src/adapters/hc-placement.ts. The CLI cannot import it: its tsconfig maps only
 * the named `@openrig/daemon/<surface>` entries to built `*-surface.d.ts` files, and hc-placement is not one of them
 * (adding one means editing the daemon's package.json exports and a surface file, which this piece does not own). So the
 * label strings are restated here, once, and `test/terminal-labels.test.ts` fails if they drift from the daemon's.
 */

export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";
export const TAB_ID_SEPARATOR = "/";
const SPACE_ID_PREFIX = "rig:";
/** Kernel seats are placed by the daemon's own plan (one human seat alone); the CLI does not restate that. */
const KERNEL_RIG = "kernel";

export function rigSpaceId(rig: string): string {
  return `${SPACE_ID_PREFIX}${rig}`;
}

export function rigTabId(rig: string, tab: string): string {
  return `${rigSpaceId(rig)}${TAB_ID_SEPARATOR}${tab}`;
}

export interface ExpectedTab {
  space: string;
  name: string;
  tab: string;
  seats: string[];
}

/** The rig of a canonical seat `<pod>-<member>@<rig>`, or undefined for any other name. */
function rigOf(seat: string): string | undefined {
  const at = seat.lastIndexOf("@");
  return at > 0 && at < seat.length - 1 ? seat.slice(at + 1) : undefined;
}

/** hc-placement `pickLead`. */
function pickLead(seats: readonly string[]): string {
  return seats.find((s) => s.startsWith("exec-cos@"))
    ?? seats.find((s) => /(^|[.-])(exec|cos|lead|orch)[.-]/.test(s))
    ?? seats[0]!;
}

/**
 * Where the seats of a view are placed by label (hc-placement `planRigTabs`: the lead alone in `cos`, the rest in `team`).
 * Returns nothing when any seat is not canonical, when a seat is a kernel seat, or when a rig name would break an id:
 * the CLI states a placement only when it can derive all of it.
 */
export function expectedViewerTabs(seats: readonly string[]): ExpectedTab[] {
  if (new Set(seats).size !== seats.length) return [];
  const byRig = new Map<string, string[]>();
  for (const seat of seats) {
    const rig = rigOf(seat);
    if (rig === undefined || rig === KERNEL_RIG || rig.includes(TAB_ID_SEPARATOR) || rig.trim() !== rig || /[\u0000-\u001f\u007f]/.test(rig)) return [];
    byRig.set(rig, [...(byRig.get(rig) ?? []), seat]);
  }
  const out: ExpectedTab[] = [];
  for (const [rig, list] of byRig) {
    const lead = pickLead(list);
    out.push({ space: rigSpaceId(rig), name: "cos", tab: rigTabId(rig, "cos"), seats: [lead] });
    const rest = list.filter((s) => s !== lead);
    if (rest.length > 0) out.push({ space: rigSpaceId(rig), name: "team", tab: rigTabId(rig, "team"), seats: rest });
  }
  return out;
}

/** One line per expected tab, for a note. */
export function describeExpectedTabs(tabs: readonly ExpectedTab[]): string | undefined {
  if (tabs.length === 0) return undefined;
  return `Seats are placed by label (${SPACE_LABEL}, ${TAB_LABEL}): ${tabs.map((t) => `${t.tab} holds ${t.seats.join(", ")}`).join("; ")}. Closing a tab or space ends the seats shown in it.`;
}
