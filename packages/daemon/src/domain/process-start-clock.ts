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
