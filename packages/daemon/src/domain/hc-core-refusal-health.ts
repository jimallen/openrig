import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";

// Red-first stub: the source exists and says nothing, which is what `rig health` does today for a refused core.
export class HcCoreRefusalHealthSource implements HealthObservationSource {
  readonly name = "hc-core-refused";
  constructor(private readonly refusal: () => string | null, private readonly clock: () => Date = () => new Date()) { void this.refusal; void this.clock; }
  read(): readonly HealthDetectorObservation[] { return []; }
  coverage(): readonly HealthSourceCoverage[] { return []; }
}
