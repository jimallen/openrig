import type Database from "better-sqlite3";

/** OF-159: the queue rows a lookup by tag cannot see because their `tags` column is not readable JSON.
 *
 * A SQL tag lookup (`json_valid(tags) AND ... json_each(tags)`) reads such a row as "not tagged", which is wrong wherever the
 * answer is acted on or listed: a damaged exception item is not "no exception item". This finds the rows by the quoted text of the
 * tags instead (`instr`: exact, no wildcards, so `instance:a` never matches `instance:ab`), so the caller can name them and
 * leave them alone. A row whose tags were overwritten so the quoted text is gone cannot be found here (the same residual as
 * findQueueRecovery's). The `instr` terms are cheap text tests written before the parse test.
 *
 * `without` is a tag the row must NOT carry (the readable lookups' NOT EXISTS terms). `states` limits to those states. */
export interface DamagedTagRow { qitemId: string; state: string; tsCreated: string }
export function findDamagedTagRows(
  db: Database.Database,
  query: { tags: readonly string[]; without?: string; states?: readonly string[] },
): DamagedTagRow[] {
  const where: string[] = [];
  const args: string[] = [];
  for (const tag of query.tags) { where.push(`instr(tags, '"' || ? || '"') > 0`); args.push(tag); }
  if (query.without !== undefined) { where.push(`instr(tags, '"' || ? || '"') = 0`); args.push(query.without); }
  if (query.states?.length) { where.push(`state IN (${query.states.map(() => "?").join(", ")})`); args.push(...query.states); }
  return (db.prepare(`SELECT qitem_id, state, ts_created FROM queue_items WHERE ${where.join(" AND ")} AND NOT json_valid(tags)
    ORDER BY ts_created, qitem_id`).all(...args) as Array<{ qitem_id: string; state: string; ts_created: string }>)
    .map((row) => ({ qitemId: row.qitem_id, state: row.state, tsCreated: row.ts_created }));
}
