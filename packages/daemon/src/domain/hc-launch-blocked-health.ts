import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";

/**
 * hc cutover (W42, 2026-11-01): a launch refused because the hc core has no holder (its program file was replaced while it ran) used to
 * show only as `hc refused <seat>: unavailable` on each seat. This source makes it visible in `rig health` with the cause and the fix.
 * Same shape as the core-refusal notice (hc-core-refusal-health.ts): coverage only, read-only, no observation. It clears by itself on
 * the next launch that succeeds (HcClient.launchBlockedBecause), which is what the operator's restart of the hc core followed by a launch gives.
 */
export class HcLaunchBlockedHealthSource implements HealthObservationSource {
  readonly name = "hc-launch-blocked";
  constructor(
    private readonly blocked: () => string | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const why = this.blocked();
    if (why === null) return [];
    return [{ source: this.name, evaluatedAt: this.clock().toISOString(), status: "notice", partial: false, reason: `The last seat launch on the hc core was refused. ${why}` }];
  }
}
