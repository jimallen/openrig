// OF-182: after a restore that RESUMED a seat's conversation, tell the seat it was restarted. A resumed seat comes back
// idle with its old context, but what ran inside its previous session (background tasks, timers, its own wake-up timer)
// stopped with it, and nothing says so (rig ps shows it ready). eztrack lost about 40 minutes to this on 2026-10-30.
// A process started detached (nohup) survives `rig down` (measured on Sparky, design §OF-182), so the prompt asks the
// seat to check what is running before it restarts anything.
//
// One prompt per resumed seat per restore, through the normal send path (native where eligible, tmux otherwise; the
// outbox row is the record). Who gets it:
//  - status `resumed`;
//  - not `fresh-primed` / `fresh` / `rebuilt`: those start a new conversation with their startup context or checkpoint.
// A seat that is mid-turn or waiting on a prompt is not interrupted: native delivery waits for the seat's next boundary
// by itself, and the tmux path waits for idle and is refused at a prompt, so the attempt is repeated until the seat moves
// on or the window closes. The delivery id is fixed per restore and node: a row under it means done, never resent.
// OF-184: the window runs from the restore event, "restarted at" is the seat's session start, and a session that started
// after the restore is a replacement (the seat was launched again), which is not told its conversation resumed. A daemon
// restart inside the window re-derives the pending prompts from the event log (post-restart-wiring.ts). With the typing
// guard on, the send comes back `retained`: the guard owns that row and it is final, so such a seat gets no prompt (pinned).
//
// Seat Messaging S4b: a seat the pump serves takes none of the above loop. Its prompt is committed at the restore under the same fixed id,
// first attempt `firstDelayMs` out, bound to the occupant, and the pump carries it until the gate records it. The loop, the window and the
// row written after the send are for a seat with no gate, until S5. A later occupant ends the row (`whyNoLongerWanted`), with no notice.
import { labelForTmuxSend, type OutboxEntry, type OutboxRecordInput, type OutboxOutcomeLabel } from "./outbox-handler.js";
import { inertStartupText } from "./packet-text.js";
import type { MessageHandOff } from "./seat-messaging/hand-off.js";
import { messageId } from "./seat-messaging/ports.js";
import type { ObligedMessage } from "./seat-messaging/pump-ports.js";
import type { RestoreNodeResult, RestoreResult } from "./types.js";

export const POST_RESTART_SENDER = "restore@system";

/** A seat's running session: its name, and when that session started (ISO, UTC). */
export interface PostRestartSession {
  name: string;
  startedAt: string;
}

export interface PostRestartSendResult {
  ok: boolean;
  path?: "native" | "hc";
  /** hc seats: the record a sweep settles an unconfirmed send by (see HcDelivery). */
  hcPending?: unknown;
  outcome?: string;
  verified?: boolean;
  reason?: string;
  error?: string;
}

export interface PostRestartDeps {
  /** `recovery.post_restart_prompt`, read once per restore. */
  enabled: () => boolean;
  /** The running session of a node (latest), or null. */
  sessionOf: (nodeId: string) => PostRestartSession | null;
  /** The rig's name, for the prompt. */
  rigNameOf: (rigId: string) => string | null;
  send: (sessionName: string, text: string, opts: { deliveryId: string; actorSession: string; auditPointer: string; waitForIdleMs: number; keepRowOpenOnRefusal: boolean; freezeBody: boolean; occupantGeneration?: string | null }) => Promise<PostRestartSendResult>;
  outbox: {
    getById: (outboxId: string) => OutboxEntry | null;
    record: (input: OutboxRecordInput) => OutboxEntry;
    markDelivered: (outboxId: string, label?: OutboxOutcomeLabel) => OutboxEntry;
    markFailed: (outboxId: string, label?: OutboxOutcomeLabel) => OutboxEntry;
    markIndeterminate: (outboxId: string, label?: OutboxOutcomeLabel) => OutboxEntry;
  };
  /** The pump's hand-off, read when a restore is handled: boot wires it after this notifier. Absent or null: the pump is off. */
  handOff?: () => Pick<MessageHandOff, "takes" | "accept"> | null;
  /** The seat's occupant now, or null when unknown. */
  occupantGenerationOf?: (sessionName: string) => string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Before the first attempt: the resumed process settles and registers its hooks (default 20 s). */
  firstDelayMs?: number;
  /** Between attempts while the seat is busy or at a prompt (default 60 s). */
  retryEveryMs?: number;
  /** After this, the prompt is recorded failed and not tried again (default 30 min). */
  windowMs?: number;
  /** Each attempt's idle wait on the tmux path (default 60 s). */
  waitForIdleMs?: number;
  log?: (line: string) => void;
}

export type PostRestartOutcome =
  | { nodeId: string; sessionName: string | null; outcome: "accepted" | "delivered" | "native_written" | "retained" | "already_sent" | "no_session" | "undelivered" | "replaced" | "unconfirmed"; attempts: number; detail?: string };

