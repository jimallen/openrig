// OF-182: after a restore that RESUMED a seat's conversation, tell the seat it was restarted. A resumed seat comes back
// idle with its old context, but every background task, shell loop and timer of the previous process was killed, and
// nothing says so (rig ps shows it ready). eztrack lost about 40 minutes to this on 2026-10-30.
//
// One prompt per resumed seat per restore, through the normal send path (native where eligible, tmux otherwise; the
// outbox row is the record). Who gets it:
//  - status `resumed` and not `reattached` (OF-155: a reattached seat's session never stopped, so nothing was killed);
//  - not `fresh-primed` / `fresh` / `rebuilt`: those start a new conversation with their startup context or checkpoint.
// A seat that is mid-turn or waiting on a prompt is not interrupted: native delivery waits for the seat's next boundary
// by itself, and the tmux path waits for idle and is refused at a prompt, so the attempt is repeated until the seat moves
// on or the window closes. The delivery id is fixed per restore and node: a row under it means done, never resent.
import { labelForTmuxSend, type OutboxEntry, type OutboxRecordInput, type OutboxOutcomeLabel } from "./outbox-handler.js";
import { inertStartupText } from "./packet-text.js";
import type { RestoreNodeResult, RestoreResult } from "./types.js";

export const POST_RESTART_SENDER = "restore@system";

export interface PostRestartSendResult {
  ok: boolean;
  path?: "native";
  outcome?: string;
  verified?: boolean;
  reason?: string;
  error?: string;
}

export interface PostRestartDeps {
  /** `recovery.post_restart_prompt`, read once per restore. */
  enabled: () => boolean;
  /** The running session of a node, or null. */
  sessionOf: (nodeId: string) => string | null;
  /** The rig's name, for the prompt. */
  rigNameOf: (rigId: string) => string | null;
  send: (sessionName: string, text: string, opts: { deliveryId: string; actorSession: string; auditPointer: string; waitForIdleMs: number }) => Promise<PostRestartSendResult>;
  outbox: {
    getById: (outboxId: string) => OutboxEntry | null;
    record: (input: OutboxRecordInput) => OutboxEntry;
    markDelivered: (outboxId: string, label?: OutboxOutcomeLabel) => OutboxEntry;
    markFailed: (outboxId: string, label?: OutboxOutcomeLabel) => OutboxEntry;
  };
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
  | { nodeId: string; sessionName: string | null; outcome: "delivered" | "native_written" | "retained" | "already_sent" | "no_session" | "undelivered"; attempts: number; detail?: string };

/** Who gets the prompt (see the header). */
export function needsPostRestartPrompt(node: RestoreNodeResult): boolean {
  return node.status === "resumed" && !node.reattached;
}

export function postRestartDeliveryId(restoreSeq: number, nodeId: string): string {
  return `post-restart-${restoreSeq}-${nodeId}`;
}

export function postRestartText(input: { rigName: string; restartedAt: string }): string {
  return inertStartupText(
    `OpenRig: this seat was restarted at ${input.restartedAt} (rig ${input.rigName} was restored and your conversation resumed). `
    + "Every background task, shell loop and timer you had running before the restart was killed and is not running now, "
    + "including any wake-up timer you set yourself. Check your handover and notes and any runs you had in flight, "
    + "then resume or restart what is still needed. Nothing else changed.",
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

  /** `restore.completed`: one delivery per resumed seat, run concurrently. Resolves when every seat is settled. */
  async onRestoreCompleted(event: { seq: number; rigId: string; result: RestoreResult }): Promise<PostRestartOutcome[]> {
    if (!this.deps.enabled()) return [];
    const nodes = event.result.nodes.filter(needsPostRestartPrompt);
    if (nodes.length === 0) return [];
    const text = postRestartText({ rigName: this.deps.rigNameOf(event.rigId) ?? event.rigId, restartedAt: this.now().toISOString() });
    return Promise.all(nodes.map((node) => this.deliverOne(event.seq, node.nodeId, text)));
  }

  private async deliverOne(restoreSeq: number, nodeId: string, text: string): Promise<PostRestartOutcome> {
    const deliveryId = postRestartDeliveryId(restoreSeq, nodeId);
    if (this.inFlight.has(deliveryId) || this.deps.outbox.getById(deliveryId)) {
      return { nodeId, sessionName: null, outcome: "already_sent", attempts: 0 };
    }
    this.inFlight.add(deliveryId);
    try {
      const started = this.now().getTime();
      await this.sleep(this.firstDelayMs);
      let attempts = 0;
      let last: PostRestartSendResult | null = null;
      let sessionName: string | null = null;
      while (this.now().getTime() - started < this.windowMs) {
        if (this.deps.outbox.getById(deliveryId)) return { nodeId, sessionName, outcome: "already_sent", attempts };
        sessionName = this.deps.sessionOf(nodeId);
        if (sessionName) {
          attempts++;
          last = await this.deps.send(sessionName, text, { deliveryId, actorSession: POST_RESTART_SENDER, auditPointer: deliveryId, waitForIdleMs: this.waitForIdleMs });
          if (last.path === "native") return { nodeId, sessionName, outcome: "native_written", attempts };
          if (last.outcome === "retained") return { nodeId, sessionName, outcome: "retained", attempts };
          if (last.ok) {
            // The tmux path records nothing itself; record and settle the row as the send route does.
            this.deps.outbox.record({ outboxId: deliveryId, senderSession: POST_RESTART_SENDER, destinationSession: sessionName, body: text,
              auditPointer: deliveryId, identityProvenance: "transport:v1" });
            this.deps.outbox.markDelivered(deliveryId, labelForTmuxSend(last));
            return { nodeId, sessionName, outcome: "delivered", attempts };
          }
          this.deps.log?.(`[post-restart] ${sessionName}: attempt ${attempts} not delivered (${last.reason ?? last.error ?? "unknown"}); retrying`);
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
