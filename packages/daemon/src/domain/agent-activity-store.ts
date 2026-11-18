import { isCodeOutputPrompt } from "./code-mode-output.js";
import type Database from "better-sqlite3";
import { findLatestSessionNameMatch } from "./latest-session-name-match.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity, PersistedEvent } from "./types.js";
import { describeModelErrorLoop } from "./seat-model-error-loop.js";
import { PDA_RUNTIME, isPdaHeldCode } from "../adapters/pda-runner-protocol.js";

export const AGENT_ACTIVITY_FRESHNESS_MS = 5 * 60 * 1000;

export interface HookActivityInput {
  runtime: string | null;
  sessionName?: string | null;
  nodeId?: string | null;
  hookEvent: string;
  subtype?: string | null;
  /** OF-278 / workspaces-o9o.56: on an AskUserQuestion end, the digest of the questions it ended (seat-question-policy questionKeyOf);
   *  workspaces-o9o.59: on an AskUserQuestion PermissionRequest, the digest of the questions it asks. */
  questionKey?: string | null;
  occurredAt?: string | null;
  /** W2a-1 — the EMITTING occupant's generation, CARRIED source-bound on the hook (the producer/relay
   *  supplies it at fire time; the route ingests it). NOT inferred from record-time state — that
   *  inference mis-attributes a delayed prior-occupant hook to the live occupant. Absent on a legacy,
   *  excluded, or no-tenure emitting path ⇒ stamped null ⇒ unresolved at read (never false-fresh). */
  generation?: string | null;
  /** workspaces-o9o.4: the tool call a tool event belongs to; kept only on PreToolUse/PostToolUse/PostToolUseFailure. */
  toolCallId?: string | null;
  /** workspaces-o9o.59: set only by the OF-278 question-wait hold when it puts a question on record itself (the relay's PermissionRequest had not
   *  arrived). Never taken from a hook body. Kept only on an AskUserQuestion PermissionRequest. */
  recordedBy?: QuestionAskRecorder | null;
}

/** workspaces-o9o.59: who recorded a question's PermissionRequest other than the relay: the question-wait hold (seat-question-policy recordAsking). */
export type QuestionAskRecorder = NonNullable<AgentActivity["recordedBy"]>;

export type RecordHookActivityResult =
  | { ok: true; activity: AgentActivity; event: PersistedEvent }
  | { ok: false; code: "missing_session_identity" | "session_not_found"; error: string }
  /** workspaces-o9o.124: Code Mode's code output, relayed as a UserPromptSubmit by a relay copy older than o9o.124. Not recorded. */
  | { ok: false; code: "code_output_not_a_prompt"; error: string };

interface AgentActivityStoreDeps {
  db: Database.Database;
  eventBus: EventBus;
  now?: () => Date;
  freshnessMs?: number;
  /** W2a-1 — resolve the LIVE occupant generation for a node (the shipped occupant-tenure
   *  generation_uuid), or null when UNKNOWN. Injected (not self-constructed) so the store stays
   *  decoupled from SessionRegistry and unit-testable with a fake. When ABSENT the store applies no
   *  generation gate — legacy clock-only freshness — so the existing callers are unchanged until the
   *  producer wiring injects the real resolver. Resolution is SYNCHRONOUS (a better-sqlite3 read),
   *  which is why the gate lives inline in the sync read path with no signature churn to 9 callers. */
  resolveOccupantGeneration?: (nodeId: string) => string | null;
  /** Confirm that a carried generation is registered for this node. A side-effect-free reservation
   * that never committed must remain unresolvable, not become positive mismatch evidence. */
  isRegisteredOccupantGeneration?: (nodeId: string, generation: string) => boolean;
  /** OF-278: the messages waiting for a seat, for the inventory (best effort: a failure reads as none). */
  heldMessages?: (sessionName: string, now: Date) => import("./seat-messaging/held-messages.js").HeldMessages | null;
  /** OF-286: the model-error flag a Pi or OMP seat's runner publishes (its sidecar), or null. Best effort: a failure reads as no flag. */
  modelErrorLoop?: (sessionName: string, runtime: string | null) => import("./seat-model-error-loop.js").PublishedModelErrorLoop | null;
  /** OF-278: told of every activity this store records, after it is emitted (the seat's open questions settle from it). Never throws into ingest. */
  onActivityRecorded?: (activity: AgentActivity, session: { rigId: string; nodeId: string; sessionName: string }) => void;
}

interface SessionLookupRow {
  /** The session row this lookup landed on, from the SAME node as `node_id`. */
  session_id: string;
  rig_id: string;
  node_id: string;
  session_name: string;
  runtime: string | null;
}

interface EventPayloadRow {
  payload: string;
}

export class AgentActivityStore {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly now: () => Date;
  /** The window within which a stored hook counts as recent (read-only for diagnostics). */
  readonly freshnessMs: number;
  private readonly resolveOccupantGeneration?: (nodeId: string) => string | null;
  private readonly isRegisteredOccupantGeneration?: (nodeId: string, generation: string) => boolean;
  private readonly heldMessages?: (sessionName: string, now: Date) => import("./seat-messaging/held-messages.js").HeldMessages | null;
  private readonly modelErrorLoop?: (sessionName: string, runtime: string | null) => import("./seat-model-error-loop.js").PublishedModelErrorLoop | null;
  private readonly onActivityRecorded?: (activity: AgentActivity, session: { rigId: string; nodeId: string; sessionName: string }) => void;

