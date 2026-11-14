import { setOff, shellWord } from "./active-occupant.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";
import type { OutboxEntry, OutboxHandler } from "./outbox-handler.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";

/**
 * hc cutover (QA N7): a send to an hc seat that is not settled is never resent, and the sweep (hc-unsettled-sweep.ts) only moves
 * a row on evidence. A row the evidence cannot settle (the seat ended, the terminal was replaced, a plain terminal after a core
 * restart, a person who never stops typing) would otherwise stay `indeterminate` and silent for good. This source is the
 * escalation: in `rig health`, one "notice" row names the count, the oldest message and its seat once any has waited longer than
 * HC_UNSETTLED_ESCALATE_AFTER_MS. It reads (SELECT only), writes nothing, sends nothing and so can never resend; it clears by
 * itself when the rows settle or an operator closes them (rig seat retire-unsettled-send). Same shape as the human-inbox waiting source.
 * The rows include the claims a crashed daemon left on an hc host (`crash_reconciled`): they carry no record to settle by, so the
 * notice and the operator's close are all there is. The age is the row's own `ts_dispatched`, kept in the database, so a restart
 * does not reset the 15 minutes.
 */
export const HC_UNSETTLED_ESCALATE_AFTER_MS = 15 * 60 * 1000;

/** How many rows one read looks at (the list is oldest first, so the oldest is always in it). */
const HC_UNSETTLED_READ_LIMIT = 500;

export interface HcUnsettledRow { outboxId: string; destination: string; since: string; /** The sweep proved the send lost with a core restart: it is safe to send again. */ lost?: boolean }

export class HcUnsettledHealthSource implements HealthObservationSource {
  readonly name = "hc-unsettled-sends";
  constructor(
    private readonly listUnsettled: () => HcUnsettledRow[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const now = this.clock();
    const nowMs = now.getTime();
    const overdue = this.listUnsettled()
      .map((r) => ({ ...r, sinceMs: parseSqliteUtcMs(r.since) }))
      .filter((r) => Number.isFinite(r.sinceMs) && nowMs - r.sinceMs > HC_UNSETTLED_ESCALATE_AFTER_MS)
      .sort((a, b) => a.sinceMs - b.sinceMs || a.outboxId.localeCompare(b.outboxId));
    if (overdue.length === 0) return [];
    const oldest = overdue[0]!;
    const lost = overdue.filter((r) => r.lost === true);
    const minutes = Math.floor((nowMs - oldest.sinceMs) / 60_000);
    return [{
      source: this.name,
      evaluatedAt: now.toISOString(),
      status: "notice",
      partial: false,
      reason: `${overdue.length} message(s) to hc seats are still not confirmed delivered or lost after more than ${Math.floor(HC_UNSETTLED_ESCALATE_AFTER_MS / 60_000)} min `
        + `(oldest ${oldest.outboxId} to ${oldest.destination}, ${minutes} min). They are not resent: the text may already be there. Check the seat (${setOff(`rig capture ${shellWord(oldest.destination)}`)}) and send again only if it is not, then close the row: ${setOff(`rig seat retire-unsettled-send ${shellWord(oldest.destination)} ${shellWord(oldest.outboxId)} --reason "<what you found>"`)}.`
        + (lost.length > 0 ? ` ${lost.length} of them (${lost.slice(0, 3).map((r) => `${r.outboxId} to ${r.destination}`).join(", ")}${lost.length > 3 ? ", ..." : ""}) were proved lost with a core restart: nothing resends them, so send those again by hand.` : ""),
    }];
  }
}

/** The open rows of an outbox, oldest first. SELECT only. */
export function outboxHcUnsettledRows(outbox: Pick<OutboxHandler, "listHcUnsettled">): () => HcUnsettledRow[] {
  return () => outbox.listHcUnsettled(HC_UNSETTLED_READ_LIMIT).map((e: OutboxEntry) => ({ outboxId: e.outboxId, destination: e.destinationSession, since: e.tsDispatched, lost: e.ackEvidence === "send_gone" }));
}
