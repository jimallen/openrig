// OF-51: a JSON column of a saved row is read through here, never `JSON.parse`d bare. A hand-edited, truncated or
// otherwise damaged column must not turn a read route into a 500 for every row that shares the table; the damaged
// value reads as ABSENT (the caller's stated fallback, or `undefined` from `readStoredJson`), and the callers whose
// decision depends on it either skip the row or carry the damage visibly (see snapshot-repository.ts,
// node-inventory.ts for the node-row markers).
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

/** `readStoredJson`, with the caller's fallback for a missing or damaged column. Never throws. */
export function parseStoredJson<T>(text: string | null | undefined, fallback: T): T {
  const value = readStoredJson<T>(text);
  return value === undefined ? fallback : value;
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
