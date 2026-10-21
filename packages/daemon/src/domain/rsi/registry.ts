import { join } from "node:path";
import type { HealthObservationSource } from "../health-detectors.js";
import { createA2bSources } from "./a2b-sources.js";
import { BOOTSTRAP_FAILURE_DETECTOR, EventClassHealthSource, STARTUP_FAILURE_DETECTOR } from "./event-class-source.js";
import { OrphanedParkedOwnerJobSource } from "./orphaned-job-source.js";
import { BudgetedRsiSource, type RsiReadBudgetOptions } from "./read-budget.js";
import { SlowOpFileSource } from "./slow-op-file-source.js";
import { TelemetryHealthSource } from "./telemetry-source.js";

/** Where the known-fix anchors live, under the daemon's own state directory. */
export const knownFixesPath = (openrigHome: string): string => join(openrigHome, "rsi", "known-fixes.json");

export interface RsiSourceContext {
  dbPath: string;
  /** OPENRIG_HOME: where the anchors live, AND the instance id of every instance-scoped finding. */
  openrigHome: string;
  /** The slow-operation log D13 reads. Defaults to `<openrigHome>/logs/slow-operations.jsonl`. */
  slowOpLogPath?: string;
  /** False when the daemon runs no retention sweep: D10 is then not registered (a2b-sources.ts). Default true. */
  retentionEnabled?: boolean;
  /** Live `retention.usage_samples_days`, read on every D10 scan. */
  retentionDays?: () => number;
  /** The per-source time budget (read-budget.ts), applied to every source. */
  budget?: RsiReadBudgetOptions;
}

/**
 * THE ONE RSI source list. startup.ts hands this single array to BOTH the health projection and
 * the health-finding wake, so a detector `rig health` serves is always one the wake can attribute
 * (rsi-health-finding-wake.test.ts pins every RSI_DETECTORS id to a source in both).
 * It returns D4, D1-D3, D13 (the slow-op file) and the A2b detectors (D5-D10, D12, D14), each
 * wrapped in the per-source time budget. A stage that adds a detector adds it here.
 * Every database source reads through its own read-only handle, so an in-memory database has none.
 */
export function createRsiSources(ctx: RsiSourceContext): HealthObservationSource[] {
  if (ctx.dbPath === ":memory:") return [];
  const anchors = knownFixesPath(ctx.openrigHome);
  const instanceId = ctx.openrigHome;
  const sources: HealthObservationSource[] = [
    new TelemetryHealthSource({ dbPath: ctx.dbPath }),
    new EventClassHealthSource(STARTUP_FAILURE_DETECTOR, { dbPath: ctx.dbPath, knownFixesPath: anchors, instanceId, budget: ctx.budget }),
    new EventClassHealthSource(BOOTSTRAP_FAILURE_DETECTOR, { dbPath: ctx.dbPath, knownFixesPath: anchors, instanceId, budget: ctx.budget }),
    new OrphanedParkedOwnerJobSource({ dbPath: ctx.dbPath, knownFixesPath: anchors, instanceId, budget: ctx.budget }),
    new SlowOpFileSource({ logPath: ctx.slowOpLogPath ?? join(ctx.openrigHome, "logs", "slow-operations.jsonl"), instanceId }),
    ...createA2bSources({ dbPath: ctx.dbPath, instanceId, retentionEnabled: ctx.retentionEnabled ?? true, retentionDays: ctx.retentionDays }),
  ];
  return sources.map((source) => new BudgetedRsiSource(source, ctx.budget));
}
