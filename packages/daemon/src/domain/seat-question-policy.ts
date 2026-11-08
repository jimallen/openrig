import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { QUESTION_DIALOG_TOOL, type AgentActivityStore } from "./agent-activity-store.js";

// OF-278 — a question a seat put to the human (Claude's AskUserQuestion dialog) takes its "(Recommended)" answer when the human
// has not answered within the rig's wait (Jim, 2026-11-08: "No exception, log it"). The daemon decides and logs; the seat's own
// PermissionRequest hook enacts, by returning the documented `allow` decision with the question's `answers` filled in. Measured on
// Claude Code 2.1.319: that hook runs while the dialog is open, a human's answer beats it, a hook that fails or times out leaves the
// dialog open, and the model receives the same tool_result for either route.
//
// Nothing here guesses. A question with no single safe answer is HELD: it stays open for the human and is surfaced.

export { DEFAULT_AUTO_ANSWER_MINUTES, MAX_AUTO_ANSWER_MINUTES, QUESTION_HOOK_TIMEOUT_SECONDS, QUESTION_POLL_CHUNK_MS } from "./seat-question-limits.js";
import { DEFAULT_AUTO_ANSWER_MINUTES, MAX_AUTO_ANSWER_MINUTES, QUESTION_POLL_CHUNK_MS } from "./seat-question-limits.js";

/** A dialog's whole input: up to four questions, each with up to four options and their descriptions. */
export const QUESTION_WAIT_MAX_BODY_BYTES = 64 * 1024;

export type SeatQuestionState = "waiting" | "held" | "answered_auto" | "confirmed_auto" | "answered_human" | "abandoned";

/** The wait a rig's stored setting means, in ms. `null` stored is the default; 0 is off (returns 0). */
export function autoAnswerWaitMs(storedMinutes: number | null | undefined): number {
  const minutes = storedMinutes === null || storedMinutes === undefined ? DEFAULT_AUTO_ANSWER_MINUTES : storedMinutes;
  return Math.max(0, Math.min(minutes, MAX_AUTO_ANSWER_MINUTES)) * 60_000;
}

const RECOMMENDED = /\(recommended\)/i;

export type AnswerPlan =
  | { kind: "answer"; answers: Record<string, string>; chosen: Array<{ question: string; chosen: string }> }
  | { kind: "held"; reason: string };

/** What a dialog's `tool_input` supports answering. Every question must be single-select with exactly one "(Recommended)" option, and
 *  the questions must be distinguishable (the answers map is keyed by question text); otherwise the whole dialog is held. */
export function planAnswer(toolInput: unknown): AnswerPlan {
  const questions = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return { kind: "held", reason: "the dialog has no questions this daemon can read" };
  const answers: Record<string, string> = {};
  const chosen: Array<{ question: string; chosen: string }> = [];
  for (const q of questions) {
    const question = typeof q?.question === "string" ? q.question : null;
    if (question === null || question === "") return { kind: "held", reason: "a question has no text" };
    if (Object.prototype.hasOwnProperty.call(answers, question)) return { kind: "held", reason: "two questions have the same text" };
    if (q.multiSelect === true) return { kind: "held", reason: `"${question}" allows several answers` };
    const options: unknown[] = Array.isArray(q.options) ? q.options : [];
    const labels = options.map((o) => (typeof (o as { label?: unknown })?.label === "string" ? (o as { label: string }).label : null));
    if (labels.some((l) => l === null)) return { kind: "held", reason: `"${question}" has an option with no label` };
    const recommended = (labels as string[]).filter((l) => RECOMMENDED.test(l));
    if (recommended.length === 0) return { kind: "held", reason: `"${question}" has no (Recommended) option` };
    if (recommended.length > 1) return { kind: "held", reason: `"${question}" has more than one (Recommended) option` };
    answers[question] = recommended[0]!;
    chosen.push({ question, chosen: recommended[0]! });
  }
  return { kind: "answer", answers, chosen };
}

export interface SeatQuestionRow {
  id: string;
  rigId: string;
  nodeId: string;
  sessionName: string;
  generation: string | null;
  state: SeatQuestionState;
  toolInput: unknown;
  askedAt: string;
  dueAt: string | null;
  settledAt: string | null;
  answers: Record<string, string> | null;
  note: string | null;
}

interface Row {
  id: string; rig_id: string; node_id: string; session_name: string; generation: string | null; state: string; tool_input: string;
  asked_at: string; due_at: string | null; settled_at: string | null; answers: string | null; note: string | null;
}

function toRow(r: Row): SeatQuestionRow {
  const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
  return {
    id: r.id, rigId: r.rig_id, nodeId: r.node_id, sessionName: r.session_name, generation: r.generation, state: r.state as SeatQuestionState,
    toolInput: parse(r.tool_input), askedAt: r.asked_at, dueAt: r.due_at, settledAt: r.settled_at,
    answers: parse(r.answers) as Record<string, string> | null, note: r.note,
  };
}