  constructor(deps: AgentActivityStoreDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.freshnessMs = deps.freshnessMs ?? AGENT_ACTIVITY_FRESHNESS_MS;
    this.resolveOccupantGeneration = deps.resolveOccupantGeneration;
    this.isRegisteredOccupantGeneration = deps.isRegisteredOccupantGeneration;
    this.onActivityRecorded = deps.onActivityRecorded;
    this.heldMessages = deps.heldMessages;
    this.modelErrorLoop = deps.modelErrorLoop;
  }

  recordHookEvent(input: HookActivityInput): RecordHookActivityResult {
    // workspaces-o9o.124: Code Mode's code output is not a prompt. Recorded, it would close the turn mid-turn, abandon an open AskUserQuestion
    // (onActivityRecorded) and pass the seat's input point (seat-messaging/input-point.ts reads the recorded rows), so it is not recorded at all.
    if (isCodeOutputPrompt(input.hookEvent, input.subtype)) {
      return { ok: false, code: "code_output_not_a_prompt", error: "Code Mode code output (UserPromptSubmit source poll_event) is not a prompt; not recorded" };
    }
    if (!input.sessionName && !input.nodeId) {
      return {
        ok: false,
        code: "missing_session_identity",
        error: "Hook activity requires a managed sessionName or nodeId",
      };
    }

    const session = this._resolveSession(input);
    if (!session) {
      return {
        ok: false,
        code: "session_not_found",
        error: "Hook activity did not match a managed session. List seats with: rig ps --nodes",
      };
    }

    const sampledAt = this.now().toISOString();
    const eventAt = parseTimestamp(input.occurredAt) ?? sampledAt;
    // W2a-1 — SOURCE-BOUND stamp: the emitting occupant's generation is CARRIED on the hook (supplied
    // by the producer/relay at fire time, ingested by the route), NEVER inferred from record-time
    // state. A delayed prior-occupant hook recorded after a new tenure minted carries its OWN (prior)
    // generation, so the read detects a mismatch rather than crediting it to the live occupant — and
    // this is immune to boot_at precision / clock skew because nothing is timed. Absent on a legacy,
    // excluded, or no-tenure emitting path ⇒ null ⇒ unresolved at read (the P21 claimed-era pattern:
    // absence recorded as its own state, never false-fresh). No record-time
    // resolver call — the live-gen resolver is used only at READ, for the comparison.
    const generation = input.generation ?? null;
    const activity = normalizeHookActivity({
      // Stamp the emitter's claimed runtime (consumers such as the provider
      // tap filter on it); semantics that depend on the runtime use the seat's.
      runtime: input.runtime ?? session.runtime,
      seatRuntime: session.runtime,
      hookEvent: input.hookEvent,
      subtype: input.subtype ?? null,
      sampledAt,
      eventAt,
      generation,
      toolCallId: input.toolCallId ?? null,
      questionKey: input.questionKey ?? null,
      recordedBy: input.recordedBy ?? null,
    });

    // OF-278: Claude's Notification/permission_prompt for an AskUserQuestion dialog arrives ~6.5 s after the PermissionRequest that
    // already named it (measured, 2.1.319). It carries no tool, so it keeps the reason the dialog already has. The dialog is judged by the
    // seat's latest word before this Notification, read as the posture reads it (_pickLatest: ACTIVITY_SCAN_ROWS rows, the turn's question
    // calls), not by the one row before it: late async rows can land between the PermissionRequest and its Notification (workspaces-o9o.57,
    // verify-qa review). A tool other than the question started after the dialog opened means the model went on past it (its end is still
    // in flight), so a Notification then is that tool's own prompt.
    if (activity.rawEvent === "Notification" && activity.rawSubtype === "permission_prompt" && activity.state === "needs_input") {
      const before = this._questionStillOpen(session.node_id);
      if (before?.dialog === "question" && before.state === "needs_input" && (before.generation ?? null) === (activity.generation ?? null)) {
        activity.reason = QUESTION_DIALOG_REASON;
        activity.dialog = "question";
      } else {
        // workspaces-o9o.37: a plain prompt's PermissionRequest (relayed for every tool, synchronously, before this Notification) named its
        // tool; the Notification names none. When the seat's latest word is that PermissionRequest, the Notification carries its tool, so the
        // prompt is cleared by that tool's end with no time window. A seat on the older relay sends no such PermissionRequest: no promptTool.
        const latest = this._latestActivity(session.node_id);
        if (latest?.rawEvent === "PermissionRequest" && latest.state === "needs_input" && latest.dialog !== "question"
          && typeof latest.rawSubtype === "string" && latest.rawSubtype !== QUESTION_DIALOG_TOOL
          && (latest.generation ?? null) === (activity.generation ?? null)) {
          activity.promptTool = latest.rawSubtype;
        }
      }
    }

    const event = this.eventBus.emit({
      type: "agent.activity",
      rigId: session.rig_id,
      nodeId: session.node_id,
      sessionName: session.session_name,
      runtime: activity.runtime ?? session.runtime,
      activity,
    });
    try { this.onActivityRecorded?.(activity, { rigId: session.rig_id, nodeId: session.node_id, sessionName: session.session_name }); } catch { /* ingest never fails on a listener */ }

    return { ok: true, activity, event };
  }

  /** OF-286: the seat's model-error flag as served to `rig ps` (with its human line), or null. Never throws. */
  modelErrorLoopFor(sessionName: string, runtime: string | null, now: Date): import("./seat-model-error-loop.js").SeatModelErrorLoop | null {
    if (runtime !== "pi" && runtime !== "omp") return null;
    try {
      const loop = this.modelErrorLoop?.(sessionName, runtime) ?? null;
      return loop ? describeModelErrorLoop(loop, now.getTime(), sessionName) : null;
    } catch { return null; }
  }

