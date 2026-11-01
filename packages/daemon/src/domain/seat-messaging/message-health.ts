import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import type { MessageStore } from "./message-store.js";
import type { HeldMessages, SeatMessagingPorts } from "./pump-ports.js";

/** A message older than this and still open is stuck. Attempts go on regardless: this says so, it decides nothing. */
export const MESSAGE_STUCK_AFTER_MS = 15 * 60 * 1000;
const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `rig health`: what the pump has delivered, and what it has not. Coverage rows only, read-only (SELECT), like the other notice
 * sources. One row per stuck seat names its oldest message, because a seat is the unit the pump serves. A seat with no gate is named
 * as such, since the pump will not serve it, and so is a held message that stays held for an occupant that left.
 */
export class SeatMessagingHealthSource implements HealthObservationSource {
  readonly name = "seat-messaging";
  constructor(
    private readonly store: MessageStore,
    private readonly ports: SeatMessagingPorts,
    private readonly held: HeldMessages,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const now = this.clock();
    const notice = (reason: string): HealthSourceCoverage => ({ source: this.name, evaluatedAt: now.toISOString(), status: "notice", partial: false, reason });
    const rows: HealthSourceCoverage[] = [];
    const ended = this.store.endedSince(new Date(now.getTime() - ENDED_WINDOW_MS).toISOString());
    if (ended.received > 0 || ended.undeliverable > 0) {
      rows.push(notice(`${ended.received} message(s) received and ${ended.undeliverable} undeliverable, returned to their senders, in the last 24 h.`));
    }
    for (const seat of this.store.openBySeat()) {
      const ageMs = now.getTime() - parseSqliteUtcMs(seat.oldestAcceptedAt);
      if (!(ageMs > MESSAGE_STUCK_AFTER_MS)) continue;
      const age = `${seat.open} message(s) to ${seat.seat} not received (oldest ${seat.oldestId}, ${Math.floor(ageMs / 60_000)} min`;
      if (!this.ports.gateFor(seat.seat)) { rows.push(notice(`${age}): the seat declares no gate, so the pump does not serve it.`)); continue; }
      const why = seat.pauseReason ? `, paused: ${seat.pauseReason}` : seat.lastRefusal ? `, last refused: ${seat.lastRefusal}` : "";
      rows.push(notice(`${age}, ${seat.attempts} attempt(s)${why}). The pump keeps trying.`));
    }
    const orphaned = this.store.listHeld().filter((row) => this.held.status(row.binding) === "occupant_changed");
    if (orphaned.length > 0) {
      const first = orphaned[0]!;
      rows.push(notice(`${orphaned.length} held message(s) stay held: the guard lifted, but their seat has a new occupant (oldest ${first.id} to ${first.seat}). They are not replayed to it: rig seat retire-held-message ${first.seat} ${first.id} --reason "<why>".`));
    }
    return rows;
  }
}