/** Who gets the prompt (see the header). */
export function needsPostRestartPrompt(node: RestoreNodeResult): boolean {
  return node.status === "resumed";
}

export function postRestartDeliveryId(restoreSeq: number, nodeId: string): string {
  return `post-restart-${restoreSeq}-${nodeId}`;
}

/** `restartedAt` is when the seat's session started, not when the prompt is handled. */
export function postRestartText(input: { rigName: string; restartedAt: string }): string {
  return inertStartupText(
    `OpenRig: this seat was restarted at ${input.restartedAt} (rig ${input.rigName} was restored and your conversation resumed). `
    + "Anything that ran inside your previous session stopped with it: background tasks, timers and any wake-up timer "
    + "you set yourself. A process started detached (nohup, setsid, disown) may still be running. Check your handover "
    + "and notes and any runs you had in flight, see what is actually running, and resume or restart only what is "
    + "still needed, so nothing runs twice.",
  );
}

export class PostRestartNotifier {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly firstDelayMs: number;
  private readonly retryEveryMs: number;
  private readonly windowMs: number;
  private readonly waitForIdleMs: number;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PostRestartDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.firstDelayMs = deps.firstDelayMs ?? 20_000;
    this.retryEveryMs = deps.retryEveryMs ?? 60_000;
    this.windowMs = deps.windowMs ?? 30 * 60_000;
    this.waitForIdleMs = deps.waitForIdleMs ?? 60_000;
  }

  /**
   * `restore.completed`: one delivery per resumed seat, run concurrently. Resolves when every seat is settled.
   * `createdAt` (ISO) is when the restore completed: the window runs from it, and a seat whose session started after it
   * is a replacement, not the seat this restore resumed. Without it (tests) the window runs from now and no seat is
   * judged replaced. `pumpOnly`: the restore is past the window (a daemon booting late). Only a seat the pump serves is handled, because the
   * pump has no window and carries the row until the gate records it; a seat with no gate keeps the loop and its window, so it is left alone.
   */
  async onRestoreCompleted(event: { seq: number; rigId: string; result: RestoreResult; createdAt?: string; pumpOnly?: boolean }): Promise<PostRestartOutcome[]> {
    if (!this.deps.enabled()) return [];
    const nodes = event.result.nodes.filter(needsPostRestartPrompt);
    if (nodes.length === 0) return [];
    const rigName = this.deps.rigNameOf(event.rigId) ?? event.rigId;
    const at = event.createdAt === undefined ? Number.NaN : Date.parse(event.createdAt);
    const restoredAtMs = Number.isNaN(at) ? null : at;
    const outcomes = await Promise.all(nodes.map((node) => this.deliverOne(event.seq, node.nodeId, rigName, restoredAtMs, event.pumpOnly === true)));
    return outcomes.filter((o): o is PostRestartOutcome => o !== null);
  }

  /** The pump's check, read at every attempt: the prompt says "your conversation resumed", which is false for a later occupant. So this row
   *  ends, where other text bound to an occupant goes on labelled. Unknown proves nothing. */
  readonly whyNoLongerWanted = (message: ObligedMessage): string | null => {
    const bound = message.occupantGeneration;
    const live = this.deps.occupantGenerationOf?.(message.seat) ?? null;
    return bound !== null && live !== null && live !== bound ? `occupant ${bound} of ${message.seat} was replaced by ${live} after the restore` : null;
  };

  /** A seat the pump serves: the prompt's row commits here and it is the pump's, so nothing waits. Null: this notifier's own path applies. */
  private acceptForPump(deliveryId: string, nodeId: string, rigName: string, restoredAtMs: number | null): PostRestartOutcome | null {
    const session = this.deps.sessionOf(nodeId);
    const handOff = this.deps.handOff?.() ?? null;
    if (!session || !handOff?.takes(session.name)) return null;
    if (restoredAtMs !== null && Date.parse(session.startedAt) > restoredAtMs) {
      return { nodeId, sessionName: session.name, outcome: "replaced", attempts: 0, detail: `session started ${session.startedAt}` };
    }
    const accepted = handOff.accept({
      id: messageId(deliveryId), seat: session.name, sender: POST_RESTART_SENDER, body: postRestartText({ rigName, restartedAt: session.startedAt }), freezeBody: true,
      auditPointer: deliveryId, identityProvenance: "transport:v1", messageClass: "content", occupantGeneration: this.deps.occupantGenerationOf?.(session.name) ?? null,
      firstAttemptAtMs: this.now().getTime() + this.firstDelayMs,
    });
    return { nodeId, sessionName: session.name, outcome: accepted.kind === "accepted" ? "accepted" : "already_sent", attempts: 0 };
  }

  /** The row commits before the first attempt, so a row alone no longer means the prompt was sent: an open one (a refused attempt
   *  this loop retries, or one a crash left) is still to be delivered. */
  private settled(deliveryId: string): boolean {
    const row = this.deps.outbox.getById(deliveryId);
    return row !== null && row.deliveryState !== "pending";
  }

  private async deliverOne(restoreSeq: number, nodeId: string, rigName: string, restoredAtMs: number | null, pumpOnly: boolean): Promise<PostRestartOutcome | null> {
    const deliveryId = postRestartDeliveryId(restoreSeq, nodeId);
    if (this.inFlight.has(deliveryId) || this.settled(deliveryId)) {
      return { nodeId, sessionName: null, outcome: "already_sent", attempts: 0 };
    }
    const taken = this.acceptForPump(deliveryId, nodeId, rigName, restoredAtMs);
    if (taken) return taken;
    if (pumpOnly) return null;
    this.inFlight.add(deliveryId);
    try {
      const started = restoredAtMs ?? this.now().getTime();
      await this.sleep(this.firstDelayMs);
      let attempts = 0;
      let last: PostRestartSendResult | null = null;
      let sessionName: string | null = null;
      let text = "";
      let lastLogged: string | null = null;
      while (this.now().getTime() - started < this.windowMs) {
        if (this.settled(deliveryId)) return { nodeId, sessionName, outcome: "already_sent", attempts };
        const session = this.deps.sessionOf(nodeId);
        sessionName = session?.name ?? null;
        if (session && restoredAtMs !== null && Date.parse(session.startedAt) > restoredAtMs) {
          // The seat was launched again after the restore that resumed it: "your conversation resumed" is false for it.
          this.deps.log?.(`[post-restart] node ${nodeId}: session ${session.name} started after the restore; not sent`);
          return { nodeId, sessionName, outcome: "replaced", attempts, detail: `session started ${session.startedAt}` };
        }
        if (session) {
          text = postRestartText({ rigName, restartedAt: session.startedAt });
          attempts++;
          last = await this.deps.send(session.name, text, { deliveryId, actorSession: POST_RESTART_SENDER, auditPointer: deliveryId, waitForIdleMs: this.waitForIdleMs, keepRowOpenOnRefusal: true, freezeBody: true, occupantGeneration: this.deps.occupantGenerationOf?.(session.name) ?? null });
          if (last.path === "native") return { nodeId, sessionName, outcome: "native_written", attempts };
          if (last.outcome === "retained") return { nodeId, sessionName, outcome: "retained", attempts };
          if (last.ok) {
            // The tmux path records nothing itself; record and settle the row as the send route does.
            this.deps.outbox.record({ outboxId: deliveryId, senderSession: POST_RESTART_SENDER, destinationSession: session.name, body: text,
              auditPointer: deliveryId, identityProvenance: "transport:v1" });
            this.deps.outbox.markDelivered(deliveryId, labelForTmuxSend(last));
            return { nodeId, sessionName, outcome: "delivered", attempts };
          }
          // An hc seat whose reply never came, or whose text the core still holds for a person typing: the text may be
          // delivered, or already is. The retry loop below would put it in twice, so it stops here, and the row says why
          // (indeterminate, with the pending record a sweep settles by).
          if (last.path === "hc" && (last.reason === "waiting_on_person" || last.reason === "delivery_outcome_unknown")) {
            this.deps.outbox.record({ outboxId: deliveryId, senderSession: POST_RESTART_SENDER, destinationSession: session.name, body: text,
              auditPointer: deliveryId, identityProvenance: "transport:v1" });
            this.deps.outbox.markIndeterminate(deliveryId, labelForTmuxSend(last));
            this.deps.log?.(`[post-restart] ${sessionName}: ${last.reason}; not retried (it may still arrive)`);
            return { nodeId, sessionName, outcome: "unconfirmed", attempts, detail: last.reason };
          }
          // One line per distinct reason, not one per attempt: a busy seat is retried for up to the whole window.
          const why = last.reason ?? last.error ?? "unknown";
          if (why !== lastLogged) {
            this.deps.log?.(`[post-restart] ${sessionName}: attempt ${attempts} not delivered (${why}); retrying every ${this.retryEveryMs} ms until the window closes`);
            lastLogged = why;
          }
        }
        await this.sleep(this.retryEveryMs);
      }
      const detail = last ? (last.reason ?? last.error ?? "not delivered") : "no running session";
      if (sessionName) {
        this.deps.outbox.record({ outboxId: deliveryId, senderSession: POST_RESTART_SENDER, destinationSession: sessionName, body: text,
          auditPointer: deliveryId, identityProvenance: "transport:v1" });
        this.deps.outbox.markFailed(deliveryId, { path: "none", evidence: "send_failed", detail: `post-restart window closed: ${detail}` });
      }
      this.deps.log?.(`[post-restart] node ${nodeId}: not delivered within the window (${detail})`);
      return { nodeId, sessionName, outcome: sessionName ? "undelivered" : "no_session", attempts, detail };
    } finally {
      this.inFlight.delete(deliveryId);
    }
  }
}
