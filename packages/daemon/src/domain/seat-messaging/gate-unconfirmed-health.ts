import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "../health-detectors.js";

/** A finding stays this long after the gate gave up on a part. */
export const GAVE_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the daemon's gate gave up on (OF-243): a long message's part whose text was not on the agent's file after every resend allowed. Read-only. */
export interface GaveUpSource {
  gaveUp(sinceMs: number): Array<{ seat: string; id: string; at: string }>;
}

export class GateUnconfirmedHealthSource implements HealthObservationSource {
  readonly name = "seat-gate-unconfirmed";
  constructor(private readonly source: GaveUpSource, private readonly clock: () => Date = () => new Date()) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    return this.source.gaveUp(GAVE_UP_WINDOW_MS).map((entry) => ({
      source: this.name,
      evaluatedAt: this.clock().toISOString(),
      status: "notice" as const,
      partial: false,
      reason: `The text of ${entry.id} to ${entry.seat} could not be found on the agent's file after it was sent again, so the gate stopped sending it and now takes its record as the arrival (${entry.at}). `
        + "The agent may not have the text. Fix: check that the seat's session file is where the daemon looks (its rollout path); the message can be sent again by its sender.",
    }));
  }
}
