// hc cutover: the sweep that settles outbox rows left `indeterminate` because a send to an hc seat may still land.
//
// A row reaches this state when a send's reply never came (`outcome_unknown`) or the core is still holding the text for a
// person who is typing (`waiting_on_person`). Neither is a failure and neither may be resent: a queued send outlives its
// client, so a resend can put the text in twice. The row carries the pending record (HcDelivery) in its `ack_detail`.
// This sweep reads only: it asks the core whether the evidence has arrived, and moves a row only on evidence.
// What counts as evidence is the table at the top of hc-delivery.ts, and only that; this file does not decide.
//   - a turn started and this send's token is on the screen -> `delivered` (`verified_after_wait`)
//   - the core restarted after the send and the program (declared to show a paste) shows it never took the text
//                                            -> `send_gone`, still `indeterminate` and listed: the queued send did not survive the
//     restart, so sending it again is safe, but NOTHING does it (no queue retry reads a `failed` hc row), so the row stays in the
//     unsettled list and `rig health` names it as lost, for a person to send again by hand and then close
//   - anything else                          -> left as it is, to be looked at again
// Rows nothing can settle by reading (`crash_reconciled`: no pending record; `send_gone`: decided) are not in its list: they stay
// listed for `rig health` and an operator's close, and would otherwise sit at the head of the list and starve newer rows.
// Kept apart from startup so it is tested without a daemon; startup runs it on a timer and once at boot.
import type { HcDeliveryOutcome, HcPendingSend } from "../adapters/hc-delivery.js";
import type { OutboxEntry, OutboxHandler } from "./outbox-handler.js";

export interface HcSweepDeps {
  outbox: Pick<OutboxHandler, "listHcSweepable" | "settleHcUnsettled" | "markHcSendGone">;
  /** HcDelivery.verify: reads the terminal and the core, sends nothing. */
  verify: (pending: HcPendingSend) => Promise<HcDeliveryOutcome>;
  /** QueueRepository.recordNudgeAttempt: a plain update, a no-op for an id that names no qitem. */
  recordNudgeAttempt: (qitemId: string, result: string) => void;
}

export interface HcSweepTally {
  delivered: number;
  /** Proved lost with the core restart and marked `send_gone`: still listed, for a person to send again. */
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
  if (v.pasteEchoes !== undefined && typeof v.pasteEchoes !== "boolean") return null;
  // `preScreen` came later too: absent reads as null, the side that never claims "gone".
  if (v.preScreen !== undefined && v.preScreen !== null && !isString(v.preScreen)) return null;
  // `commandLed` came after the first records were saved: absent reads as true, the side that never settles a row "gone".
  if (v.commandLed !== undefined && typeof v.commandLed !== "boolean") return null;
  if (!(v.token === null || isString(v.token)) || !(v.preStatus === null || typeof v.preStatus === "string") || typeof v.preReported !== "boolean") return null;
  return { version: 1, seat: v.seat, address: v.address, token: v.token, sendStartedAtMs: v.sendStartedAtMs, preTurn: v.preTurn, preStatus: v.preStatus, preReported: v.preReported, commandLed: v.commandLed ?? true, preScreen: typeof v.preScreen === "string" ? v.preScreen : null, pasteEchoes: v.pasteEchoes === true };
}

/** Where the next pass starts in the sweepable list (kept by the caller between passes). */
export interface HcSweepCursor { offset: number }

/**
 * One pass over a window of the sweepable rows. Rows that wait for good (a seat with no status, a busy one: the table in hc-delivery.ts
 * leaves them `waiting`) stay in the list, so a window that always started at the oldest would never reach a newer row once `limit`
 * of them had piled up. With a cursor the window moves on by the rows it left behind, and wraps at the end.
 */
export async function sweepHcUnsettled(deps: HcSweepDeps, limit = 200, cursor?: HcSweepCursor): Promise<HcSweepTally> {
  const tally: HcSweepTally = { delivered: 0, gone: 0, open: 0, unreadable: [] };
  const rows = deps.outbox.listHcSweepable(limit, cursor?.offset ?? 0);
  for (const row of rows) {
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
      if (deps.outbox.markHcSendGone(row.outboxId)) {
        tally.gone++;
        note(deps, row, `failed:${outcome.reason}`);
      }
    } else {
      tally.open++;
    }
  }
  if (cursor) cursor.offset = rows.length < limit ? 0 : cursor.offset + rows.length - tally.delivered - tally.gone;
  return tally;
}

function note(deps: HcSweepDeps, row: OutboxEntry, result: string): void {
  if (row.auditPointer) deps.recordNudgeAttempt(row.auditPointer, result);
}
