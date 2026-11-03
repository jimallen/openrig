import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";
import { shellWord } from "../active-occupant.js";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import type { MessageStore } from "./message-store.js";
import type { SeatMessagingPorts } from "./pump-ports.js";

/** A message older than this and still open is stuck. Attempts go on regardless: this says so, it decides nothing. */
export const MESSAGE_STUCK_AFTER_MS = 15 * 60 * 1000;
const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `rig health`: what the pump has delivered, and what it has not. Coverage rows only, read-only (SELECT), like the other notice
 * sources. One row per stuck seat names its oldest message, because a seat is the unit the pump serves. A seat with no gate is named
 * as such, since the pump will not serve it.
 */
export class SeatMessagingHealthSource implements HealthObservationSource {
  readonly name = "seat-messaging";
  constructor(
    private readonly store: MessageStore,
    private readonly ports: SeatMessagingPorts,
    private readonly clock: () => Date = () => new Date(),
    /** The rig id and logical id of a seat's session, for the restart command a stuck hold names; null or absent when they are not known. */
    private readonly seatRef: (seat: string) => { rigId: string; logicalId: string } | null = () => null,
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const now = this.clock();
    const notice = (reason: string): HealthSourceCoverage => ({ source: this.name, evaluatedAt: now.toISOString(), status: "notice", partial: false, reason });
    const rows: HealthSourceCoverage[] = [];
    const since = new Date(now.getTime() - ENDED_WINDOW_MS).toISOString();
    const ended = this.store.endedSince(since);
    if (ended.received > 0 || ended.returned > 0) {
      rows.push(notice(`${ended.received} message(s) received and ${ended.returned} returned to their senders as undeliverable, in the last 24 h.`));
    }
    const unreturned = this.store.unreturnedSince(since);
    if (unreturned.length > 0) {
      const first = unreturned[0]!;
      rows.push(notice(`${unreturned.length} message(s) could not be delivered and have no sender to return them to, in the last 24 h (oldest ${first.id} to ${first.seat}: ${first.reason ?? "no reason recorded"}). Nobody else was told; each text stays on its outbox row.`));
    }
    for (const seat of this.store.openBySeat()) {
      const ageMs = now.getTime() - parseSqliteUtcMs(seat.oldestAcceptedAt);
      // A draft is named at once: a person is the only one who can clear it, and they may not know a message waits behind it.
      if (seat.pauseReason === "draft") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait behind a draft in its composer (oldest ${seat.oldestId}). The draft is never touched; they go the moment it is sent or cleared.`));
        continue;
      }
      // So is a dialog: an agent waiting for an answer takes nothing until a person gives one.
      if (seat.pauseReason === "blocked") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: it is waiting on a dialog (oldest ${seat.oldestId}). Nothing is typed into a dialog; they go when it is answered.`));
        continue;
      }
      // So is a picker or anything else with no composer: it is the same wait as a dialog, and it has no status to say so.
      if (seat.pauseReason === "screen_unreadable") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: its screen shows no composer, such as a picker (oldest ${seat.oldestId}). Nothing is typed there; they go when it is closed.`));
        continue;
      }
      // So is a message nothing can carry yet: it holds its lane, so the rest of that lane waits behind it.
      if (seat.pauseReason === "long_no_socket") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: the oldest (${seat.oldestId}) is too long to paste and the seat has no working socket. It is never pasted; it goes when the socket is back, and its lane waits behind it.`));
        continue;
      }
      // A far seat that lost its gate: only that host can change it, and the row can be cancelled here by id.
      if (seat.pauseReason === "far_not_gated") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: that seat has no gate on its host now (oldest ${seat.oldestId}). They are tried again every so often, and can be cancelled by id.`));
        continue;
      }
      if (seat.pauseReason === "seat_stopped") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: its terminal is not running (oldest ${seat.oldestId}). They go when the seat is back, or return to their senders if it is archived.`));
        continue;
      }
      // So is a seat with no agent: nothing restarts it from here, so "keeps trying" alone would hide that a person or a restore must act.
      if (seat.pauseReason === "agent_absent") {
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: its agent is not running in its terminal (oldest ${seat.oldestId}). Nothing is typed there; they go when the agent is back, or return to their senders if the seat is archived.`));
        continue;
      }
      // The seat's runner has the oldest message and shows it when its turn's tool calls end: nothing is sent again meanwhile (OF-214).
      if (seat.pauseReason === "runner_held" && ageMs > MESSAGE_STUCK_AFTER_MS) {
        const ref = this.seatRef(seat.seat);
        rows.push(notice(`${seat.open} message(s) to ${seat.seat} wait: its runner holds the oldest (${seat.oldestId}, ${Math.floor(ageMs / 60_000)} min) and shows it when the running turn's tool calls end. It is not sent again; the rest wait behind it. It stays held until Pi's current turn ends. If that turn has ended or the seat looks idle, the hold is stuck. Restart the seat's runner on its own conversation, which settles the message against the session file (run these, in order):\n  rig seat stop ${shellWord(seat.seat)} --reason "<why>"\n  rig launch ${ref ? `${shellWord(ref.rigId)} ${shellWord(ref.logicalId)}` : "<rig id> <logical id>"}\nOr end the message, which is then not delivered (run this):\n  rig seat cancel-message ${shellWord(seat.seat)} ${shellWord(seat.oldestId)} --reason "<why>"`));
        continue;
      }
      if (!(ageMs > MESSAGE_STUCK_AFTER_MS)) continue;
      const age = `${seat.open} message(s) to ${seat.seat} not received (oldest ${seat.oldestId}, ${Math.floor(ageMs / 60_000)} min`;
      if (!this.ports.gateFor(seat.seat)) { rows.push(notice(`${age}): the seat declares no gate, so the pump does not serve it.`)); continue; }
      const why = seat.pauseReason ? `, paused: ${seat.pauseReason}` : seat.lastRefusal ? `, last refused: ${seat.lastRefusal}` : "";
      rows.push(notice(`${age}, ${seat.attempts} attempt(s)${why}). The pump keeps trying.`));
    }
    return rows;
  }
}
