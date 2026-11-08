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
    const taken = this.store.autoAnsweredSince(new Date(now.getTime() - WINDOW_MS).toISOString());
    if (taken.length > 0) {
      const unconfirmed = taken.filter((t) => t.state === "answered_auto").length;
      rows.push(notice(`${taken.length} unanswered question(s) took their (Recommended) answer in the last 24 h (${taken.map((t) => t.sessionName).join(", ")})${unconfirmed > 0 ? `; ${unconfirmed} not yet seen to land` : ""}. Each is on a queue item to human@kernel.`));
    }
    return rows;
  }
}
