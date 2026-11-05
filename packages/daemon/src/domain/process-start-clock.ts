// OF-220 — when a process really started, as a port the domain owns.
//
// The domain stores a process's start time as part of its identity (`pid` + start: a reused pid starts later) and
// orders other facts against it (a Codex log row, a transcript turn, a status-line sample is "of this process" only when
// it is later than the start). Every such reader assumes the start second it holds is the one the process truly began in:
// the true start lies in [L, L+1) seconds.
//
// `ps -o lstart=` keeps that promise on macOS (measured, OF-220: 0.010 to 0.999 s, 60 of 60 spawns) and breaks it on
// Linux. procps dates a process as /proc/stat `btime` (whole seconds, truncated) plus the process's start tick, then cuts
// to whole seconds again, so `lstart` can name a second up to two seconds before the process began, by an amount fixed
// for the boot (Sparky, boot of 2026-11-03: btime fraction 0.199 s, true start minus lstart 0.213 to 1.187 s over 200
// spawns, 41 of 200 a whole second or more). A row logged by a retired occupant of a reused pid inside that margin then
// passes the gate as the new occupant's.
//
// The kernel dates a process exactly: starttime (ticks since boot, /proc/<pid>/stat) against /proc/uptime. The adapter
// that reads those implements this port; the domain keeps its `lstart` string format, so every stored identity and every
// parser stays as it was, and only the second the string names becomes the true one.

/** Dates processes by the OS's own boot clock. */
export interface ProcessStartClock {
  /** Epoch ms at which each requested pid began. A pid that is gone or cannot be read is absent from the map. */
  startedAtMs(pids: readonly number[]): Promise<ReadonlyMap<number, number>>;
}

/**
 * Where a boot instant, once measured, is kept for the rest of that boot (OF-230). The platform's boot id names the boot: a
 * record of another boot is not this boot's. The adapter reads the id and owns the file; the domain only names the need.
 */
export interface BootInstantStore {
  /** The boot instant (epoch ms) kept for this boot id, or null when none is kept for it or the record cannot be read. */
  read(bootId: string): Promise<number | null>;
  /** Keep the boot instant for this boot id (replacing a record of any other boot). */
  write(bootId: string, bootMs: number): Promise<void>;
}

let installed: ProcessStartClock | null = null;

/** The composition root installs the platform's clock once (null: the platform has none, `ps` lstart stands). */
export function installProcessStartClock(clock: ProcessStartClock | null): void {
  installed = clock;
}

export function installedProcessStartClock(): ProcessStartClock | null {
  return installed;
}

/** How far after the `ps` second the true start may fall and still be that process: two seconds (btime's lost fraction plus
 *  the second `ps` cuts again) and the tick and read error. */
export const CLOCK_START_MAX_AFTER_PS_MS = 2_050;
/** How far before the `ps` second a clock reading may fall: none, bar the read error. */
export const CLOCK_START_MAX_BEFORE_PS_MS = 50;

/**
 * The clock's reading for a pid, when it is the same process `ps` described. `ps` and the clock are read at different
 * moments: a pid reused in between would be dated by the newcomer. A genuine reading lies within [L, L+2) s of the `ps`
 * second; anything else is a different process and the `ps` value stands (null).
 */
export function clockStartForPsStart(psLstartMs: number, clockStartMs: number | undefined): number | null {
  if (clockStartMs === undefined || !Number.isFinite(psLstartMs)) return null;
  const after = clockStartMs - psLstartMs;
  return after >= -CLOCK_START_MAX_BEFORE_PS_MS && after < CLOCK_START_MAX_AFTER_PS_MS ? clockStartMs : null;
}

/** How far apart, for one pid, two readings of the same process's start may name (OF-230): one whole second. A start is a
 *  second-granular string; the true second and the second the old `ps` clock named differ by at most one (the true start lies
 *  in [L, L+2) s of the second `ps` named), and a boot instant re-measured within its jitter can move a start across one
 *  second boundary. Two seconds apart is never the same reading of one process. */
export const SAME_PROCESS_START_TOLERANCE_MS = 1_000;

export interface ProcessIdentity { pid: number | null; startedAt?: string | null }

/**
 * Whether two stored/observed identities are one process. The pid must be equal, always. The start must be equal, or, where a
 * boot clock is installed (Linux: starts are dated by it, and a value stored under the old `ps` clock or across a boundary flap
 * can differ by a second), within SAME_PROCESS_START_TOLERANCE_MS. Where no clock is installed (macOS: `ps` is deterministic)
 * the comparison is the exact string it always was.
 *
 * A reused pid cannot pass: a different process on the same pid needs the old one gone and the kernel's pid counter to wrap
 * its whole range inside that second or two (pid_max is 32768 or more), and every caller binds the identity to more than the
 * start (the launch token in argv, the pane's process chain).
 */
export function sameProcessIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  if (a.pid === null || b.pid === null || a.pid !== b.pid) return false;
  const left = a.startedAt ?? null;
  const right = b.startedAt ?? null;
  if (left === right) return true;
  if (left === null || right === null || installed === null) return false;
  const leftMs = parsePsLstartMs(left);
  const rightMs = parsePsLstartMs(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && Math.abs(leftMs - rightMs) <= SAME_PROCESS_START_TOLERANCE_MS;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The second an epoch instant falls in, written as `ps` writes lstart in the C locale ("Wed Nov  4 16:48:27 2026", local
 *  time, the day padded to two columns): the identity string every reader of a start time parses. */
export function formatPsLstart(epochMs: number): string {
  const d = new Date(Math.floor(epochMs / 1000) * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

/** Epoch ms of a `ps` lstart string (C locale, local time), or NaN. */
export function parsePsLstartMs(lstart: string): number {
  const m = lstart.trim().match(/^\w{3}\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/);
  return m ? Date.parse(`${m[1]} ${m[2]}, ${m[4]} ${m[3]}`) : Number.NaN;
}

/**
 * The same rows with each `startedAt` re-dated by the installed clock where it names the same process. Rows the clock cannot
 * date, and every row when no clock is installed or it fails, keep the `ps` string. Never throws.
 */
export async function withTrueStartTimes<T extends { pid: number; startedAt?: string }>(rows: T[]): Promise<T[]> {
  const clock = installed;
  if (!clock || rows.length === 0) return rows;
  let starts: ReadonlyMap<number, number>;
  try { starts = await clock.startedAtMs(rows.map((row) => row.pid)); } catch { return rows; }
  return rows.map((row) => {
    if (!row.startedAt) return row;
    const dated = clockStartForPsStart(parsePsLstartMs(row.startedAt), starts.get(row.pid));
    return dated === null ? row : { ...row, startedAt: formatPsLstart(dated) };
  });
}
