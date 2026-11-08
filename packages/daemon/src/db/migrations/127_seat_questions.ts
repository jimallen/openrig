import type { Migration } from "../migrate.js";

/**
 * OF-278: a question a seat put to the human (Claude's AskUserQuestion dialog), and what became of it.
 *
 * `seat_questions` is the durable record behind the auto-answer: one row per hook request (`id` is the request id the seat's
 * hook minted, kept across its reconnects), so a daemon restart in the wait neither loses the due time nor answers the same
 * dialog twice. States: waiting, held (no safe answer, the human is the only one who can), answered_auto (the daemon sent
 * its recommended answer; not yet seen to land), confirmed_auto (the seat moved on after it), answered_human, abandoned (the
 * turn ended with no answer seen). Additive only; a rolled-back build ignores the table and the column.
 *
 * `rigs.question_auto_answer_minutes`: the rig spec's `question_policy.auto_answer_after`. NULL is the default wait; 0 is off.
 */
export const seatQuestionsSchema: Migration = {
  name: "127_seat_questions.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN question_auto_answer_minutes INTEGER;
    CREATE TABLE seat_questions (
      id TEXT PRIMARY KEY,
      rig_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      generation TEXT,
      state TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      due_at TEXT,
      settled_at TEXT,
      logged_at TEXT,
      answers TEXT,
      note TEXT
    );
    CREATE INDEX idx_seat_questions_open ON seat_questions(node_id, state) WHERE state IN ('waiting', 'held', 'answered_auto');
  `,
};
