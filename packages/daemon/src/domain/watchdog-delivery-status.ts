import type Database from "better-sqlite3";
import type { DeliveryOutcome } from "./watchdog-policy-engine.js";
import { isUnconfirmedHcSend } from "./outbox-handler.js";
import type { ObligationCheck } from "./seat-messaging/pump-ports.js";
import { HANDED_TO_PUMP } from "./session-transport.js";

/** The part of a transport send's result a watchdog wake reads. */
export interface WatchdogSendResult {
  ok: boolean;
  outcome?: string;
  reason?: string;
  error?: string;
  outboxIds?: string[];
}

/**
 * A watchdog wake's delivery status from the transport's result. A send to an hc seat the core may still deliver (or whose reply
 * was lost) is `unconfirmed`, never `failed`: the engine leaves a failed wake's receipt unbanked so the next scan sends it again,
 * and the wake's delivery id gives the same token on every attempt, which only finds a copy already on the screen, not one the core
 * is still holding for a person who is typing. A second send would queue the wake twice.
 *
 * A wake the pump took is `ok`: its row is committed, so the pump carries it until the gate records it, and the receipt banks at commit.
 * A later scan of the same occurrence is the same id, so a resend adds no row.
 */
export function watchdogDeliveryOutcome(result: WatchdogSendResult, continuityActionCompleted: boolean): DeliveryOutcome {
  if (result.reason === HANDED_TO_PUMP) return { status: "ok", continuityActionCompleted };
  if (result.outcome === "retained") return { status: "retained", ...(result.outboxIds ? { outboxIds: result.outboxIds } : {}), continuityActionCompleted };
  if (result.ok) return { status: "ok", continuityActionCompleted };
  if (isUnconfirmedHcSend(result)) return { status: "unconfirmed", ...(result.error !== undefined ? { error: result.error } : {}), continuityActionCompleted };
  return { status: "failed", ...(result.error !== undefined ? { error: result.error } : {}), continuityActionCompleted };
}

/**
 * Whether a wake's row is still wanted, read by the pump at every attempt (`guard-watchdog-`, with the job in `auditPointer`). Two rules:
 * a newer occurrence of the job ends an older row that never went out, so a stopped or busy seat does not stack reminders (design S4, M7);
 * and a generation-bound job's wake stops at a target that has handed over, the engine's fire-time gate held at attempt time, which is later (N5).
 * An unknown live generation fails open, as that gate does. Anything else goes on, labelled if the seat changed hands.
 */
export function watchdogWakeObligation(deps: { db: Database.Database; targetGenerationOf: (jobId: string) => string | null; liveGenerationOf: (seat: string) => string | null }): ObligationCheck {
  // By rowid from the row's own place, so a seat stuck on an old row never scans the whole table.
  const newer = deps.db.prepare(`SELECT 1 FROM outbox_entries WHERE rowid > (SELECT rowid FROM outbox_entries WHERE outbox_id = ?) AND audit_pointer = ?
    AND substr(outbox_id, 1, 15) = 'guard-watchdog-' AND message_state IN ('accepted', 'attempting', 'received') LIMIT 1`);
  return (message) => {
    const jobId = message.auditPointer;
    if (jobId === null) return null;
    const target = deps.targetGenerationOf(jobId);
    const live = target === null ? null : deps.liveGenerationOf(message.seat);
    if (live !== null && live !== target) return `watchdog job ${jobId} is bound to generation ${target}, and ${message.seat} is now ${live}`;
    if (message.attempts === 0 && newer.get(message.id, jobId) !== undefined) return `a newer occurrence of watchdog job ${jobId} replaces this one`;
    return null;
  };
}
