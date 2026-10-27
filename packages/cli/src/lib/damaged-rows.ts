// OF-136: show the daemon's "this saved row is damaged" markers (OF-117) to a person at the terminal.
//
// Since OF-117 the daemon serves a saved row whose JSON column is not readable with `unreadable: [columns]` on it (queue
// items, inbox and outbox entries, workflow instances and specs, watchdog history), and names damaged held outbox rows in
// `unreadableHeld`. The damaged fields read as null/empty BECAUSE of that. A person looking at a table or a pretty-printed
// JSON body used to see an ordinary row with a blank where the tags were, and could act on it. The daemon refuses every action
// on such a row (HTTP 422 `saved_row_unreadable`), so the honest output says: this row is damaged, its blank fields are
// unknown, nothing will act on it, and what to do.
//
// Notices go to STDERR: stdout (the table, or the JSON an agent parses) is unchanged byte for byte.

import { formatThreePart, type ThreePartRejection } from "../commands/workflow-errors.js";

export type DamagedKind =
  | "queue item"
  | "inbox entry"
  | "outbox entry"
  | "held outbox entry"
  | "workflow instance"
  | "workflow spec"
  | "watchdog history entry";

export interface DamagedRow {
  id: string;
  columns: string[];
}

const ID_KEYS = ["qitemId", "inboxId", "outboxId", "historyId", "instanceId", "specId"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowId(row: Record<string, unknown>): string {
  for (const key of ID_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  // A workflow spec is addressed by name and version.
  if (typeof row.name === "string") return typeof row.version === "string" ? `${row.name} v${row.version}` : row.name;
  return "(unnamed row)";
}

/** The marker is `string[]` today. Damage fails toward SHOWING: any present, non-empty marker is damage, and one that does not
 *  name columns (a string, an object, `[""]`) is shown as "unknown columns". Only absent, null, "", `[]` and false are readable. */
export function damagedColumnsOf(marker: unknown): string[] {
  if (Array.isArray(marker)) {
    if (marker.length === 0) return [];
    const named = marker.map(String).filter((c) => c.length > 0);
    return named.length > 0 ? named : ["unknown columns"];
  }
  if (marker === undefined || marker === null || marker === "" || marker === false) return [];
  return typeof marker === "string" ? [marker] : ["unknown columns"];
}

/** The rows of a list response that carry a damage marker. The list may be the body itself or sit under one of `keys`. */
export function damagedRowsIn(body: unknown, ...keys: string[]): DamagedRow[] {
  const list: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body)
      ? (keys.map((key) => body[key]).find((value) => Array.isArray(value)) as unknown[] | undefined) ?? []
      : [];
  const found: DamagedRow[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const columns = damagedColumnsOf(row.unreadable);
    if (columns.length > 0) found.push({ id: rowId(row), columns });
  }
  return found;
}

/** The held outbox rows a node listing could not attribute to any node because their guard binding is damaged. */
export function unreadableHeldIn(body: unknown): DamagedRow[] {
  if (!isRecord(body) || !Array.isArray(body.unreadableHeld)) return [];
  return body.unreadableHeld.filter((id): id is string => typeof id === "string").map((id) => ({ id, columns: ["guard_binding"] }));
}

const KIND_NEXT: Record<DamagedKind, string> = {
  "queue item": "the daemon refuses to claim, update or hand it off, and the sweeps skip it",
  "inbox entry": "the daemon refuses to absorb it, because that would copy its unreadable tags into a queue item",
  "outbox entry": "the daemon refuses decisions that rest on it",
  "held outbox entry": "it is listed under no seat, and the daemon refuses to read or retire it by id",
  "workflow instance": "the daemon refuses to route, resume or project it, and the boot sweep skips it",
  "workflow spec": "the daemon refuses to instantiate from it",
  "watchdog history entry": "the policies that reconcile from its notes refuse it",
};

/** The stderr lines for a response that holds damaged rows. Empty when none. */
export function damagedRowsNotice(kind: DamagedKind, rows: DamagedRow[]): string[] {
  if (rows.length === 0) return [];
  const noun = `${kind}${rows.length === 1 ? "" : "s"}`;
  const lines = [`DAMAGED: ${rows.length} ${noun} could not be read in full. Fields that are blank or null on these rows are UNKNOWN, not "none":`];
  for (const row of rows) lines.push(`  ${row.id}: ${row.columns.join(", ")} not readable JSON`);
  lines.push(`Do not act on ${rows.length === 1 ? "it" : "them"} from this output: ${KIND_NEXT[kind]}. Repair or remove the saved row, then read it again.`);
  return lines;
}

/** Print the notice (stderr). Returns whether anything was printed. */
export function warnDamagedRows(kind: DamagedKind, rows: DamagedRow[]): boolean {
  const lines = damagedRowsNotice(kind, rows);
  for (const line of lines) process.stderr.write(`${line}\n`);
  return lines.length > 0;
}

interface RefusalBody {
  code?: unknown;
  table?: unknown;
  rowId?: unknown;
  columns?: unknown;
}

/** The what/why/fix for the daemon's refusal of an action or read on a damaged row (HTTP 422 saved_row_unreadable), or null. */
export function describeSavedRowRefusal(body: unknown): ThreePartRejection | null {
  if (!isRecord(body)) return null;
  const b = body as RefusalBody;
  if (b.code !== "saved_row_unreadable") return null;
  const table = typeof b.table === "string" ? b.table : "saved";
  const id = typeof b.rowId === "string" ? b.rowId : "(unnamed row)";
  const columns = Array.isArray(b.columns) ? b.columns.map(String).join(", ") : "a JSON column";
  return {
    fact: `The ${table} row ${id} is damaged: ${columns} is not readable JSON.`,
    consequence: "The daemon refused to read or act on it, because a blank would be taken for \"none\". Nothing was changed.",
    action: "Repair or remove that saved row, then retry. Other rows are unaffected.",
  };
}

/** Print the refusal in plain words (stderr) when the response is one. Returns whether it did. */
export function warnSavedRowRefusal(status: number, body: unknown): boolean {
  if (status < 400) return false;
  const refusal = describeSavedRowRefusal(body);
  if (!refusal) return false;
  for (const line of formatThreePart(refusal)) process.stderr.write(`${line}\n`);
  return true;
}
