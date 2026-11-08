import { parseSqliteUtcMs } from "../sqlite-time.js";

// OF-278 — what a person or a sending peer may be told about messages that wait for a seat. On 2026-11-07 seven rig messages sat for
// 160 to 382 min behind one open question, and nothing said so ("Accepted, not yet received" named only the seat's own state).
// This is the one reading of those rows: how many are open for the seat and how old the oldest is. It decides nothing.

/** An open message younger than this is a delivery in flight, not a wait; nothing is shown for it. */
export const HELD_NOTICE_AFTER_MS = 60_000;

export interface HeldMessages {
  /** Open messages for the seat (accepted, or attempting and not yet received). */
  count: number;
  /** When the oldest one was accepted, ISO. */
  oldestAt: string;
  /** "3 held, oldest 381m" */
  line: string;
}

export function formatHeldAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 120 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The held reading for a seat's open rows, or null when there is nothing worth saying (none, or only a delivery in flight). */
export function describeHeld(open: { open: number; oldestAcceptedAt: string } | null | undefined, nowMs: number): HeldMessages | null {
  if (!open || open.open < 1) return null;
  const acceptedMs = parseSqliteUtcMs(open.oldestAcceptedAt);
  if (!Number.isFinite(acceptedMs)) return null;
  const ageMs = Math.max(0, nowMs - acceptedMs);
  if (ageMs < HELD_NOTICE_AFTER_MS) return null;
  return { count: open.open, oldestAt: new Date(acceptedMs).toISOString(), line: `${open.open} held, oldest ${formatHeldAge(ageMs)}` };
}
