import type { DeliveryOutcome } from "./watchdog-policy-engine.js";
import { isUnconfirmedHcSend } from "./outbox-handler.js";

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
 */
export function watchdogDeliveryOutcome(result: WatchdogSendResult, continuityActionCompleted: boolean): DeliveryOutcome {
  if (result.outcome === "retained") return { status: "retained", ...(result.outboxIds ? { outboxIds: result.outboxIds } : {}), continuityActionCompleted };
  if (result.ok) return { status: "ok", continuityActionCompleted };
  if (isUnconfirmedHcSend(result)) return { status: "unconfirmed", ...(result.error !== undefined ? { error: result.error } : {}), continuityActionCompleted };
  return { status: "failed", ...(result.error !== undefined ? { error: result.error } : {}), continuityActionCompleted };
}
