import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lastMeaningfulTransition } from "./queue-waiting.js";

/** Common provenance on existing diagnostic queue rows, never a second ledger.
 * Both deadline and delivery detectors consult the same recovery disposition. */
export const recoveryTag = (qitemId: string): string => `recovery-for:${qitemId}`;
function failedAttempt(db: Database.Database, qitemId: string): string | null {
  // A typing-guard refusal (retained:) is newer evidence about the original
  // obligation exactly like a failed nudge: a wake WAS offered after the
  // recovery disposition was written (#344). Without this arm the refusal was
  // invisible here — ladder attempt markers never count as meaningful
  // transitions — so a terminal recovery stayed fresh forever and suppressed
  // the unclaimed baton's retry path.
  return (db.prepare("SELECT last_nudge_attempt AS at FROM queue_items WHERE qitem_id = ? AND (last_nudge_result LIKE 'failed:%' OR last_nudge_result LIKE 'retained:%')").get(qitemId) as { at: string | null } | undefined)?.at ?? null;
}
export function recoveryId(db: Database.Database, qitemId: string): string {
  return `qitem-recovery-${createHash("sha256").update(JSON.stringify([qitemId, lastMeaningfulTransition(db, qitemId)?.id ?? null, failedAttempt(db, qitemId)])).digest("hex").slice(0, 16)}`;
}
/** Rows whose tag text could hold a recovery tag: valid JSON stores a string verbatim or with
 * backslash escapes, so this superset loses no exact match. It repeats the first group of
 * idx_queue_items_recovery_tags' WHERE clause (migration 099) byte for byte, which is what lets the
 * planner read that small index instead of scanning and parsing every row. */
const RECOVERY_TAG_ROWS = `(tags LIKE '%"recovery-for:%' OR tags LIKE '%\\%')`;
const RECOVERY_ORDER = "ORDER BY CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1";
/** A recovery row found by the text of its tags only, because the tags column is not readable JSON (OF-143). It still exists
 * and still holds the link, so it is not "no recovery": every caller reads the row by id next (which names it) and leaves the
 * original alone, instead of retrying, exhausting or re-opening a finding on a guess. A row whose tags were overwritten so
 * that the quoted link text is gone cannot be found here at all (the same residual as OF-147's tags overwrite). */
export interface QueueRecoveryRef { qitemId: string; state: string; unreadable?: true }
const OPEN_STATES = ["pending", "in-progress", "blocked"];
type RecoveryCandidate = { qitem_id: string; state: string; ts_updated: string };
export function findQueueRecovery(db: Database.Database, qitemId: string): QueueRecoveryRef | null {
  const tag = recoveryTag(qitemId);
  // The readable lookup is the pre-OF-143 statement, byte for byte (migration 099's index, one bound tag, the same row choice).
  const row = db.prepare(`SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE ${RECOVERY_TAG_ROWS} AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    ${RECOVERY_ORDER}`)
    .get(tag) as RecoveryCandidate | undefined;
  // A READABLE open recovery owns the continuation whatever else exists. Otherwise a recovery whose tags are damaged is looked
  // for by the quoted link text (instr: exact, no wildcards, so recovery-for:a never matches recovery-for:ab): it must not read
  // as absent. Same index (its WHERE term is repeated), and only rows whose tag text could carry a recovery tag are parsed.
  const damaged = row && OPEN_STATES.includes(row.state) ? undefined : db.prepare(`SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE ${RECOVERY_TAG_ROWS} AND NOT json_valid(tags) AND instr(tags, '"' || ? || '"') > 0
    ${RECOVERY_ORDER}`)
    .get(tag) as RecoveryCandidate | undefined;
  // A closed disposition stops counting once the original changed after it (shared with the readable case).
  const current = (candidate: RecoveryCandidate): boolean => {
    if (OPEN_STATES.includes(candidate.state)) return true;
    const changed = lastMeaningfulTransition(db, qitemId);
    const disposition = lastMeaningfulTransition(db, candidate.qitem_id);
    return !((changed && disposition && changed.id > disposition.id) || (changed && Date.parse(changed.at) > Date.parse(candidate.ts_updated)) || Date.parse(failedAttempt(db, qitemId) ?? "") > Date.parse(candidate.ts_updated));
  };
  if (row && OPEN_STATES.includes(row.state)) return { qitemId: row.qitem_id, state: row.state };
  if (damaged && current(damaged)) return { qitemId: damaged.qitem_id, state: damaged.state, unreadable: true };
  if (row && current(row)) return { qitemId: row.qitem_id, state: row.state };
  return null;
}
