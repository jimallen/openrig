/** Absolute local presentation only. Source strings and ordering stay with the caller. */
export const DEFAULT_TIME_ZONE = "America/Los_Angeles";

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

export function displayTime(value: unknown, timeZone = DEFAULT_TIME_ZONE): string {
  if (typeof value !== "string") return "time unknown";
  // SQLite datetime('now') is UTC. Zone-less ISO timestamps are ambiguous, not local time.
  const stamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(" ", "T") + "Z" : value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp)) return "time unknown";
  const calendarDay = new Date(stamp.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== stamp.slice(0, 10)
    || Number(stamp.slice(11, 13)) > 23) return "time unknown";
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime())) return "time unknown";
  const zone = validTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date);
  const p = (name: string) => parts.find((part) => part.type === name)?.value ?? "?";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")} ${p("timeZoneName")}${zone !== timeZone ? " (timezone fallback)" : ""}`;
}

/**
 * An instant in the daemon's posture-line form (seat-posture.ts formatPostureTime): "16:05Z" on the clock's own UTC day, else "03-04 16:05Z".
 * With no clock (0) the date is always given. The TUI shows times in its own zone; this lets a line that does say which instant the daemon's
 * UTC posture line means (workspaces-o9o.32). Null when the value is not a time.
 */
export function postureClock(value: unknown, nowMs = 0): string | null {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  const time = `${iso.slice(11, 16)}Z`;
  return nowMs > 0 && iso.slice(0, 10) === new Date(nowMs).toISOString().slice(0, 10) ? time : `${iso.slice(5, 10)} ${time}`;
}

export function resolveTimeZone(setting: unknown, readWarning = false): { timeZone: string; warning: string | null } {
  const timeZone = validTimeZone(setting) ? setting : DEFAULT_TIME_ZONE;
  return { timeZone, warning: validTimeZone(setting) && !readWarning ? null
    : `ui.timezone unavailable or invalid; using ${timeZone}. Run timezone for correction.` };
}
