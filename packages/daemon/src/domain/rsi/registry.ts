import { join } from "node:path";
import type { HealthObservationSource } from "../health-detectors.js";
import { BOOTSTRAP_FAILURE_DETECTOR, EventClassHealthSource, STARTUP_FAILURE_DETECTOR } from "./event-class-source.js";
import { OrphanedParkedOwnerJobSource } from "./orphaned-job-source.js";
import { TelemetryHealthSource } from "./telemetry-source.js";

/** Where the known-fix anchors live, under the daemon's own state directory. */
export const knownFixesPath = (openrigHome: string): string => join(openrigHome, "rsi", "known-fixes.json");

export interface RsiSourceContext { dbPath: string; openrigHome: string }

/**
 * Every RSI telemetry source the daemon registers. A stage that adds a detector adds one line.
 * All of them read through their own read-only handle, so an in-memory database has none.
 */
export function createRsiSources(ctx: RsiSourceContext): HealthObservationSource[] {
  if (ctx.dbPath === ":memory:") return [];
  const anchors = knownFixesPath(ctx.openrigHome);
  return [
    new TelemetryHealthSource({ dbPath: ctx.dbPath }),
    new EventClassHealthSource(STARTUP_FAILURE_DETECTOR, { dbPath: ctx.dbPath, knownFixesPath: anchors }),
    new EventClassHealthSource(BOOTSTRAP_FAILURE_DETECTOR, { dbPath: ctx.dbPath, knownFixesPath: anchors }),
    new OrphanedParkedOwnerJobSource({ dbPath: ctx.dbPath, knownFixesPath: anchors }),
  ];
}
