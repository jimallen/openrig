import { HcError, HcOutcomeUnknownError, HcUnavailableError, type HcClient, type HcTerminal } from "./hc-client.js";
import { SEAT_LABEL, hcTerminalName } from "./hc-seat.js";

/**
 * Where a seat shows in the Herdr app, and how it is kept alive while that view changes.
 *
 * Sources: "design 5" is design-hc-cutover-20261031.md section 5 (spike 5, measured on the laptop in a scratch window by
 * agents-c9); "guide" is the app's own embedded guide, read as static text from the binary (nothing was run);
 * "schema" is the hc API schema. Nothing in this file was measured against a window by its author: every app behaviour
 * below carries its source, and the real-core test covers labels and `keep` only, on a private core with no app.
 *
 * STATUS (hc-w23, read at add4c5e2): the pure planning half (ids, `planRigTabs`, labels) has one runtime caller, the CLI's
 * note in terminal-labels.ts. The driver class `HcPlacement` has NO runtime caller: the daemon has no `herdr-app`
 * channel (`AppPort` had no implementation outside tests until hc-w37: `createHerdrAppCli` in
 * domain/terminal/herdr-app-provider.ts now implements it, for `rig terminal open` only), `rig terminal open` opens `hc attach` viewer
 * panes through that provider (a fresh space per open; it never parks or labels a seat), and the placer that labels and parks seats is rig-here (~/.agents, Python,
 * same scheme, pinned equal by test/hc-placement-scheme.test.ts). It is kept as the reference for that scheme and the
 * tested home of its idempotence and park rules for the day the daemon places seats itself; wiring it is a product call.
 *
 * Closing a tab or a space KILLS its terminals (design 5, guide). A seat is therefore parked before any close, and a
 * close is allowed only when `safeToClose` says every seat of it is out of its pane.
 */

/** Labels the app reads (guide): a terminal carrying them shows in that space and tab; an id the app does not know
 *  becomes a new space or tab (design 5). The display name is not the id, so a rename follows (design 5). */
export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";

/** Tab ids are global (design 5: `herdr.tab=team` joined another space's `team`), so a tab id carries its rig.
 *  UNVERIFIED: the guide says ids the app shows for remote machines are prefixed `<machine>/`. Whether the app
 *  mistakes this separator for that prefix is not measured; design 5 names `rig:eztrack/team` as the shape. */
export const TAB_ID_SEPARATOR = "/";
const SPACE_ID_PREFIX = "rig:";

/** Kernel seats show alone in one tab (rig-here `tile_kernel`). */
export const KERNEL_RIG = "kernel";
export const KERNEL_TAB = "human";

const CONTROL = /[\u0000-\u001f\u007f]/;

function checkName(kind: string, value: string, extra?: RegExp): void {
  if (!value || value.trim() !== value) throw new Error(`${kind} must be non-empty, without surrounding space`);
  if (CONTROL.test(value)) throw new Error(`${kind} holds a control character`);
  if (extra?.test(value)) throw new Error(`${kind} ${JSON.stringify(value)} may not hold ${extra.source}`);
}

