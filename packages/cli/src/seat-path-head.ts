// workspaces-o9o.106: whether the running seats on this host have the seat PATH head. The daemon starts every seat's
// runtime with PATH = <OPENRIG_HOME>/run/seat-bin/<hash>, then <OPENRIG_HOME>/rig-bin (the git worktree shim), ahead of
// every entry the pane's rc put first (SeatLaunchEnvironment.pathHead, cbc6faf73). A seat launched before that head
// existed keeps the old PATH for as long as it runs: rig-bin buried behind the rc's entries, so its git is not the shim
// (o9o.104: every sparky seat launched before the 2026-11-16 21:21 CET daemon restart). A process's environment cannot
// change after it starts, so the remedy is a relaunch. Pure: the processes are read by the caller.
import path from "node:path";

/** A process on this host that belongs to a seat (it carries OPENRIG_SESSION_NAME), with its PATH entries in order. */
export interface SeatProcess {
  pid: number;
  session: string;
  /** Its OPENRIG_HOME: the instance the seat belongs to (a test scaffold's seats carry their own). */
  home: string | null;
  path: string[];
  /** Its command line (workspaces-o9o.173: a Claude seat's carries the guard hook); absent where it was not read. */
  argv?: string[];
}

/** Whether a PATH starts with the seat PATH head: a folder directly inside a `seat-bin` folder, then a `rig-bin` folder. */
export function hasSeatPathHead(entries: string[]): boolean {
  return entries.length >= 2
    && path.basename(path.dirname(entries[0]!)) === "seat-bin"
    && path.basename(entries[1]!) === "rig-bin";
}

/** The doctor row. A seat has the head when ANY of its processes does: the pane's own login shell never has it (the head
 *  is prepended to the launch command), its runtime and the tools it runs do. `null` processes: this platform's process
 *  environments cannot be read, so nothing is claimed. */
export function buildSeatPathHeadCheck(processes: SeatProcess[] | null, openrigHome: string): { name: string; status: "pass" | "warn" | "skipped"; message: string } {
  const name = "running_seats_path_head";
  if (processes === null) {
    return { name, status: "skipped", message: "Seat PATH head not checked: process environments are read from /proc, which this platform does not have." };
  }
  // Only this instance's seats: a test scaffold's daemon runs seats of its own, with its own OPENRIG_HOME.
  const home = path.resolve(openrigHome);
  const seats = new Map<string, boolean>();
  for (const p of processes) {
    if (p.home === null || path.resolve(p.home) !== home) continue;
    seats.set(p.session, (seats.get(p.session) ?? false) || hasSeatPathHead(p.path));
  }
  if (seats.size === 0) return { name, status: "skipped", message: `Seat PATH head not checked: no seat process of ${home} on this host.` };
  const seatsWord = seats.size === 1 ? "seat" : "seats";
  const stale = [...seats].filter(([, current]) => !current).map(([session]) => session).sort();
  if (stale.length === 0) {
    return { name, status: "pass", message: `${seats.size} ${seatsWord} of ${home} on this host ${seats.size === 1 ? "has" : "have"} the seat PATH head (seat-bin, then rig-bin).` };
  }
  return {
    name,
    status: "warn",
    message: `${stale.length} of ${seats.size} ${seatsWord} of ${home} on this host ${stale.length === 1 ? "was" : "were"} launched before the seat PATH head, so the git worktree shim `
      + `does not apply to them: ${stale.join(", ")}. A running seat keeps the PATH it started with; relaunch to adopt.`,
  };
}
