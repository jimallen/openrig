// OF-168: the shared shape of "these rows could not be read" naming, so every list is bounded the same way and says how many it left out.

/** At most this many row ids are spelled out in one message, log line or result; the rest are counted ("and N more"). */
export const NAMED_ROWS_LIMIT = 20;

/** "a, b, c and 2 more": the first `limit` ids, then the count of the rest. `total` is the full count when `ids` was cut short. */
export function namedRows(ids: readonly string[], total: number = ids.length, limit: number = NAMED_ROWS_LIMIT): string {
  const shown = ids.slice(0, limit);
  const more = total - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

const THROTTLE_MS = 10 * 60_000;
const lastNamed = new Map<string, number>();

/** For tests only: forget what was logged. */
export function resetNamedRowThrottle(): void {
  lastNamed.clear();
}

/**
 * A repeated lookup (a poller listing the same tag every few seconds) would name the same damaged row on every call. Each (scope, row)
 * is named at most once per 10 minutes; `emit` is called with the ids that are due (and their count), or not at all when none are.
 */
export function nameRowsThrottled(scope: string, ids: readonly string[], emit: (due: string[], total: number) => void, now: number = Date.now()): void {
  for (const [key, at] of lastNamed) if (now - at >= THROTTLE_MS) lastNamed.delete(key);
  const due = ids.filter((id) => !lastNamed.has(`${scope}\u0000${id}`));
  if (due.length === 0) return;
  for (const id of due) lastNamed.set(`${scope}\u0000${id}`, now);
  emit(due, due.length);
}