  /** OF-278: what waits for a seat's messages, or null. Never throws. */
  heldMessagesFor(sessionName: string, now: Date): import("./seat-messaging/held-messages.js").HeldMessages | null {
    try { return this.heldMessages?.(sessionName, now) ?? null; } catch { return null; }
  }

  /** OF-278: the newest activity as it was recorded: no freshness window, no generation verdict. A question that has waited an hour is
   *  still open, and the staleness transform would call it unknown. Null when the node has recorded none. */
  getLatestRecorded(nodeId: string): AgentActivity | null {
    return this._pickLatest(nodeId)?.activity ?? null;
  }

  /** The latest activity of a node: pickLatestByOrdering over its newest ACTIVITY_SCAN_ROWS rows, with the question calls of its current turn
   *  read from the same rows (workspaces-o9o.4 F3: the question's own start can sit far back; workspaces-o9o.57: so can the prompt itself). */
  private _pickLatest(nodeId: string): ReturnType<typeof parseActivityPayload> | null {
    const rows = this.db.prepare(
      `SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT ${ACTIVITY_SCAN_ROWS}`
    ).all(nodeId) as EventPayloadRow[];
    if (rows.length === 0) return null;
    const parsed = rows.map((r) => parseActivityPayload(r.payload));
    return pickLatestByOrdering(parsed, questionCallsIn(parsed));
  }

  /** The seat's latest word when it is a question to the human still open: the turn has asked more questions than have ended, and it has not
   *  gone on past the dialog (no tool other than AskUserQuestion has started, by its own eventAt, since). Null otherwise. Used to tell a question's own delayed Notification from another
   *  tool's permission prompt (workspaces-o9o.57). */
  /** The seat's latest word, as the posture reads it (pickLatestByOrdering over ACTIVITY_SCAN_ROWS rows). */
  private _latestActivity(nodeId: string): AgentActivity | null {
    const rows = this.db.prepare(
      `SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT ${ACTIVITY_SCAN_ROWS}`
    ).all(nodeId) as EventPayloadRow[];
    const parsed = rows.map((r) => parseActivityPayload(r.payload));
    return pickLatestByOrdering(parsed, questionCallsIn(parsed))?.activity ?? null;
  }

  private _questionStillOpen(nodeId: string): AgentActivity | null {
    const rows = this.db.prepare(
      `SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT ${ACTIVITY_SCAN_ROWS}`
    ).all(nodeId) as EventPayloadRow[];
    const parsed = rows.map((r) => parseActivityPayload(r.payload));
    const questions = questionCallsIn(parsed);
    const latest = pickLatestByOrdering(parsed, questions)?.activity ?? null;
    if (!latest || latest.dialog !== "question" || latest.state !== "needs_input") return null;
    // An end of the turn's questions has arrived for every question it asked (o9o.59's count): the question is answered, whatever order the
    // end's stamp gives it (an end stamped in the same millisecond as its dialog does not displace it).
    if (questions.ends >= questions.asks) return null;
    const askedMs = latest.eventAt ? Date.parse(latest.eventAt) : Number.NaN;
    const wentOn = turnCalls(parsed).turn.some((a) => a.rawEvent === "PreToolUse" && a.rawSubtype !== QUESTION_DIALOG_TOOL
      && !!a.eventAt && Number.isFinite(askedMs) && Date.parse(a.eventAt) > askedMs);
    return wentOn ? null : latest;
  }

  /** workspaces-o9o.4 F2: the seat's tool calls still open in its current turn, oldest first (openToolCallsIn). Never throws. */
  openToolCalls(input: { nodeId?: string | null; sessionName?: string | null }): OpenToolCall[] {
    try {
      const nodeId = input.nodeId ?? (input.sessionName ? this._resolveSession({ sessionName: input.sessionName })?.node_id : null);
      if (!nodeId) return [];
      const rows = this.db.prepare(
        `SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT ${ACTIVITY_SCAN_ROWS}`
      ).all(nodeId) as EventPayloadRow[];
      const parsed = rows.map((r) => parseActivityPayload(r.payload));
      if (input.sessionName && parsed[0]?.sessionName !== undefined && parsed[0]?.sessionName !== input.sessionName) return [];
      return openToolCallsIn(parsed);
    } catch {
      return [];
    }
  }

