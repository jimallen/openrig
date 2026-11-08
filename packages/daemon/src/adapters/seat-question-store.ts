import type Database from "better-sqlite3";
import type { SeatQuestionRepository, SeatQuestionRow, SeatQuestionState } from "../domain/seat-question-policy.js";

// OF-278 — the SQLite side of the record of questions seats put to the human (migration 128). Every move is a compare-and-set on `state`.

interface Row {
  id: string; rig_id: string; node_id: string; session_name: string; generation: string | null; state: string; tool_input: string;
  asked_at: string; due_at: string | null; settled_at: string | null; logged_at: string | null; noted_at: string | null; answers: string | null; note: string | null;
}

function toRow(r: Row): SeatQuestionRow {
  const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
  return {
    id: r.id, rigId: r.rig_id, nodeId: r.node_id, sessionName: r.session_name, generation: r.generation, state: r.state as SeatQuestionState,
    toolInput: parse(r.tool_input), askedAt: r.asked_at, dueAt: r.due_at, settledAt: r.settled_at, loggedAt: r.logged_at, notedAt: r.noted_at,
    answers: parse(r.answers) as Record<string, string> | null, note: r.note,
  };
}

/** Every move is a compare-and-set on `state`, so the database, not memory, says what became of a question. */
export class SqliteSeatQuestionStore implements SeatQuestionRepository {
  constructor(private readonly db: Database.Database) {}

  get(id: string): SeatQuestionRow | null {
    const row = this.db.prepare("SELECT * FROM seat_questions WHERE id = ?").get(id) as Row | undefined;
    return row ? toRow(row) : null;
  }

  insert(row: { id: string; rigId: string; nodeId: string; sessionName: string; generation: string | null; state: "waiting" | "held"; toolInput: unknown; askedAt: string; dueAt: string | null; note: string | null }): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO seat_questions (id, rig_id, node_id, session_name, generation, state, tool_input, asked_at, due_at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.rigId, row.nodeId, row.sessionName, row.generation, row.state, JSON.stringify(row.toolInput), row.askedAt, row.dueAt, row.note).changes === 1;
  }

  /** waiting -> answered_auto, once. The single writer of the answer: a second caller gets false and answers nothing. */
  claimAutoAnswer(id: string, atIso: string, answers: Record<string, string>): boolean {
    return this.db.prepare("UPDATE seat_questions SET state = 'answered_auto', settled_at = ?, answers = ? WHERE id = ? AND state = 'waiting'")
      .run(atIso, JSON.stringify(answers), id).changes === 1;
  }

  /** Moves a question that is still open to `to`. Returns whether it moved. */
  settle(id: string, from: SeatQuestionState[], to: SeatQuestionState, atIso: string, note?: string): boolean {
    const marks = from.map(() => "?").join(", ");
    return this.db.prepare(`UPDATE seat_questions SET state = ?, settled_at = ?, note = coalesce(?, note) WHERE id = ? AND state IN (${marks})`)
      .run(to, atIso, note ?? null, id, ...from).changes === 1;
  }

  /** The seat moved on: its open questions settle by what happened. PostToolUse of AskUserQuestion is an answer (a human's unless the
   *  daemon sent one); any other end of the turn abandons what waited. SELECT then CAS per row. */
  settleFromActivity(nodeId: string, rawEvent: string | null, rawSubtype: string | null, atIso: string): number {
    const open = this.db.prepare("SELECT id, state FROM seat_questions WHERE node_id = ? AND state IN ('waiting', 'held', 'answered_auto')").all(nodeId) as Array<{ id: string; state: SeatQuestionState }>;
    if (open.length === 0) return 0;
    const answered = (rawEvent === "PostToolUse" || rawEvent === "PostToolUseFailure") && rawSubtype === "AskUserQuestion";
    const ended = rawEvent === "Stop" || rawEvent === "SessionEnd" || rawEvent === "SessionStart" || rawEvent === "UserPromptSubmit";
    if (!answered && !ended) return 0;
    let moved = 0;
    for (const q of open) {
      const to: SeatQuestionState = q.state === "answered_auto" ? "confirmed_auto" : answered ? "answered_human" : "abandoned";
      if (this.settle(q.id, [q.state], to, atIso)) moved += 1;
    }
    return moved;
  }

  /** Open questions with no answer from anyone: held ones, and waiting ones. SELECT only. */
  openUnanswered(): SeatQuestionRow[] {
    return (this.db.prepare("SELECT * FROM seat_questions WHERE state IN ('waiting', 'held') ORDER BY asked_at").all() as Row[]).map(toRow);
  }

  /** Records that an auto-answer's event and note are written. */
  markLogged(id: string, atIso: string): boolean {
    return this.db.prepare("UPDATE seat_questions SET logged_at = ? WHERE id = ? AND state IN ('answered_auto', 'confirmed_auto') AND logged_at IS NULL").run(atIso, id).changes === 1;
  }

  /** Records that an auto-answer's note to the human is filed. */
  markNoted(id: string, atIso: string): boolean {
    return this.db.prepare("UPDATE seat_questions SET noted_at = ? WHERE id = ? AND state IN ('answered_auto', 'confirmed_auto') AND noted_at IS NULL").run(atIso, id).changes === 1;
  }

  /** Questions the daemon answered since `sinceIso` (sent, or sent and seen to land). SELECT only. */
  autoAnsweredSince(sinceIso: string): Array<{ id: string; sessionName: string; state: SeatQuestionState; logged: boolean; noted: boolean }> {
    return (this.db.prepare("SELECT id, session_name, state, logged_at IS NOT NULL AS logged, noted_at IS NOT NULL AS noted FROM seat_questions WHERE state IN ('answered_auto', 'confirmed_auto') AND settled_at >= ? ORDER BY settled_at").all(sinceIso) as Array<{ id: string; session_name: string; state: string; logged: number; noted: number }>)
      .map((r) => ({ id: r.id, sessionName: r.session_name, state: r.state as SeatQuestionState, logged: r.logged === 1, noted: r.noted === 1 }));
  }

  /** The rig's stored wait: null is the default, 0 is off. */
  rigWaitMinutes(rigId: string): number | null {
    const row = this.db.prepare("SELECT question_auto_answer_minutes AS m FROM rigs WHERE id = ?").get(rigId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }
}

