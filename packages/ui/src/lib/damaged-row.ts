// OF-136: the UI side of the daemon's "this saved row is damaged" markers (OF-117).
//
// The daemon serves a saved row whose JSON column is unreadable with `unreadable: [columns]` on it (queue items, workflow
// instances and specs ...), the damaged fields read as null/empty BECAUSE of that, and it refuses every action on the row
// with HTTP 422 `saved_row_unreadable`. A surface must therefore show the row as damaged, name the columns, and not offer an
// action that would act on it.

/** The marker is `string[]` today. Damage fails toward SHOWING: any present, non-empty marker is damage, and one that does not
 *  name columns (a string, an object, `[""]`) is shown as "unknown columns". Only absent, null, "", `[]` and false are readable. */
export function damagedColumns(row: { unreadable?: unknown } | null | undefined): string[] {
  const marker = row?.unreadable;
  if (Array.isArray(marker)) {
    if (marker.length === 0) return [];
    const named = marker.map(String).filter((c) => c.length > 0);
    return named.length > 0 ? named : ["unknown columns"];
  }
  if (marker === undefined || marker === null || marker === "" || marker === false) return [];
  return typeof marker === "string" ? [marker] : ["unknown columns"];
}

export function isDamagedRow(row: { unreadable?: unknown } | null | undefined): boolean {
  return damagedColumns(row).length > 0;
}

/** The one sentence every surface shows beside a damaged row. */
export function damagedExplanation(columns: readonly string[]): string {
  return `Saved ${columns.join(", ")} cannot be read. What is blank here is unknown, not empty. Nothing can act on this row until it is repaired or removed.`;
}

/** The daemon's refusal of a read or action on a damaged row, kept apart from an ordinary HTTP failure. */
export class SavedRowUnreadableError extends Error {
  readonly table: string;
  readonly rowId: string;
  readonly columns: string[];
  constructor(body: { error?: unknown; table?: unknown; rowId?: unknown; columns?: unknown }) {
    super(typeof body.error === "string" ? body.error : "A saved row is damaged and cannot be read.");
    this.name = "SavedRowUnreadableError";
    this.table = typeof body.table === "string" ? body.table : "saved";
    this.rowId = typeof body.rowId === "string" ? body.rowId : "";
    this.columns = Array.isArray(body.columns) ? body.columns.map(String) : [];
  }
}

type RefusalBody = { code?: unknown; error?: unknown; table?: unknown; rowId?: unknown; columns?: unknown };

async function readBody(res: Response): Promise<RefusalBody | null> {
  try {
    return (await res.clone().json()) as RefusalBody | null;
  } catch {
    return null;
  }
}

/** Throws SavedRowUnreadableError for a 422 `saved_row_unreadable` response; otherwise returns without consuming the body. */
export async function throwIfSavedRowUnreadable(res: Response): Promise<void> {
  if (res.status !== 422) return;
  const body = await readBody(res);
  if (body && body.code === "saved_row_unreadable") throw new SavedRowUnreadableError(body);
}