  getLatestForNode(input: {
    nodeId?: string | null;
    sessionName?: string | null;
    now?: Date;
  }): AgentActivity | null {
    const nodeId = input.nodeId ?? (input.sessionName ? this._resolveSession({ sessionName: input.sessionName })?.node_id : null);
    if (!nodeId) return null;

    const payload = this._pickLatest(nodeId);
    if (!payload?.activity) return null;

    const activity = payload.activity;
    if (input.sessionName && payload.sessionName !== input.sessionName) return null;

    const referenceTime = input.now ?? this.now();

    // W2a-1 — compare-at-read against the shipped occupant-tenure generation_uuid (pm ruling
    // 2026-08-08, the fully-specified Variant C):
    //  (1) the carried generation is REGISTERED FOR THIS NODE and differs from live ⇒ MISMATCH:
    //      positive evidence the claim belongs to a prior, dead tenure ⇒ unknown +
    //      `generation_mismatch`, stale:true, provenance RESOLVED. An unregistered prelaunch
    //      reservation is absence of evidence and stays UNRESOLVABLE, never mismatch.
    //  (2) both known and EQUAL (incl. a same-native-session relaunch — the ledger treats it as a
    //      continuation with no new generation) ⇒ provenance RESOLVED, deliver normally (fresh).
    //  (3) null on EITHER side ⇒ UNRESOLVABLE: ABSENCE of evidence, not a dead-tenure finding. State
    //      UNKNOWN + its distinct reason, stale:true — NEVER fresh (fresh is a positive liveness claim
    //      the seat has not earned; marking null-tenure fresh is bare-attribution one field over). The
    //      STORE delivers the row carrying generationProvenance='unresolved' at the ACTIVITY layer. The
    //      tap's discard-condition change that turns this label into a still-flowing consumer row is a
    //      FOLLOW-ON (qitem-20260808183747-f7f04662, verify-demotion) — NOT this fold; in the INTERIM
    //      the unchanged tap still discards it (a bounded regression whose exposure is the mint-race
    //      transient; mm2 is unaffected — its daemon carries no occupant_tenures table until 0.5.1).
    //      Ignorance and evidence get DIFFERENT verdicts; the two paths must not collapse.
    // Gate runs only when a resolver is injected (else legacy clock-only, no label).
    let generationProvenance: "resolved" | "unresolved" | undefined;
    if (this.resolveOccupantGeneration) {
      let liveGeneration: string | null;
      try {
        liveGeneration = this.resolveOccupantGeneration(nodeId);
      } catch {
        // Resolver EXCEPTION (e.g. a transient ledger/db fault) ⇒ DEGRADE to a distinct unknown
        // branch: never crash the read, never render fresh. Distinct from a clean null (unresolvable).
        return this.generationDegraded(activity, referenceTime);
      }
      const recordedGeneration = activity.generation ?? null;
      if (liveGeneration !== null && recordedGeneration !== null) {
        if (this.isRegisteredOccupantGeneration) {
          let registered: boolean;
          try {
            registered = this.isRegisteredOccupantGeneration(nodeId, recordedGeneration);
          } catch {
            return this.generationDegraded(activity, referenceTime);
          }
          if (!registered) {
            return this.generationUnresolved(activity, referenceTime, "generation_unresolvable");
          }
        }
        if (recordedGeneration !== liveGeneration) {
          return this.generationMismatch(activity, referenceTime);
        }
        generationProvenance = "resolved";
      } else {
        return this.generationUnresolved(
          activity,
          referenceTime,
          liveGeneration === null ? "generation_unresolvable" : "generation_unverifiable",
        );
      }
    }

    const eventTime = activity.eventAt ? Date.parse(activity.eventAt) : NaN;
    if (Number.isFinite(eventTime) && referenceTime.getTime() - eventTime > this.freshnessMs) {
      return {
        ...activity,
        state: "unknown",
        reason: "stale_runtime_hook",
        evidenceSource: "runtime_hook",
        sampledAt: referenceTime.toISOString(),
        fallback: false,
        stale: true,
        generationProvenance,
      };
    }

    return {
      ...activity,
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: false,
      generationProvenance,
    };
  }

  /** W2a-1 — the dead-tenure verdict: the claim's occupant generation is REGISTERED FOR THIS NODE and
   *  DIFFERENT from the live generation. The membership gate runs before this helper, so an uncommitted
   *  reservation can never manufacture a positive dead-tenure finding.
   *  It must not be honored as the live seat. Returns unknown + `generation_mismatch`,
   *  stale:true (detection fires), provenance `resolved` (both generations WERE resolved — they simply
   *  differ). This is the ONLY generation case that abstains; a null on either side is UNRESOLVED
   *  provenance and is DELIVERED labelled, never routed here. */
  private generationMismatch(activity: AgentActivity, referenceTime: Date): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason: "generation_mismatch",
      generationProvenance: "resolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  /** W2a-1 — the UNRESOLVABLE-provenance verdict (ABSENCE of evidence, not a dead-tenure finding).
   *  State UNKNOWN + a distinct reason + stale:true so no consumer reads it as verified-live (fresh is
   *  a positive liveness claim). The STORE delivers the row carrying generationProvenance:"unresolved"
   *  at the ACTIVITY layer; turning that label into a still-flowing CONSUMER row is the tap FOLLOW-ON
   *  (verify-demotion, qitem-20260808183747-f7f04662) — the unchanged tap still discards it in the
   *  INTERIM (a bounded regression, mint-race-transient exposure; mm2 has no occupant_tenures table
   *  until 0.5.1). Kept DISTINCT from generationMismatch: ignorance and evidence get different verdicts,
   *  and the paths must not collapse — at the store now, and at the tap when the follow-on lands. */
  private generationUnresolved(
    activity: AgentActivity,
    referenceTime: Date,
    reason: "generation_unresolvable" | "generation_unverifiable",
  ): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason,
      generationProvenance: "unresolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  /** W2a-1 — the resolver-EXCEPTION verdict: the live-generation resolver threw (a transient ledger/db
   *  fault). DEGRADE to unknown + a DISTINCT reason (`generation_resolver_error`) + stale:true, so the
   *  read never crashes and the claim is never rendered fresh; provenance `unresolved`. Kept separate
   *  from a clean null (unresolvable) so a resolver FAULT is distinguishable from an honest ABSENCE. */
  private generationDegraded(activity: AgentActivity, referenceTime: Date): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason: "generation_resolver_error",
      generationProvenance: "unresolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  resolveSession(input: { sessionName?: string | null; nodeId?: string | null; runtime?: string | null }): { sessionId: string; rigId: string; nodeId: string; sessionName: string; runtime: string | null } | null {
    const row = this._resolveSession(input);
    if (!row) return null;
    // OMP identity is node-scoped so a reused session name on another node can
    // never receive this seat's resume token. Other runtimes keep main's name lookup, but only
    // when the name is what was asked: an explicit nodeId (a hook event may name an archived
    // node) answers with that node's own session, so the pair never mixes two nodes.
    const sessionRow = (row.runtime === "omp"
      ? this.db.prepare("SELECT id FROM sessions WHERE session_name = ? AND node_id = ? ORDER BY id DESC LIMIT 1").get(row.session_name, row.node_id)
      : { id: row.session_id }) as { id: string } | undefined | null;
    if (!sessionRow) return null;
    return { sessionId: sessionRow.id, rigId: row.rig_id, nodeId: row.node_id, sessionName: row.session_name, runtime: row.runtime };
  }

  private _resolveSession(input: { sessionName?: string | null; nodeId?: string | null }): SessionLookupRow | null {
    if (input.nodeId) {
      const row = this.db.prepare(`
        SELECT s.id AS session_id, n.rig_id, n.id AS node_id, s.session_name, n.runtime
        FROM nodes n
        LEFT JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        WHERE n.id = ?
        LIMIT 1
      `).get(input.nodeId) as SessionLookupRow | undefined;
      if (row?.session_name) return row;
    }

    if (!input.sessionName) return null;
    const latest = findLatestSessionNameMatch(this.db, input.sessionName);
    if (!latest) return null;
    const row = this.db.prepare(`
      SELECT s.id AS session_id, n.rig_id, n.id AS node_id, s.session_name, n.runtime
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      WHERE s.id = ?
    `).get(latest.id) as SessionLookupRow | undefined;
    return row ?? null;
  }
}

