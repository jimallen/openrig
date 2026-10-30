// Native comms step 3 (review F3 and the R3 sender notice): what happens after a native row settles, and after the
// deadline sweeper's tmux fallback returns. The queue records the outcome on the row's qitem in the wake ladder's own
// vocabulary (so an unconfirmed outcome is retried and escalated like a tmux one); an agent sender is told in its pane
// when its message ended unconfirmed or undelivered. Kept apart from startup so it is tested without a daemon.
import type { OutboxEntry, OutboxOutcomeLabel } from "./outbox-handler.js";
import type { NativeSettlement } from "./claude-native-inbox.js";
import { inertStartupText } from "./packet-text.js";

export interface NativeSettlementDeps {
  /** QueueRepository.recordNudgeAttempt: a plain update, a no-op for an id that names no qitem (a watchdog job id). */
  recordNudgeAttempt: (qitemId: string, result: string) => void;
  /** Sends a notice to a seat through tmux (never native, so a notice cannot start another native row). */
  sendNotice: (to: string, text: string) => Promise<unknown>;
  /** Whether a sender is a managed agent seat (the daemon's own identities are told through the queue instead). */
  isAgentSeat: (sender: string) => boolean;
}

/** System-authored text typed into the sender's pane, so it is stripped like every system sender's (OF-169). */
export function nativeNoticeText(row: Pick<OutboxEntry, "outboxId" | "destinationSession"> & { nativeWrittenAt?: string | null }, what: string): string {
  return inertStartupText(`OpenRig delivery notice: your message to ${row.destinationSession} (outbox ${row.outboxId}, written ${row.nativeWrittenAt ?? "earlier"}) ${what} `
    + `If it matters, check the seat (rig capture ${row.destinationSession}) and send it again.`);
}

/** The inbox's onSettled: called once per settlement. */
export function createNativeSettlementHandler(deps: NativeSettlementDeps): (row: OutboxEntry, outcome: NativeSettlement) => void {
  return (row, outcome) => {
    if (row.auditPointer) {
      if (outcome.kind === "delivered") deps.recordNudgeAttempt(row.auditPointer, "verified");
      else if (outcome.kind === "unconfirmed") deps.recordNudgeAttempt(row.auditPointer, `indeterminate:native_unconfirmed:${outcome.detail ?? "unconfirmed"}`);
      // failing_over: the fallback's own outcome is recorded when it returns (nativeFallbackOutcome)
    }
    if (outcome.kind === "unconfirmed" && deps.isAgentSeat(row.senderSession)) {
      void deps.sendNotice(row.senderSession, nativeNoticeText(row,
        `is UNCONFIRMED (${outcome.detail ?? "no confirmation"}): the seat did not confirm taking it, and it was not re-sent automatically, to avoid a duplicate.`));
    }
  };
}

/** The tmux fallback's result as the outbox settles it and as the queue records it (review N1: a fallback the typing
 *  guard holds lives on as its own held row; the original settles `failed`, naming it). */
export function nativeFallbackOutcome(res: { ok: boolean; verified?: boolean; outcome?: string; reason?: string; error?: string; outboxIds?: string[] }, label: OutboxOutcomeLabel): {
  state: "delivered" | "failed" | "indeterminate"; label: OutboxOutcomeLabel; nudgeResult: string; undelivered: boolean;
} {
  const held = res.outcome === "retained";
  const state = held || !res.ok ? "failed" : res.verified ? "delivered" : "indeterminate";
  const why = res.reason ?? res.error ?? "fallback failed";
  return {
    state,
    label: { ...label, detail: held ? `fallback held by the typing guard as ${res.outboxIds?.[0] ?? "a new row"}` : `fallback after native_unconfirmed${res.reason ? `; ${res.reason}` : ""}` },
    nudgeResult: held ? "retained:typing_guard" : !res.ok ? `failed:${why}` : res.verified ? "verified" : "delivered-ack-pending",
    undelivered: !res.ok && !held,
  };
}

/** After the fallback: record its outcome on the qitem and tell an agent sender when it was not delivered. */
export async function recordNativeFallback(deps: NativeSettlementDeps, row: OutboxEntry, res: { ok: boolean; reason?: string; error?: string }, outcome: ReturnType<typeof nativeFallbackOutcome>): Promise<void> {
  if (row.auditPointer) deps.recordNudgeAttempt(row.auditPointer, outcome.nudgeResult);
  if (outcome.undelivered && deps.isAgentSeat(row.senderSession)) {
    await deps.sendNotice(row.senderSession, nativeNoticeText(row,
      `could NOT be delivered: the seat did not take it natively and the tmux fallback failed (${res.reason ?? res.error ?? "unknown"}).`));
  }
}