/** `rig:<rig>`: the id the app is given, and (rig-here `workspace_label`) the name it shows. */
export function rigSpaceId(rig: string): string {
  checkName("rig", rig, /\//);
  return `${SPACE_ID_PREFIX}${rig}`;
}

/** `rig:<rig>/<tab>`: unique across spaces. */
export function rigTabId(rig: string, tab: string): string {
  checkName("tab", tab, /\//);
  return `${rigSpaceId(rig)}${TAB_ID_SEPARATOR}${tab}`;
}

export function placementLabels(rig: string, tab: string): Record<string, string> {
  return { [SPACE_LABEL]: rigSpaceId(rig), [TAB_LABEL]: rigTabId(rig, tab) };
}

/** The rig of a canonical seat name `<pod>-<member>@<rig>`. */
export function rigOfSeat(seat: string): string {
  const at = seat.lastIndexOf("@");
  if (at <= 0 || at === seat.length - 1) throw new Error(`seat ${JSON.stringify(seat)} is not <pod>-<member>@<rig>`);
  return seat.slice(at + 1);
}

/** rig-here `pick_lead`: the Chief of Staff, else the first seat that looks like a lead, else the first seat. */
export function pickLead(seats: readonly string[]): string {
  const first = seats[0];
  if (first === undefined) throw new Error("a rig with no seats has no lead");
  return seats.find((s) => s.startsWith("exec-cos@"))
    ?? seats.find((s) => /(^|[.-])(exec|cos|lead|orch)[.-]/.test(s))
    ?? first;
}

export interface PlannedTab {
  /** The tab's display name (rig-here's tab name). */
  name: string;
  /** The label value the app is given. */
  id: string;
  seats: string[];
}

/** rig-here `rig_tabs`: the lead alone in `cos`, every other seat in `team`. An empty tab is not planned. */
export function planRigTabs(rig: string, seats: readonly string[]): PlannedTab[] {
  rigSpaceId(rig);
  for (const seat of seats) {
    if (rigOfSeat(seat) !== rig) throw new Error(`seat ${seat} belongs to rig ${rigOfSeat(seat)}, not ${rig}`);
  }
  if (new Set(seats).size !== seats.length) throw new Error("a seat appears twice");
  const lead = pickLead(seats);
  const tabs: PlannedTab[] = [{ name: "cos", id: rigTabId(rig, "cos"), seats: [lead] }];
  const rest = seats.filter((s) => s !== lead);
  if (rest.length > 0) tabs.push({ name: "team", id: rigTabId(rig, "team"), seats: rest });
  return tabs;
}

/** rig-here `tile_kernel`: the human seat alone. */
export function planKernelTabs(humanSeat: string): PlannedTab[] {
  if (rigOfSeat(humanSeat) !== KERNEL_RIG) throw new Error(`seat ${humanSeat} is not a kernel seat`);
  return [{ name: KERNEL_TAB, id: rigTabId(KERNEL_RIG, KERNEL_TAB), seats: [humanSeat] }];
}

/** The labels each seat of a plan carries. */
export function planLabels(rig: string, tabs: readonly PlannedTab[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const tab of tabs) for (const seat of tab.seats) out.set(seat, placementLabels(rig, tab.name));
  return out;
}

/** What `herdr-app ls` answers (rig-here reads exactly these fields; herdr-app 0.1.10). */
export interface AppLs {
  spaces: { id: string; name: string; tabs: { id: string; name: string; terminals: { terminal: string; pane: string }[] }[] }[];
}

/** The app, injected. The real one is `herdr-app do <command> <json>` and `herdr-app ls`; tests never run it. */
export interface AppPort {
  ls(): Promise<AppLs>;
  do(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface PlacementOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Reads of the terminal while waiting for the app to apply a park (guide: park acknowledges `pending: true`). */
  attempts?: number;
  intervalMs?: number;
}

export type ParkOutcome =
  | "parked"               // the app took the pane away and the app's labels are gone
  | "already_parked"       // it carried no app label: nothing shows it
  | "finished"             // nothing alive to protect
  | "not_found"
  | "unconfirmed"          // the app was told, the labels did not go within the wait: treat as still in its pane
  | "app_failed"
  | "transport_unavailable"
  | "refused";

export type ShowOutcome = "shown" | "finished" | "not_found" | "transport_unavailable" | "refused";

export interface ParkResult { seat: string; outcome: ParkOutcome }
export interface ShowResult { seat: string; outcome: ShowOutcome; /** core keep was on after labelling and was turned off */ keepTurnedOff: boolean }

export interface ParkReport {
  results: ParkResult[];
  /** True only when no seat of it can be killed by closing its tab or space. Anything unconfirmed is not safe. */
  safeToClose: boolean;
}

const SAFE: ReadonlySet<ParkOutcome> = new Set(["parked", "already_parked", "finished", "not_found"]);

type SeatTerminal = HcTerminal & { keep?: boolean };

const isPlaced = (t: HcTerminal): boolean => SPACE_LABEL in t.labels || TAB_LABEL in t.labels;

export class HcPlacement {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private readonly intervalMs: number;

  constructor(private readonly client: Pick<HcClient, "call">, private readonly app: AppPort, options: PlacementOptions = {}) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.attempts = options.attempts ?? 20;
    this.intervalMs = options.intervalMs ?? 250;
  }

  /** Show a seat in a tab: both labels together, since a re-show with the tab alone did nothing (design 5). The app
   *  adopts a labelled terminal and, per the guide, enables core keep; seats run without keep so that a lost seat reads
   *  as lost, so keep is turned off again here. The app applies adoption asynchronously: UNVERIFIED whether it can
   *  re-enable keep after this check, so a reconcile that runs again should call `show` again (idempotent). */
  async show(seat: string, rig: string, tab: string): Promise<ShowResult> {
    const labels = placementLabels(rig, tab);
    const terminal = hcTerminalName(seat);
    try {
      const before = await this.client.call<SeatTerminal>("terminal.get", { terminal });
      if (before.state !== "live") return { seat, outcome: "finished", keepTurnedOff: false };
      const after = await this.client.call<SeatTerminal>("terminal.label", { terminal, labels });
      let keepTurnedOff = false;
      if (after.keep === true) {
        await this.client.call("terminal.keep", { terminal, keep: false });
        keepTurnedOff = true;
      }
      return { seat, outcome: "shown", keepTurnedOff };
    } catch (err) {
      return { seat, outcome: this.failure(err), keepTurnedOff: false };
    }
  }

  /** Show every seat of a plan, in plan order (the app splits label-placed panes in order: design 5). */
  async showTabs(tabs: readonly PlannedTab[]): Promise<ShowResult[]> {
    const out: ShowResult[] = [];
    for (const tab of tabs) {
      for (const seat of tab.seats) out.push(await this.show(seat, rigOfSeat(seat), tab.name));
    }
    return out;
  }

  /** Take a seat's pane away: it keeps running (guide, design 5). `terminal.park` is an APP command, not an hc method
   *  (it is not among the schema's 32), and it strips the app's labels (design 5), which is how completion is read. */
  async park(seat: string): Promise<ParkResult> {
    const name = hcTerminalName(seat);
    try {
      const terminal = await this.client.call<SeatTerminal>("terminal.get", { terminal: name });
      if (terminal.state !== "live") return { seat, outcome: "finished" };
      if (!isPlaced(terminal)) return { seat, outcome: "already_parked" };
      try {
        await this.app.do("terminal.park", { terminal: terminal.address });
      } catch {
        return { seat, outcome: "app_failed" };
      }
      for (let attempt = 0; attempt < this.attempts; attempt++) {
        const now = await this.client.call<SeatTerminal>("terminal.get", { terminal: name });
        if (now.state !== "live") return { seat, outcome: "finished" };
        if (!isPlaced(now)) return { seat, outcome: "parked" };
        await this.sleep(this.intervalMs);
      }
      return { seat, outcome: "unconfirmed" };
    } catch (err) {
      return { seat, outcome: this.failure(err) };
    }
  }

  /** Park every live seat of `rig` that is in a pane, or only those in `tab`. Seats are found by `openrig.seat`, not by
   *  the app's labels: a label filter is an exact match, and a parked seat has none. Close only if `safeToClose`. */
  async parkRig(rig: string, tab?: string): Promise<ParkReport> {
    rigSpaceId(rig);
    const wantedTab = tab === undefined ? undefined : rigTabId(rig, tab);
    let listed: HcTerminal[];
    try {
      listed = (await this.client.call<{ terminals: HcTerminal[] }>("terminal.list", {})).terminals;
    } catch (err) {
      // An unreadable core is not an empty rig: nothing is known, so nothing is safe.
      return { results: [{ seat: `*@${rig}`, outcome: this.failure(err) }], safeToClose: false };
    }
    const seats = listed
      .filter((t) => t.state === "live" && typeof t.labels[SEAT_LABEL] === "string" && sameRig(t.labels[SEAT_LABEL], rig))
      .filter((t) => wantedTab === undefined || t.labels[TAB_LABEL] === wantedTab)
      .flatMap((t) => t.labels[SEAT_LABEL] ?? []);
    const results: ParkResult[] = [];
    for (const seat of seats) results.push(await this.park(seat));
    return { results, safeToClose: results.every((r) => SAFE.has(r.outcome)) };
  }

  /** The app names a label-made space or tab by position (design 5), so give them their names. Found by the seat's
   *  terminal in `herdr-app ls`, not by assuming the app's ids equal the label values. Returns what was renamed. */
  async nameShown(rig: string, tabs: readonly PlannedTab[]): Promise<string[]> {
    const ls = await this.app.ls();
    const done: string[] = [];
    for (const planned of tabs) {
      const first = planned.seats[0];
      if (first === undefined) continue;
      const address = (await this.client.call<HcTerminal>("terminal.get", { terminal: hcTerminalName(first) })).address;
      for (const space of ls.spaces) {
        for (const tab of space.tabs) {
          if (!tab.terminals.some((t) => t.terminal === address)) continue;
          if (space.name !== rigSpaceId(rig) && !done.includes(`space:${space.id}`)) {
            await this.app.do("space.rename", { id: space.id, name: rigSpaceId(rig) });
            done.push(`space:${space.id}`);
          }
          if (tab.name !== planned.name) {
            await this.app.do("tab.rename", { id: tab.id, name: planned.name });
            done.push(`tab:${tab.id}`);
          }
        }
      }
    }
    return done;
  }

  private failure(err: unknown): "not_found" | "transport_unavailable" | "refused" {
    if (err instanceof HcError && err.kind === "not_found") return "not_found";
    if (err instanceof HcUnavailableError || err instanceof HcOutcomeUnknownError) return "transport_unavailable";
    if (err instanceof HcError) return "refused";  // the kind only, never the core's text
    throw err;
  }
}

function sameRig(seat: string, rig: string): boolean {
  try {
    return rigOfSeat(seat) === rig;
  } catch {
    return false;
  }
}