/** Hook events Claude Code delivers in the background (`async: true`, native comms step 2; PreToolUse since workspaces-o9o.4): the
 *  relay stamps them when it RUNS, not when the hook fired, so arrival order (seq) does not order them. The runners post the same events
 *  with their own eventAt, and the same rule holds for them. They are also the events that carry a tool call id. */
const TOOL_CALL_EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const ASYNC_RELAYED_EVENTS = TOOL_CALL_EVENTS;
/** workspaces-o9o.4 F3: a plain permission prompt (Notification/permission_prompt) names no tool and carries no call id (Claude Code
 *  2.1.319 and 2.1.325, measured), so an async tool end clears it only when stamped more than this after it. Measured relay stamp lag:
 *  13-27 ms idle (n=20) and 13-28 ms during a full suite under heavy.lock (n=30, load 5.5 on 20 cores). Lag above this under heavier load
 *  is unmeasured: such an end would clear the prompt early. A question to the human never uses this window (promptClearedBy). */
export const ASYNC_PROMPT_CLEAR_SLACK_MS = 2_000;

type OrderingActivity = Pick<AgentActivity, "rawEvent" | "eventAt"> & Partial<Pick<AgentActivity, "state" | "rawSubtype" | "dialog" | "toolCallId" | "generation" | "recordedBy" | "questionKey" | "promptTool">>;

/** workspaces-o9o.4 F3: the AskUserQuestion calls of the current turn, by call id: those started, and those of them still open.
 *  workspaces-o9o.59: and how many questions the turn asked and how many of them ended, which needs no call id. */
export interface QuestionCalls {
  started: ReadonlySet<string>;
  open: ReadonlySet<string>;
  /** The turn's questions: the smallest number of questions its AskUserQuestion PermissionRequests can be (questionsAsked). */
  asks: number;
  /** The turn's AskUserQuestion ends (PostToolUse/PostToolUseFailure), one per call id; an end with no call id counts on its own. */
  ends: number;
}

/** workspaces-o9o.4 F3: whether an async tool event may displace a waiting prompt. A tool start never can (a call starting answers
 *  nothing, and its start can be stamped after a prompt it preceded). A question to the human (OF-278: AskUserQuestion) is cleared only by
 *  the end of one of the current turn's own AskUserQuestion calls, and only once none of them is left open: an end relayed late from an
 *  earlier turn's question names a call this turn never started. An end with no call id (a seat still on the relay from before
 *  workspaces-o9o.4, until it is relaunched) keeps the old rule: any AskUserQuestion end. Stop and UserPromptSubmit are synchronous and
 *  clear a question by arrival. Whatever the call ids say, a question stays while the turn has asked more questions than have ended
 *  (workspaces-o9o.59). A plain permission prompt that names its tool (workspaces-o9o.37: its PermissionRequest, or the Notification that
 *  carries that tool as promptTool) is cleared only by an end of that same tool, with no time window. A plain prompt that names none (a seat
 *  on the relay from before workspaces-o9o.37, until it is relaunched) is cleared by a tool end stamped more than ASYNC_PROMPT_CLEAR_SLACK_MS
 *  after it. */
function promptClearedBy(prompt: OrderingActivity, candidate: OrderingActivity, candidateMs: number, promptMs: number, questions: QuestionCalls): boolean {
  if (candidate.rawEvent === "PreToolUse") return false;
  if (prompt.dialog === "question" || (prompt.rawEvent === "PermissionRequest" && prompt.rawSubtype === QUESTION_DIALOG_TOOL)) {
    if (candidate.rawSubtype !== QUESTION_DIALOG_TOOL) return false;
    // workspaces-o9o.59: a question the turn asked and nothing has ended yet is still waiting, whatever the call ids say: a follow-up question's
    // PermissionRequest can arrive before its own (async) start, and the earlier question's late end must not answer it.
    if (questions.asks > questions.ends) return false;
    const id = candidate.toolCallId;
    if (!id) return true;
    return questions.started.has(id) && questions.open.size === 0;
  }
  const tool = prompt.promptTool ?? (prompt.rawEvent === "PermissionRequest" ? prompt.rawSubtype ?? undefined : undefined);
  if (tool) return (candidate.rawEvent === "PostToolUse" || candidate.rawEvent === "PostToolUseFailure") && candidate.rawSubtype === tool;
  return Number.isFinite(promptMs) ? candidateMs > promptMs + ASYNC_PROMPT_CLEAR_SLACK_MS : true;
}