/** Every move is a compare-and-set on `state`, so the database, not memory, says what became of a question. */
export class SeatQuestionStore {
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

  /** Questions the daemon answered since `sinceIso` (sent, or sent and seen to land). SELECT only. */
  autoAnsweredSince(sinceIso: string): Array<{ id: string; sessionName: string; state: SeatQuestionState }> {
    return (this.db.prepare("SELECT id, session_name, state FROM seat_questions WHERE state IN ('answered_auto', 'confirmed_auto') AND settled_at >= ? ORDER BY settled_at").all(sinceIso) as Array<{ id: string; session_name: string; state: string }>)
      .map((r) => ({ id: r.id, sessionName: r.session_name, state: r.state as SeatQuestionState }));
  }

  /** The rig's stored wait: null is the default, 0 is off. */
  rigWaitMinutes(rigId: string): number | null {
    const row = this.db.prepare("SELECT question_auto_answer_minutes AS m FROM rigs WHERE id = ?").get(rigId) as { m: number | null } | undefined;
    return row?.m ?? null;
  }
}

export interface SeatQuestionRequest {
  /** Minted by the seat's hook once and kept across its reconnects: the row's identity. */
  requestId: string;
  sessionName: string | null;
  nodeId: string | null;
  generation: string | null;
  toolInput: unknown;
  /** When the hook first ran (its own clock); the wait is counted from here, so a reconnect never restarts it. */
  askedAtMs: number;
}

export type SeatQuestionReply =
  | { action: "none"; why: string }
  | { action: "wait" }
  | { action: "answer"; updatedInput: Record<string, unknown> };

export interface SeatQuestionServiceDeps {
  store: SeatQuestionStore;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  resolveSeat: (input: { sessionName: string | null; nodeId: string | null }) => { rigId: string; nodeId: string; sessionName: string; runtime: string | null } | null;
  /** Whether the seat's newest activity is still this open dialog: the question_dialog reason, in this generation. */
  stillAsking: (nodeId: string, generation: string | null) => boolean;
  /** Records the dialog as the seat's activity when the daemon never saw it (it was down when the hook first fired). */
  recordAsking: (seat: { nodeId: string; sessionName: string; runtime: string | null }, generation: string | null, atIso: string) => void;
  emit: (event: Extract<import("./types.js").RigEvent, { type: "seat.question_auto_answered" | "seat.question_held" }>) => void;
  /** Files the one line to the human. Idempotent on `qitemId`. */
  tell: (note: { qitemId: string; seat: string; body: string; summary: string }) => Promise<void>;
  /** How to override an answer taken, worded for the note. */
  howToOverride: (seat: string) => string;
  chunkMs?: number;
}

/** The daemon's side of the long-poll: the seat's hook asks, the daemon replies `wait`, `none` or `answer`. */
export class SeatQuestionService {
  constructor(private readonly deps: SeatQuestionServiceDeps) {}

  /** The id a request's row has: derived, so a hostile or buggy hook cannot name another seat's row. */
  static rowId(nodeId: string, requestId: string): string {
    return `qa-${createHash("sha256").update(`${nodeId}\0${requestId}`).digest("hex").slice(0, 32)}`;
  }

  async wait(req: SeatQuestionRequest): Promise<SeatQuestionReply> {
    const { store, now } = this.deps;
    const seat = this.deps.resolveSeat({ sessionName: req.sessionName, nodeId: req.nodeId });
    if (!seat || seat.runtime !== "claude-code") return { action: "none", why: "not a managed Claude seat" };
    const id = SeatQuestionService.rowId(seat.nodeId, req.requestId);
    let row = store.get(id);
    if (!row) {
      const waitMs = autoAnswerWaitMs(store.rigWaitMinutes(seat.rigId));
      const askedAt = new Date(Math.min(req.askedAtMs, now().getTime())).toISOString();
      const plan = planAnswer(req.toolInput);
      if (waitMs === 0) return { action: "none", why: "this rig does not auto-answer" };
      if (!this.deps.stillAsking(seat.nodeId, req.generation)) this.deps.recordAsking(seat, req.generation, askedAt);
      if (plan.kind === "held") {
        if (store.insert({ id, rigId: seat.rigId, nodeId: seat.nodeId, sessionName: seat.sessionName, generation: req.generation, state: "held", toolInput: req.toolInput, askedAt, dueAt: null, note: plan.reason })) {
          this.deps.emit({ type: "seat.question_held", rigId: seat.rigId, nodeId: seat.nodeId, sessionName: seat.sessionName, questionId: id, askedAt, reason: plan.reason });
        }
        return { action: "none", why: plan.reason };
      }
      store.insert({ id, rigId: seat.rigId, nodeId: seat.nodeId, sessionName: seat.sessionName, generation: req.generation, state: "waiting", toolInput: req.toolInput, askedAt, dueAt: new Date(Date.parse(askedAt) + waitMs).toISOString(), note: null });
      row = store.get(id);
    }
    if (!row) return { action: "none", why: "the question could not be recorded" };
    return await this.hold(row, seat);
  }

