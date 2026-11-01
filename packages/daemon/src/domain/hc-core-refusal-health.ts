import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";

/**
 * hc cutover (Jim, 2026-11-01): when the core watch refuses a core (a version outside the accepted band or a generation this build was not written for, or
 * another core than the one the daemon first saw), the daemon's own client fails every later call as an unavailable core
 * (HcClient.refuseCore) and nothing retries, so until the daemon restarts every seat reads "unavailable". That is fail-closed and
 * stays so; this source only makes it visible. In `rig health` one "notice" row says the core is refused, why, and the fix.
 * Same shape and path as the unsettled-send notice (hc-unsettled-health.ts): coverage only, read-only, no observation, and it
 * clears by itself, which for a refusal means the next daemon start, since a refusal is held for the life of the client.
 */
export class HcCoreRefusalHealthSource implements HealthObservationSource {
  readonly name = "hc-core-refused";
  /** `refusal` is the daemon's client's `refusedBecause`: null while no core has been refused. */
  constructor(
    private readonly refusal: () => string | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const why = this.refusal();
    if (why === null) return [];
    return [{
      source: this.name,
      evaluatedAt: this.clock().toISOString(),
      status: "notice",
      partial: false,
      reason: `The hc core is refused, so every call to an hc seat fails as an unavailable core until the daemon restarts (a seat is not gone, and nothing is ended): ${why}. `
        + "Fix: if the core was changed on purpose, change the accepted hc versions (hc-version.ts) only after the new version is tested, then restart the daemon (`rig daemon stop && rig daemon start`); "
        + "otherwise put an accepted hc core back and restart the daemon. Seats in the core keep running meanwhile.",
    }];
  }
}
