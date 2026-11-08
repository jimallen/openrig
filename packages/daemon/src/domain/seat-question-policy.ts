import { createHash } from "node:crypto";
import type { QueueRepository } from "./queue-repository.js";
import { QUESTION_DIALOG_TOOL, type AgentActivityStore } from "./agent-activity-store.js";

// OF-278 — a question a seat put to the human (Claude's AskUserQuestion dialog) takes its "(Recommended)" answer when the human
// has not answered within the rig's wait (Jim, 2026-11-08: "No exception, log it"). The daemon decides and logs; the seat's own
// PermissionRequest hook enacts, by returning the documented `allow` decision with the question's `answers` filled in. Measured on
// Claude Code 2.1.319: that hook runs while the dialog is open, a human's answer beats it, a hook that fails or times out leaves the
// dialog open, and the model receives the same tool_result for either route.
//
// Nothing here guesses. A question with no single safe answer is HELD: it stays open for the human and is surfaced.

export { DEFAULT_AUTO_ANSWER_MINUTES, MAX_AUTO_ANSWER_MINUTES, QUESTION_HOOK_TIMEOUT_SECONDS, QUESTION_POLL_CHUNK_MS, MAX_QUESTION_WAITS_PER_SEAT, MAX_QUESTION_WAITS_TOTAL, QUESTION_ASKED_AT_MARGIN_MS } from "./seat-question-limits.js";
import { DEFAULT_AUTO_ANSWER_MINUTES, MAX_AUTO_ANSWER_MINUTES, QUESTION_POLL_CHUNK_MS, MAX_QUESTION_WAITS_PER_SEAT, MAX_QUESTION_WAITS_TOTAL, QUESTION_ASKED_AT_MARGIN_MS } from "./seat-question-limits.js";

/** A dialog's whole input: up to four questions, each with up to four options and their descriptions. */
export const QUESTION_WAIT_MAX_BODY_BYTES = 64 * 1024;

export type SeatQuestionState = "waiting" | "held" | "answered_auto" | "confirmed_auto" | "answered_human" | "abandoned";

/** The wait a rig's stored setting means, in ms. `null` stored is the default; 0 is off (returns 0). */
export function autoAnswerWaitMs(storedMinutes: number | null | undefined): number {
  const minutes = storedMinutes === null || storedMinutes === undefined ? DEFAULT_AUTO_ANSWER_MINUTES : storedMinutes;
  return Math.max(0, Math.min(minutes, MAX_AUTO_ANSWER_MINUTES)) * 60_000;
}

const RECOMMENDED = /\(recommended\)/i;
/** Question texts that name a slot every object has: as a key of the answers map they would be silently dropped (`__proto__`) or shadow a built-in. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export type AnswerPlan =
  | { kind: "answer"; answers: Record<string, string>; chosen: Array<{ question: string; chosen: string }> }
  | { kind: "held"; reason: string };

/** What a dialog's `tool_input` supports answering. Every question must be single-select with exactly one "(Recommended)" option, and
 *  the questions must be distinguishable (the answers map is keyed by question text); otherwise the whole dialog is held. */