/** The latest activity among a node's newest rows (newest first by seq). Synchronous hooks keep arrival order. An async event
 *  (PreToolUse/PostToolUse/PostToolUseFailure) is the latest only when its own eventAt is strictly newer than the current latest's
 *  (step-2 review F1), and, against a prompt that waits on a person, only when promptClearedBy allows it (workspaces-o9o.4 F3). Async
 *  rows are taken oldest first, so one that clears a prompt is then compared with the async rows after it. With no synchronous row in
 *  the window, the async row with the newest eventAt is the latest. */
export function pickLatestByOrdering<T extends { activity?: OrderingActivity } | null>(
  newestFirst: T[],
  questions: QuestionCalls = questionCallsIn(newestFirst),
): T | null {
  const time = (p: T) => (p?.activity?.eventAt ? Date.parse(p.activity.eventAt) : NaN);
  const isAsync = (p: T) => ASYNC_RELAYED_EVENTS.has(p?.activity?.rawEvent ?? "");
  const baseIndex = newestFirst.findIndex((p) => p?.activity && !isAsync(p));
  const asyncCandidates = (baseIndex === -1 ? newestFirst : newestFirst.slice(0, baseIndex))
    .filter((p) => p?.activity && isAsync(p) && Number.isFinite(time(p)))
    .reverse() // oldest arrival first: a stable sort below keeps arrival order among equal times
    .sort((x, y) => time(x) - time(y));
  const base = baseIndex === -1 ? null : newestFirst[baseIndex]!;
  let best: T | null = base;
  for (const candidate of asyncCandidates) {
    const t = time(candidate);
    const bestTime = best ? time(best) : -Infinity;
    if (best !== null && !(t > (Number.isFinite(bestTime) ? bestTime : Infinity))) continue;
    if (best?.activity?.state === "needs_input" && !promptClearedBy(best.activity, candidate!.activity!, t, bestTime, questions)) continue;
    best = candidate;
  }
  return best ?? newestFirst[0] ?? null;
}

/** workspaces-o9o.4 F2: a tool call that started and has not ended, as the open-call read reports it. */
export interface OpenToolCall {
  tool: string;
  callId: string;
  /** The start's eventAt: the relay's stamp, a few tens of ms after the hook fired (measured). */
  startedAt: string;
}

/** Events that end a turn: what is still open at one of them never ends with a hook (an interrupted call fires none). Pi and pda runs
 *  begin with `active` (agent_start / run_start). */
function isTurnBoundary(activity: Pick<OrderingActivity, "rawEvent" | "rawSubtype">): boolean {
  const e = activity.rawEvent;
  return e === "UserPromptSubmit" || e === "Stop" || e === "SessionStart" || e === "SessionEnd"
    || (e === "active" && (activity.rawSubtype === "agent_start" || activity.rawSubtype === "run_start"));
}

/** How many of a node's newest activity rows a read looks through: the latest-hook read (to find the newest synchronous row and order the
 *  async rows after it by eventAt), the open-call read and the socket input point (seat-messaging/input-point). One window for all of them
 *  (workspaces-o9o.57): the latest read used to look at 20, so a prompt followed by 20 or more async rows (parallel tool calls relayed late)
 *  fell out of it and the seat read busy while it waited. A prompt behind more than this many async rows still falls out. */
export const ACTIVITY_SCAN_ROWS = 200;

/** workspaces-o9o.4 F2: the calls of the current turn that started and have not ended, oldest first, from the rows that carry a call id
 *  (rows without one are left to the newest-event rule). The rows newer than the last turn boundary in the newest generation are read
 *  whole before deciding, because an async start can arrive after its own end. A start stamped before the boundary is not counted. */
export function openToolCallsIn(newestFirst: Array<{ activity?: AgentActivity } | null>): OpenToolCall[] {
  const seen = new Set<string>();
  return turnCalls(newestFirst).open
    // An AskUserQuestion call is a question to the human, reported by its PermissionRequest; it is never the running tool.
    .filter((a) => a.rawSubtype !== QUESTION_DIALOG_TOOL)
    .filter((a) => (seen.has(a.toolCallId!) ? false : (seen.add(a.toolCallId!), true)))
    .map((a) => ({ tool: a.rawSubtype ?? "tool", callId: a.toolCallId!, startedAt: a.eventAt! }))
    .sort((x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt));
}

/** workspaces-o9o.4 F3: the AskUserQuestion calls of the current turn (the same turn the open-call read uses), by call id. */
export function questionCallsIn(newestFirst: Array<{ activity?: OrderingActivity } | null>): QuestionCalls {
  const { turn, started, open } = turnCalls(newestFirst);
  const ids = (rows: OrderingActivity[]) => new Set(rows.filter((a) => a.rawSubtype === QUESTION_DIALOG_TOOL).map((a) => a.toolCallId!));
  const asked = turn.filter((a) => a.rawEvent === "PermissionRequest" && a.rawSubtype === QUESTION_DIALOG_TOOL);
  const ended = turn.filter((a) => (a.rawEvent === "PostToolUse" || a.rawEvent === "PostToolUseFailure") && a.rawSubtype === QUESTION_DIALOG_TOOL);
  const endIds = new Set(ended.filter((a) => a.toolCallId).map((a) => a.toolCallId!));
  return {
    started: ids(started),
    open: ids(open),
    asks: questionsAsked(asked),
    ends: endIds.size + ended.filter((a) => !a.toolCallId).length,
  };
}

/** workspaces-o9o.59: how many questions a turn's AskUserQuestion PermissionRequests are. One question can be recorded twice, once by the relay
 *  and once by the question-wait hold (recordedBy: question_hold), and never more than once by each; each record names its questions by digest
 *  (questionKey). So per digest the question count is the larger of the two sources' counts. A record with no digest (a seat on a relay copy
 *  from before, or a hold given no questions) may be any question: it is matched against the other source's records that are not yet paired,
 *  and counts only beyond them. The result is the smallest count the records allow: a stale "waiting" (an overcount) is the worse failure,
 *  and only keyless records can undercount. */
