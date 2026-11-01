import { judgeHcVersion } from "../adapters/hc-version.js";
import type { HealthDetectorObservation, HealthObservationSource, HealthSourceCoverage } from "./health-detectors.js";

/**
 * hc cutover (Jim, 2026-11-01): OpenRig accepts an hc core of the tested minor line from the oldest accepted release up, because
 * the Herdr app updates hc by itself. An accepted core that is not the tested version still runs every seat; this source only
 * makes that visible, in `rig health`, as one "notice" row beside the refused-core row (hc-core-refusal-health.ts) and on the same
 * path: coverage only, read-only, no observation. It clears by itself once the watch connects to a core that is the tested version
 * (or when the core is refused, where the refusal row speaks instead).
 */
export class HcUntestedVersionHealthSource implements HealthObservationSource {
  readonly name = "hc-untested-version";
  /** `coreVersion` is the version of the core the watch last connected to (HcCoreWatch's `connected` notice): null while none. */
  constructor(
    private readonly coreVersion: () => string | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  read(): readonly HealthDetectorObservation[] { return []; }

  coverage(): readonly HealthSourceCoverage[] {
    const version = this.coreVersion();
    if (version === null) return [];
    const judged = judgeHcVersion(version);
    if (judged.verdict !== "untested") return [];
    return [{
      source: this.name,
      evaluatedAt: this.clock().toISOString(),
      status: "notice",
      partial: false,
      reason: `Untested hc version: ${judged.warning}. Seats keep running on it. `
        + "Fix: nothing is required; if seats behave oddly after an hc update, put hc back to the tested version (`hc update --help`), "
        + "or ask for this build to be re-tested on the new one.",
    }];
  }
}
