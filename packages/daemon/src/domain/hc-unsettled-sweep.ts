// hc cutover: the sweep that settles outbox rows left `indeterminate` because a send to an hc seat may still land.
//
// A row reaches this state when a send's reply never came (`outcome_unknown`) or the core is still holding the text for a
// person who is typing (`waiting_on_person`). Neither is a failure and neither may be resent: a queued send outlives its
// client, so a resend can put the text in twice. The row carries the pending record (HcDelivery) in its `ack_detail`.
// This sweep reads only: it asks the core whether the evidence has arrived, and moves a row only on evidence.
//   - turn advanced or token on the screen   -> `delivered` (`verified_after_wait`)
//   - the core restarted after the send      -> `failed` (`send_failed`, `core_restarted_send_gone`): the queued send did
//     not survive the restart, so the queue's own retry of a `failed:` wake is now safe and is the only way it arrives
//   - anything else                          -> left as it is, to be looked at again
// Kept apart from startup so it is tested without a daemon; startup runs it on a timer and once at boot.
import type { HcDeliveryOutcome, HcPendingSend } from "../adapters/hc-delivery.js";
import type { OutboxEntry, OutboxHandler } from "./outbox-handler.js";

export interface HcSweepDeps {
  outbox: Pick<OutboxHandler, "listHcUnsettled" | "settleHcUnsettled">;
  /** HcDelivery.verify: reads the terminal and the core, sends nothing. */
  verify: (pending: HcPendingSend) => Promise<HcDeliveryOutcome>;
  /** QueueRepository.recordNudgeAttempt: a plain update, a no-op for an id that names no qitem. */
  recordNudgeAttempt: (qitemId: string, result: string) => void;
}

export interface HcSweepTally {
  delivered: number;
  /** Proved gone with the core restart and settled `failed`, so the queue may retry them. */
  gone: number;
  /** Still held by the core, or the evidence cannot settle them yet. Left alone. */
  open: number;
  /** Rows whose saved pending record is not readable; left alone and named. */
  unreadable: string[];
}

/** The pending record in a row's `ack_detail`, or null when it is not one. Validated, not cast: the column is text. */
export function parsePending(detail: string | null | undefined): HcPendingSend | null {
  if (!detail) return null;
  let value: unknown;
  try { value = JSON.parse(detail); } catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (v.version !== 1 || !isString(v.seat) || !isString(v.address) || !isNumber(v.sendStartedAtMs) || !isNumber(v.preTurn)) return null;
  if (!(v.token === null || isString(v.token)) || !(v.preStatus === null || typeof v.preStatus === "string") || typeof v.preReported !== "boolean") return null;
  return { version: 1, seat: v.seat, address: v.address, token: v.token, sendStartedAtMs: v.sendStartedAtMs, preTurn: v.preTurn, preStatus: v.preStatus, preReported: v.preReported };
}

export async function sweepHcUnsettled(deps: HcSweepDeps, limit = 200): Promise<HcSweepTally> {
  const tally: HcSweepTally = { delivered: 0, gone: 0, open: 0, unreadable: [] };
  for (const row of deps.outbox.listHcUnsettled(limit)) {
    const pending = parsePending(row.ackDetail);
    if (!pending) { tally.unreadable.push(row.outboxId); continue; }
    let outcome: HcDeliveryOutcome;
    try {
      outcome = await deps.verify(pending);
    } catch {
      tally.open++;  // a read that threw settles nothing
      continue;
    }
    if (outcome.state === "delivered") {
      if (deps.outbox.settleHcUnsettled(row.outboxId, "delivered", { path: "hc", evidence: "verified_after_wait", detail: outcome.evidence })) {
        tally.delivered++;
        note(deps, row, "verified");
      }
    } else if (outcome.state === "not_delivered" && outcome.reason === "core_restarted_send_gone") {
      if (deps.outbox.settleHcUnsettled(row.outboxId, "failed", { path: "hc", evidence: "send_failed", detail: outcome.reason })) {
        tally.gone++;
        note(deps, row, `failed:${outcome.reason}`);
      }
    } else {
      tally.open++;
    }
  }
  return tally;
}

function note(deps: HcSweepDeps, row: OutboxEntry, result: string): void {
  if (row.auditPointer) deps.recordNudgeAttempt(row.auditPointer, result);
}