function questionsAsked(asked: OrderingActivity[]): number {
  const relay = new Map<string, number>();
  const hold = new Map<string, number>();
  let relayKeyless = 0;
  let holdKeyless = 0;
  for (const a of asked) {
    const byHold = a.recordedBy === "question_hold";
    if (!a.questionKey) { if (byHold) holdKeyless += 1; else relayKeyless += 1; continue; }
    const side = byHold ? hold : relay;
    side.set(a.questionKey, (side.get(a.questionKey) ?? 0) + 1);
  }
  let keyed = 0;
  let relayUnpaired = 0;
  let holdUnpaired = 0;
  for (const key of new Set([...relay.keys(), ...hold.keys()])) {
    const r = relay.get(key) ?? 0;
    const h = hold.get(key) ?? 0;
    keyed += Math.max(r, h);
    relayUnpaired += Math.max(0, r - h);
    holdUnpaired += Math.max(0, h - r);
  }
  return keyed + Math.max(relayKeyless - holdUnpaired, holdKeyless - relayUnpaired, 0);
}

/** The tool starts with a call id in the current turn (rows newer than the last turn boundary, in the newest generation, read whole,
 *  because an async start can arrive after its own end; a start stamped before the boundary is not counted), and those not yet ended. */
function turnCalls<A extends OrderingActivity>(newestFirst: Array<{ activity?: A } | null>): { turn: A[]; started: A[]; open: A[] } {
  const rows = newestFirst.map((r) => r?.activity).filter((a): a is A => !!a);
  if (rows.length === 0) return { turn: [], started: [], open: [] };
  const generation = rows[0]!.generation ?? null;
  const turn: A[] = [];
  let boundaryMs = Number.NEGATIVE_INFINITY;
  for (const a of rows) {
    if ((a.generation ?? null) !== generation) break;
    if (isTurnBoundary(a)) { boundaryMs = a.eventAt ? Date.parse(a.eventAt) : boundaryMs; break; }
    turn.push(a);
  }
  const ended = new Set(turn.filter((a) => (a.rawEvent === "PostToolUse" || a.rawEvent === "PostToolUseFailure") && a.toolCallId).map((a) => a.toolCallId!));
  const started = turn.filter((a) => a.rawEvent === "PreToolUse" && a.toolCallId && a.eventAt && !(Date.parse(a.eventAt) < boundaryMs));
  return { turn, started, open: started.filter((a) => !ended.has(a.toolCallId!)) };
}

/** The activity a runtime hook event means, before freshness or generation checks. The one mapping behind
 *  ingest, the send gate and the wake ladder. `seatRuntime` is the managed seat's runtime: runtime_error is
 *  a Pi/OMP runner signal (OMP on each model error, Pi when a turn ends on one), and a hook claiming it on another
 *  runtime's seat must not escalate it. The same
 *  holds for a pda runner's held-message report (OF-89): `Notification/<held code>` is needs_input on a pda seat only. */
export function hookEventState(rawEvent: string | null | undefined, rawSubtype: string | null | undefined, seatRuntime: string | null): AgentActivity["state"] {
  if (rawEvent === "UserPromptSubmit" || rawEvent === "PreToolUse" || rawEvent === "active") return "running";
  // Native comms step 2 (design-native-comms-20261030 §7 F1): a tool finished, so any permission prompt it raised was
  // answered yes and the turn goes on. Measured on Claude Code 2.1.314: an approved prompt is followed by PostToolUse,
  // then Stop; a DENIED one fires no hook at all (not PermissionDenied, not Stop, no idle_prompt within 95 s), so a
  // denial still leaves the seat's latest hook at permission_prompt until its next input.
  if (rawEvent === "PostToolUse" || rawEvent === "PostToolUseFailure") return "running";
  // OPR.0.4.1.10 — Codex's official approval hook (openai/codex PR #17563). A PermissionRequest
  // means the agent is BLOCKED waiting on a command / patch / network approval = needs_input. This is
  // the HOOK-PRIMARY signal for Codex, which emits no Claude-style Notification; classifySendReadiness
  // already prefers a fresh runtime_hook needs_input runtime-agnostically, so wiring this event makes
  // the Codex rig-send guard hook-primary by construction (capture-pane scan stays as the fallback).
  // The official payload carries session_id/turn_id/cwd/model/permission_mode/tool_name/tool_input;
  // the relay forwards tool_name as the subtype, so `evidence` names the tool being approved.
  if (rawEvent === "PermissionRequest") return "needs_input";
  if (rawEvent === "Notification") {
    if (rawSubtype === "permission_prompt" || rawSubtype === "elicitation_dialog" || ((seatRuntime === "omp" || seatRuntime === "pi") && rawSubtype === "runtime_error")
      || (seatRuntime === PDA_RUNTIME && isPdaHeldCode(rawSubtype))) return "needs_input";
    return rawSubtype === "idle_prompt" ? "idle" : "unknown";
  }
  if (rawEvent === "Stop" || rawEvent === "SessionEnd" || rawEvent === "stop" || rawEvent === "idle") return "idle";
  return "unknown";
}

/** A pda runner's held-message report (OF-89): `Notification/<held code>`. It is DISPLAY evidence. It reads
 *  needs_input on a pda seat so `rig ps` and the UI show the hold, but it is not a prompt on the pane and no
 *  consumer that decides whether to send or wake may treat it as one: a pda seat's send gate is its runner's
 *  sidecar (OF-88), and a hold the runner cannot answer for must behave as it did before this report existed. */
