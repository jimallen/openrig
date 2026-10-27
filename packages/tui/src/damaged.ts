// OF-146: the TUI side of the daemon's "this saved row is damaged" markers (OF-117, shown in the CLI and UI by OF-136).
//
// The daemon serves a queue item whose saved JSON column (tags, chain_of_record, human questions or answers) cannot be read
// flagged `unreadable: [columns]`, with the damaged field read as null. A list that shows the null as an ordinary blank
// tells the reader "no tags"; the truth is "unknown". Damage fails toward SHOWING: any present, non-empty marker is damage
// (one that names no column reads as "unknown columns"); only absent, null, "", [] and false are readable.

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

/** "DAMAGED: tags unreadable" — the one phrase every TUI list shows for a damaged row; "" for a readable one. */
export function damagedPhrase(row: { unreadable?: unknown } | null | undefined): string {
  const columns = damagedColumns(row);
  return columns.length > 0 ? `DAMAGED: ${columns.join(", ")} unreadable` : "";
}
