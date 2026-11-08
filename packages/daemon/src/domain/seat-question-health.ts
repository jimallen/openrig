import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";
import { formatHeldAge, HELD_NOTICE_AFTER_MS, type HeldMessages } from "./seat-messaging/held-messages.js";
import type { SeatQuestionRepository } from "./seat-question-policy.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * `rig health` for the questions seats put to the human (OF-278). Coverage notices only, read-only: a question waiting for its
 * (Recommended) answer or held with none, how many messages wait behind it, and the answers taken in the last 24 h. The human
 * is told in the kernel because the kernel is where `rig health` is read; the queue item per answer is the other channel.
 */
export class SeatQuestionHealthSource implements HealthObservationSource {
  readonly name = "seat-questions";
  constructor(
    private readonly store: SeatQuestionRepository,
    private readonly held: (sessionName: string, now: Date) => HeldMessages | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const now = this.clock();
    const notice = (reason: string): HealthSourceCoverage => ({ source: this.name, evaluatedAt: now.toISOString(), status: "notice", partial: false, reason });
    const rows: HealthSourceCoverage[] = [];
    for (const q of this.store.openUnanswered()) {
      const ageMs = now.getTime() - Date.parse(q.askedAt);
      if (!(ageMs > HELD_NOTICE_AFTER_MS)) continue;
      const behind = this.held(q.sessionName, now);
      const waiting = behind ? ` ${behind.line.replace(" held,", " message(s) wait behind it,")}.` : "";
      if (q.state === "held") {
        rows.push(notice(`${q.sessionName} has asked you a question for ${formatHeldAge(ageMs)} that cannot take a recommended answer (${q.note ?? "no reason recorded"}). Only you can answer it.${waiting}`));
      } else {
        rows.push(notice(`${q.sessionName} has asked you a question for ${formatHeldAge(ageMs)}; it takes its (Recommended) answer at ${q.dueAt ?? "the end of the wait"} if nobody answers.${waiting}`));
      }
    }
    // Three different things, said apart: an answer the seat reported landed (took), one sent that the seat has not reported (sent), and one the daemon
    // holds back because the event or the note to the human is not written yet (withheld: the hook is retrying, the question is open for the human).
    const taken = this.store.autoAnsweredSince(new Date(now.getTime() - WINDOW_MS).toISOString());
    const names = (list: Array<{ sessionName: string }>) => list.map((t) => t.sessionName).join(", ");
    const confirmed = taken.filter((t) => t.state === "confirmed_auto");
    const sent = taken.filter((t) => t.state === "answered_auto" && t.logged && t.noted);
    const withheld = taken.filter((t) => t.state === "answered_auto" && !(t.logged && t.noted));
    if (confirmed.length > 0) rows.push(notice(`${confirmed.length} unanswered question(s) took their (Recommended) answer in the last 24 h (${names(confirmed)}). Each is on a queue item to human@kernel.`));
    if (sent.length > 0) rows.push(notice(`${sent.length} answer(s) were sent and the seat has not yet reported them landed (${names(sent)}). Each is on a queue item to human@kernel.`));
    if (withheld.length > 0) rows.push(notice(`${withheld.length} answer(s) are withheld, because the event or the note to human@kernel could not be written yet (${names(withheld)}); the question stays open for the human and the hook is retrying.`));
    return rows;
  }
}