export function isPdaHeldReport(activity: Pick<AgentActivity, "rawEvent" | "rawSubtype"> | null | undefined): boolean {
  return activity?.rawEvent === "Notification" && isPdaHeldCode(activity.rawSubtype);
}

/** The hook activity as a send or wake decision may read it: a held report reads as the unknown it was before
 *  OF-89 (same reason, same evidence), every other activity is returned as it is. */
export function decisionView<T extends AgentActivity | null | undefined>(activity: T): T {
  if (!activity || activity.state !== "needs_input" || !isPdaHeldReport(activity)) return activity;
  return { ...activity, state: "unknown" };
}

/** A runtime hook that leaves the agent waiting on a person: an approval, a picker or an elicitation. */
export function hookMeansNeedsInput(rawEvent: string | null | undefined, rawSubtype: string | null | undefined, seatRuntime: string | null): boolean {
  return hookEventState(rawEvent, rawSubtype, seatRuntime) === "needs_input";
}

/** What the store's latest hook for a seat says: its current state, or, past the freshness window, what its
 *  retained raw event means. Generation-mismatched or unresolvable evidence says nothing ("unknown"). */
export function latestHookState(activity: AgentActivity | null | undefined, seatRuntime: string | null): AgentActivity["state"] {
  if (activity?.evidenceSource !== "runtime_hook") return "unknown";
  if (isPdaHeldReport(activity)) return "unknown"; // display evidence only, fresh or past the freshness window
  if (activity.stale !== true) return activity.state;
  return activity.reason === "stale_runtime_hook" ? hookEventState(activity.rawEvent, activity.rawSubtype, seatRuntime) : "unknown";
}

/** The store's latest hook still says the seat waits on a person. Nothing newer was recorded, so nothing
 *  answered it. Shared by the send gate and the wake ladder. */
export function latestHookWaitsOnPerson(activity: AgentActivity | null | undefined, seatRuntime: string | null): boolean {
  return latestHookState(activity, seatRuntime) === "needs_input";
}

/** The store's latest hook shows the seat moved on after `since`: observed after it, generation-valid, and
 *  meaning work started or the turn ended. Older, absent, mismatched or unknown evidence does not. */
export function latestHookMovedOn(activity: AgentActivity | null | undefined, since: string, seatRuntime: string | null): boolean {
  const observedAt = activity?.eventAt ? Date.parse(activity.eventAt) : NaN;
  if (!(observedAt > Date.parse(since))) return false;
  const state = latestHookState(activity, seatRuntime);
  return state === "running" || state === "idle";
}

function normalizeHookActivity(input: {
  runtime: string | null;
  /** The managed seat's runtime, never a hook's claim. */
  seatRuntime: string | null;
  hookEvent: string;
  subtype: string | null;
  sampledAt: string;
  eventAt: string;
  generation?: string | null;
  toolCallId?: string | null;
  questionKey?: string | null;
  recordedBy?: QuestionAskRecorder | null;
}): AgentActivity {
  const rawEvent = input.hookEvent;
  const rawSubtype = input.subtype;
  const reason = normalizeReason(rawSubtype ?? rawEvent);
  const runtime = input.runtime;
  const state = hookEventState(rawEvent, rawSubtype, input.seatRuntime);
  let normalizedReason = reason;
  if (rawEvent === "PermissionRequest") {
    // OF-278: Claude's AskUserQuestion dialog is a question to the human, not a permission prompt (hook payloads measured on 2.1.319).
    normalizedReason = rawSubtype === QUESTION_DIALOG_TOOL ? QUESTION_DIALOG_REASON : "permission_request";
  } else if (rawEvent === "at_limit") {
    normalizedReason = "usage_limit";
  } else if (rawEvent === "Notification") {
    if (state === "unknown") normalizedReason = rawSubtype ? reason : "notification";
  } else if (rawEvent === "SessionStart") {
    normalizedReason = "session_start_observed";
  } else if (state === "unknown") {
    normalizedReason = "unmapped_runtime_hook";
  }

  return {
    state,
    reason: normalizedReason,
    ...(rawEvent === "PermissionRequest" && rawSubtype === QUESTION_DIALOG_TOOL ? { dialog: "question" as const } : {}),
    evidenceSource: "runtime_hook",
    sampledAt: input.sampledAt,
    evidence: rawSubtype ?? rawEvent,
    eventAt: input.eventAt,
    rawEvent,
    rawSubtype,
    runtime,
    fallback: false,
    stale: false,
    generation: input.generation ?? null,
    ...(input.toolCallId && TOOL_CALL_EVENTS.has(rawEvent) ? { toolCallId: input.toolCallId } : {}),
    ...(input.questionKey && (rawEvent === "PostToolUse" || rawEvent === "PostToolUseFailure" || rawEvent === "PermissionRequest") && rawSubtype === QUESTION_DIALOG_TOOL
      ? { questionKey: input.questionKey } : {}),
    ...(input.recordedBy && rawEvent === "PermissionRequest" && rawSubtype === QUESTION_DIALOG_TOOL ? { recordedBy: input.recordedBy } : {}),
  };
}

/** The tool whose PermissionRequest is a question to the human, and the reason the store gives that wait (OF-278). */
export const QUESTION_DIALOG_TOOL = "AskUserQuestion";
export const QUESTION_DIALOG_REASON = "question_dialog";

function normalizeReason(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function parseTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseActivityPayload(payload: string): { sessionName?: string; activity?: AgentActivity } | null {
  try {
    return JSON.parse(payload) as { sessionName?: string; activity?: AgentActivity };
  } catch {
    return null;
  }
}