  private async hold(first: SeatQuestionRow, seat: { rigId: string; nodeId: string; sessionName: string; runtime: string | null }): Promise<SeatQuestionReply> {
    const { store, now } = this.deps;
    const until = now().getTime() + (this.deps.chunkMs ?? QUESTION_POLL_CHUNK_MS);
    for (;;) {
      const row = store.get(first.id);
      if (!row) return { action: "none", why: "the question is gone" };
      if (row.state === "answered_auto") {
        // A reconnect after the answer was sent (the reply was lost, or the daemon restarted): the same answer again, nothing logged again.
        return { action: "answer", updatedInput: { ...(row.toolInput as Record<string, unknown>), answers: row.answers ?? {} } };
      }
      if (row.state !== "waiting") return { action: "none", why: `the question is ${row.state}` };
      const due = row.dueAt ? Date.parse(row.dueAt) : Number.NaN;
      if (Number.isFinite(due) && now().getTime() >= due) return this.take(row, seat);
      if (now().getTime() >= until) return { action: "wait" };
      const untilDue = Number.isFinite(due) ? due - now().getTime() : 1000;
      await this.deps.sleep(Math.max(1, Math.min(1000, untilDue, until - now().getTime())));
    }
  }

  private async take(row: SeatQuestionRow, seat: { rigId: string; nodeId: string; sessionName: string; runtime: string | null }): Promise<SeatQuestionReply> {
    const { store, now } = this.deps;
    const atIso = now().toISOString();
    // The dialog must still be the seat's newest word. If the seat moved on while the daemon could not hear it (it was down), the
    // question was answered or is gone: nothing is sent and nothing is claimed.
    if (!this.deps.stillAsking(row.nodeId, row.generation)) {
      store.settle(row.id, ["waiting"], "abandoned", atIso, "the seat moved on before the wait ended");
      return { action: "none", why: "the seat moved on" };
    }
    const plan = planAnswer(row.toolInput);
    if (plan.kind !== "answer") {
      store.settle(row.id, ["waiting"], "held", atIso, plan.reason);
      return { action: "none", why: plan.reason };
    }
    if (!store.claimAutoAnswer(row.id, atIso, plan.answers)) return { action: "none", why: "another reply already took it" };
    const waitedMs = Math.max(0, Date.parse(atIso) - Date.parse(row.askedAt));
    const waitConfiguredMs = row.dueAt ? Date.parse(row.dueAt) - Date.parse(row.askedAt) : waitedMs;
    this.deps.emit({ type: "seat.question_auto_answered", rigId: row.rigId, nodeId: row.nodeId, sessionName: row.sessionName, questionId: row.id, askedAt: row.askedAt, takenAt: atIso, waitedMs, waitConfiguredMs, questions: plan.chosen });
    try {
      const lines = plan.chosen.map((c) => `  - ${c.question} -> ${c.chosen}`).join("\n");
      await this.deps.tell({
        qitemId: row.id, seat: row.sessionName,
        summary: `${row.sessionName}: unanswered question took its recommended answer`,
        body: `${row.sessionName} asked a question and nobody answered it within ${Math.round(waitConfiguredMs / 60_000)} min, so OpenRig sent the (Recommended) answer at ${atIso}:\n${lines}\n\nHow to override: ${this.deps.howToOverride(row.sessionName)}`,
      });
    } catch { /* the event above is the record; a failed note must not withhold the answer */ }
    return { action: "answer", updatedInput: { ...(row.toolInput as Record<string, unknown>), answers: plan.answers } };
  }
}

/** The two reads the service makes of the seat's activity, over the real store: is the newest word still this open dialog, and put the dialog on
 *  record when the daemon never saw it. One definition, used by the daemon and by the tests. */
export function activityBackedPorts(store: AgentActivityStore): Pick<SeatQuestionServiceDeps, "stillAsking" | "recordAsking"> {
  return {
    stillAsking: (nodeId, generation) => {
      const latest = store.getLatestRecorded(nodeId);
      return !!latest && latest.state === "needs_input" && latest.dialog === "question" && (latest.generation ?? null) === (generation ?? null);
    },
    recordAsking: (seat, generation, atIso) => {
      store.recordHookEvent({ runtime: seat.runtime, sessionName: seat.sessionName, nodeId: seat.nodeId, hookEvent: "PermissionRequest", subtype: QUESTION_DIALOG_TOOL, occurredAt: atIso, generation });
    },
  };
}
