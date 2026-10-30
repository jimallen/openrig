// OF-117: the explicit "this saved row cannot be read" answer for a row a DECISION or a listing rests on.
//
// stored-json.ts (OF-51) reads a damaged display column as ABSENT, which is wrong where a decision rests on the value:
// a queue item whose `tags` are damaged is not an item with no tags (the gate roles, the health-traffic exclusion, the
// recovery links all live there). Those readers used to call `JSON.parse` bare, so one damaged column ended in a
// SyntaxError, which every route answered as HTTP 500, for every row that shared the table.
//
// A reader that meets a damaged column now does one of two named things, never a bare throw and never "absent":
//   - REFUSE: throws UnreadableRowError, which names the table, the row and the damaged columns. A route that does not
//     catch it answers 422 `saved_row_unreadable` (UnreadableRowError.getResponse, through the app's onError); a loop that
//     walks many rows names the row and moves on.
//   - MARK (listings only): the row is served with the damaged columns read as empty AND `unreadable: [columns]` on it, so
//     the rows beside it are served and the damaged one is named, as node-inventory.ts does for the node row (OF-45).
//
// For columns the daemon wrote itself. Operator-authored files and request bodies keep their own errors.

/** A saved row that a decision rests on has a column that is not what the daemon wrote. */
export class UnreadableRowError extends Error {
  readonly code = "saved_row_unreadable";
  constructor(readonly table: string, readonly rowId: string, readonly columns: readonly string[]) {
    super(`Saved ${table} row ${rowId} is damaged: ${columns.join(", ")} ${columns.length === 1 ? "is" : "are"} not readable JSON. Repair or remove the row.`);
    this.name = "UnreadableRowError";
  }

  /** The app-level error handler (middleware/json-body-error.ts) answers an error that carries `getResponse()` with it: a
   *  route that does not catch this answers 422 with the row named, not a bare 500. */
  getResponse(): Response {
    return new Response(JSON.stringify({ error: this.message, code: this.code, table: this.table, rowId: this.rowId, columns: this.columns }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }
}

export function isUnreadableRowError(error: unknown): error is UnreadableRowError {
  return error instanceof UnreadableRowError;
}

/** Collects the damaged columns of ONE row while it is read, then either refuses (throws) or hands the names to the caller. */
export class RowColumnReader {
  private readonly damaged: string[] = [];
  constructor(private readonly table: string, private readonly rowId: string) {}

  /** Parses `text` (null/empty -> `null`). A damaged column is recorded and reads as `null`. */
  json<T>(column: string, text: string | null | undefined): T | null {
    if (text === null || text === undefined || text === "") return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      this.damaged.push(column);
      return null;
    }
  }

  /** For a column the row cannot exist without: missing, empty and a literal JSON `null` are damage too. */
  required<T>(column: string, text: string | null | undefined): T | null {
    const value = this.json<T>(column, text);
    if (value === null && !this.damaged.includes(column)) this.damaged.push(column);
    return value;
  }

  /** Like `json`, but the parsed value must be a list of strings (tags); anything else is damage. */
  strings(column: string, text: string | null | undefined): string[] | null {
    const value = this.json<unknown>(column, text);
    if (value === null) return null;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
    this.damaged.push(column);
    return null;
  }

  /** A column holding one value of a closed vocabulary (null/undefined -> `null`). A value outside it is recorded as
   *  damage and reads as `null`, as a damaged JSON column does (OF-179 F5). */
  oneOf<T extends string>(column: string, values: readonly T[], raw: string | null | undefined): T | null {
    if (raw === null || raw === undefined) return null;
    if ((values as readonly string[]).includes(raw)) return raw as T;
    this.damaged.push(column);
    return null;
  }

  /** The columns found damaged so far, in the order read. */
  get unreadable(): string[] {
    return [...this.damaged];
  }

  /** Refuse: throws when any column read through this reader was damaged. */
  refuseIfDamaged(): void {
    if (this.damaged.length > 0) throw new UnreadableRowError(this.table, this.rowId, this.damaged);
  }
}
