import type { HealthObservationSource } from "../health-detectors.js";
import { RETENTION_DEFAULTS } from "../queue-retention.js";
import {
  createCompactionStormSource, createPermissionStallSource, createWatchdogDeliveryFailureSource,
} from "./event-sources.js";
import { RsiReadOnlyConnection, type RsiFindingSource } from "./finding-builder.js";
import { OutboxUnsettledSource } from "./outbox-source.js";
import { RetentionDisabledGrowthSource } from "./retention-growth-source.js";
import { ProjectReportSource } from "./stream-report-source.js";
import { ContextHighWaterSource, ProviderWeeklyWindowSource, RetentionLagSource } from "./usage-sources.js";

export interface A2bSourceOptions {
  dbPath: string;
  instanceId: string;
  /** False when the daemon runs no retention sweep: a surviving old row is then expected, not a defect,
   * and D10 reports a complete zero-count read noted `retention disabled` (it is still registered). */
  retentionEnabled: boolean;
  /** Live `retention.usage_samples_days`; read on every scan. */
  retentionDays?: () => number;
  /** Live `retention.transitions_days` (D15); read on every scan. */
  transitionsRetention?: () => number;
  /** Live `retention.watchdog_days` and `retention.watchdog_keep_per_job` (D15); read on every scan. */
  watchdogRetention?: () => { days: number; keepPerJob: number };
  now?: () => Date;
  rowLimit?: number;
}

/**
 * The A2b part of the RSI registry: D5, D6, D7, D8, D9, D10, D12, D14, D15, one source per detector so
 * a policy that disables one detector skips exactly that read. All share one read-only handle.
 * A helper of `createRsiSources` (registry.ts), the one list the daemon registers; it is not
 * wired anywhere else.
 */
export function createA2bSources(options: A2bSourceOptions): HealthObservationSource[] {
  const deps = { connection: new RsiReadOnlyConnection(options.dbPath), instanceId: options.instanceId, now: options.now, rowLimit: options.rowLimit };
  const sources: RsiFindingSource[] = [
    createCompactionStormSource(deps),
    new ContextHighWaterSource(deps),
    new ProviderWeeklyWindowSource(deps),
    new OutboxUnsettledSource(deps),
    createPermissionStallSource(deps),
    createWatchdogDeliveryFailureSource(deps),
    new ProjectReportSource(deps),
    // D10 always registers (integ21c review N2): with retention off it reads as a complete zero.
    new RetentionLagSource({ ...deps, retentionEnabled: options.retentionEnabled,
      retentionDays: options.retentionDays ?? (() => RETENTION_DEFAULTS.usageSamplesRetentionDays) }),
    // D15 always registers; with the sweep on it reads as a complete zero (OF-81).
    new RetentionDisabledGrowthSource({ ...deps, retentionEnabled: options.retentionEnabled,
      usageSamplesDays: options.retentionDays ?? (() => RETENTION_DEFAULTS.usageSamplesRetentionDays),
      transitionsDays: options.transitionsRetention ?? (() => RETENTION_DEFAULTS.transitionsRetentionDays),
      watchdog: options.watchdogRetention ?? (() => ({ days: RETENTION_DEFAULTS.watchdogRetentionDays, keepPerJob: RETENTION_DEFAULTS.watchdogKeepPerJob })) }),
  ];
  return sources;
}