export function planAnswer(toolInput: unknown): AnswerPlan {
  const questions = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return { kind: "held", reason: "the dialog has no questions this daemon can read" };
  const answers: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();
  const chosen: Array<{ question: string; chosen: string }> = [];
  for (const q of questions) {
    const question = typeof q?.question === "string" ? q.question : null;
    if (question === null || question === "") return { kind: "held", reason: "a question has no text" };
    if (UNSAFE_KEYS.has(question)) return { kind: "held", reason: `"${question}" cannot be a key of the answers` };
    if (seen.has(question)) return { kind: "held", reason: "two questions have the same text" };
    seen.add(question);
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
  /** When the auto-answer's event and note were written; null until then, so a reconnect after a crash writes them. */
  loggedAt: string | null;
  /** When the note to the human was filed; null until then, so a later ask files it. */
  notedAt: string | null;
  answers: Record<string, string> | null;
  note: string | null;
}

/** What the service and the health notice need of the record of questions. Implemented over SQLite in adapters/seat-question-store.ts; every
 *  move is a compare-and-set on `state`, so the database, not memory, says what became of a question. */
export interface SeatQuestionRepository {
  get(id: string): SeatQuestionRow | null;
  /** False when a row with this id exists already (the first writer's row stands). */
  insert(row: { id: string; rigId: string; nodeId: string; sessionName: string; generation: string | null; state: "waiting" | "held"; toolInput: unknown; askedAt: string; dueAt: string | null; note: string | null }): boolean;
  /** waiting -> answered_auto, once. The single writer of the answer: a second caller gets false and answers nothing. */
  claimAutoAnswer(id: string, atIso: string, answers: Record<string, string>): boolean;
  /** Moves a question that is still in one of `from` to `to`. Returns whether it moved. */
  settle(id: string, from: SeatQuestionState[], to: SeatQuestionState, atIso: string, note?: string): boolean;
  /** The seat moved on: its open questions settle by what happened. PostToolUse of AskUserQuestion is an answer (a human's unless the daemon
   *  sent one); any other end of the turn abandons what waited. Returns how many moved. */
  settleFromActivity(nodeId: string, rawEvent: string | null, rawSubtype: string | null, atIso: string): number;
  /** Open questions with no answer from anyone: held ones, and waiting ones. */
  openUnanswered(): SeatQuestionRow[];
  /** Records that an auto-answer's event and note are written. */
  markLogged(id: string, atIso: string): boolean;
  /** Records that an auto-answer's note to the human is filed. */
  markNoted(id: string, atIso: string): boolean;
  /** Questions the daemon answered since `sinceIso` (sent, or sent and seen to land). */
  autoAnsweredSince(sinceIso: string): Array<{ id: string; sessionName: string; state: SeatQuestionState; logged: boolean; noted: boolean }>;
  /** The rig's stored wait in minutes: null is the default, 0 is off. */
  rigWaitMinutes(rigId: string): number | null;
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

/** A request the service will not take; the route turns it into this status and code. */
export class SeatQuestionRefusal extends Error {
  constructor(readonly status: 400 | 429, readonly code: "invalid_question_request" | "too_many_question_waits", message: string) { super(message); }
}

export interface SeatQuestionServiceDeps {
  store: SeatQuestionRepository;
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
  /** Held polls allowed for one seat, and in all. */
  maxWaitsPerSeat?: number;
  maxWaitsTotal?: number;
}

/** The daemon's side of the long-poll: the seat's hook asks, the daemon replies `wait`, `none` or `answer`. */
export class SeatQuestionService {
  constructor(private readonly deps: SeatQuestionServiceDeps) {}

  /** The id a request's row has: derived, so a hostile or buggy hook cannot name another seat's row. */
  static rowId(nodeId: string, requestId: string): string {
    return `qa-${createHash("sha256").update(`${nodeId}\0${requestId}`).digest("hex").slice(0, 32)}`;
  }

  private readonly active = new Map<string, number>();
  private activeTotal = 0;

  async wait(req: SeatQuestionRequest): Promise<SeatQuestionReply> {
    const { store, now } = this.deps;
    // The start time is the hook's own claim. One that is not a time, or older than any live hook could be, is refused: it would make the wait
    // end at once. A start in the future counts from now.
    if (!Number.isFinite(req.askedAtMs) || req.askedAtMs <= 0 || now().getTime() - req.askedAtMs > MAX_AUTO_ANSWER_MINUTES * 60_000 + QUESTION_ASKED_AT_MARGIN_MS) {
      throw new SeatQuestionRefusal(400, "invalid_question_request", "askedAtMs is not the start time of a live hook");
    }
    const seat = this.deps.resolveSeat({ sessionName: req.sessionName, nodeId: req.nodeId });
    if (!seat || seat.runtime !== "claude-code") return { action: "none", why: "not a managed Claude seat" };
    // The cap comes before anything is written: a request refused here leaves no row and no dialog on record for the seat. A poll costs a database
    // read a second, so a seat may hold a few and the daemon a bounded number; a request that returns at once is counted only while it runs.
    const mine = this.active.get(seat.nodeId) ?? 0;
    if (mine >= (this.deps.maxWaitsPerSeat ?? MAX_QUESTION_WAITS_PER_SEAT) || this.activeTotal >= (this.deps.maxWaitsTotal ?? MAX_QUESTION_WAITS_TOTAL)) {
      throw new SeatQuestionRefusal(429, "too_many_question_waits", "too many question waits are held; ask again shortly");
    }
    this.active.set(seat.nodeId, mine + 1); this.activeTotal += 1;
    try { return await this.serve(req, seat); }
    finally { this.active.set(seat.nodeId, (this.active.get(seat.nodeId) ?? 1) - 1); this.activeTotal -= 1; }
  }

  private async serve(req: SeatQuestionRequest, seat: { rigId: string; nodeId: string; sessionName: string; runtime: string | null }): Promise<SeatQuestionReply> {
    const { store, now } = this.deps;
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
        // A reconnect after the answer was taken (the reply was lost, the daemon restarted, or the note could not be filed): the same answer again,
        // once what was left undone (the event, the note) is done. What is written is not written again.
        if (row.loggedAt === null || row.notedAt === null) await this.record(row);
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
    // The rig's setting now, not the one the question was asked under: a rig that turned the policy off while this waited gets no answer.
    if (autoAnswerWaitMs(store.rigWaitMinutes(row.rigId)) === 0) {
      const reason = "the rig turned auto-answer off while this question waited";
      if (store.settle(row.id, ["waiting"], "held", atIso, reason)) {
        this.deps.emit({ type: "seat.question_held", rigId: row.rigId, nodeId: row.nodeId, sessionName: row.sessionName, questionId: row.id, askedAt: row.askedAt, reason });
      }
      return { action: "none", why: reason };
    }
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
    const claimed = store.get(row.id);
    if (claimed) await this.record(claimed);
    return { action: "answer", updatedInput: { ...(row.toolInput as Record<string, unknown>), answers: plan.answers } };
  }

  /** Writes down an answer that was taken: the note to the human, then the event (the durable record). Neither may fail silently: an event or a note
   *  that cannot be written stops here, so the hook asks again and the answer is not sent unreported.
   *  `logged_at` and `noted_at` are set as each is done, so a daemon that stopped between them finishes the rest on the hook's next ask. */
  private async record(row: SeatQuestionRow): Promise<void> {
    // Two polls of one question in this process share one write: the second waits for the first, then finds it written.
    const running = this.recording.get(row.id);
    if (running) return await running;
    const writing = this.write(row);
    this.recording.set(row.id, writing);
    try { await writing; } finally { this.recording.delete(row.id); }
  }

  private readonly recording = new Map<string, Promise<void>>();

  private async write(row: SeatQuestionRow): Promise<void> {
    const chosen = Object.entries(row.answers ?? {}).map(([question, picked]) => ({ question, chosen: picked }));
    const takenAt = row.settledAt ?? this.deps.now().toISOString();
    const waitedMs = Math.max(0, Date.parse(takenAt) - Date.parse(row.askedAt));
    const waitConfiguredMs = row.dueAt ? Date.parse(row.dueAt) - Date.parse(row.askedAt) : waitedMs;
    // The note to the human first, then the event, then (in the caller) the answer. The note is filed once (noted_at); a note that cannot be filed throws,
    // so no `seat.question_auto_answered` event is written and no answer is sent for an answer nobody was told of: the hook asks again after the error and
    // the next ask files the note (the queue item is one item by its id). The event is the durable record that the answer was sent, written once (logged_at).
    if (row.notedAt === null) {
      const lines = chosen.map((c) => `  - ${c.question} -> ${c.chosen}`).join("\n");
      await this.deps.tell({
        qitemId: row.id, seat: row.sessionName,
        summary: `${row.sessionName}: unanswered question took its recommended answer`,
        body: `${row.sessionName} asked a question and nobody answered it within ${Math.round(waitConfiguredMs / 60_000)} min, so OpenRig sent the (Recommended) answer at ${takenAt}:\n${lines}\n\nHow to override: ${this.deps.howToOverride(row.sessionName)}`,
      });
      this.deps.store.markNoted(row.id, this.deps.now().toISOString());
    }
    if (row.loggedAt === null) {
      this.deps.emit({ type: "seat.question_auto_answered", rigId: row.rigId, nodeId: row.nodeId, sessionName: row.sessionName, questionId: row.id, askedAt: row.askedAt, takenAt, waitedMs, waitConfiguredMs, questions: chosen });
      this.deps.store.markLogged(row.id, this.deps.now().toISOString());
    }
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

/** The note to the human, as a queue item: from the daemon to the local human inbox. A human-routed item needs a summary and an evidence ref
 *  (the repository refuses it otherwise), and the item id is the question's row id, so filing it twice is one item. `nudge: false`: the human
 *  inbox is read, not woken. */
export function queueTeller(queue: Pick<QueueRepository, "create">): SeatQuestionServiceDeps["tell"] {
  return async (note) => {
    await queue.create({
      qitemId: note.qitemId, sourceSession: "daemon@kernel", destinationSession: "human@kernel", nudge: false,
      tags: ["seat-question:auto-answered"], summary: note.summary,
      evidenceRef: `event seat.question_auto_answered, question ${note.qitemId}, seat ${note.seat}`, body: note.body,
    });
  };
}
