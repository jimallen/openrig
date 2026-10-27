// OF-51: a JSON column of a saved row that a ROUTE reads is read through here, never `JSON.parse`d bare. A hand-edited,
// truncated or otherwise damaged column must not turn a read route into a 500 for every row that shares the table; the
// damaged value reads as ABSENT (`undefined` / `null`) and the rows beside it are served.
//
// Only for readers whose callers do not DECIDE on the value: a reader a decision rests on (the queue item behind the
// prompt-blocked alert, the inbox absorb, the outbox guard binding, the workflow frontier the projector rewrites)
// carries an explicit unreadable answer instead (OF-117, unreadable-row.ts): it refuses by name (UnreadableRowError, HTTP 422)
// or, in a listing, serves the row flagged `unreadable`, as node-inventory.ts does for the node row (OF-45).
// Reading a damaged column there as "absent" would turn a refusal into a silent wrong answer.
//
// This is for columns the daemon wrote itself. Operator-authored files and request bodies keep their own errors.

/** The column's parsed value, or `undefined` when the text is missing or is not JSON. A literal JSON `null` is `null`. */
export function readStoredJson<T = unknown>(text: string | null | undefined): T | undefined {
  if (text === null || text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** A stored JSON column that must be an object: anything else (damaged text, an array, a scalar, null) is `null`. */
export function readStoredJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(text: string | null | undefined): T | null {
  const value = readStoredJson<unknown>(text);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as T : null;
}

/** A stored JSON column that must be a list of strings (tags, key artifacts): anything else is `null`. */
export function readStoredJsonStrings(text: string | null | undefined): string[] | null {
  const value = readStoredJson<unknown>(text);
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : null;
}
