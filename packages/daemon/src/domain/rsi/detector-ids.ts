/**
 * Ubiquitous language of the RSI (recursive self-improvement) telemetry context.
 *
 * RSI detector ids live in their own list so they stay separate from the
 * behavioural-health detectors: a policy may disable an RSI detector, but an RSI
 * detector is never a valid HealthDiagnosisService target (health-policy.ts).
 */
export const RSI_ARCHIVED_RIG_LIVE_SESSION = "rsi.archived-rig-live-session" as const; // D4
// Stage A2a detectors (D1-D3).
export const RSI_STARTUP_FAILURE_CLASS = "rsi.startup-failure-class" as const;
export const RSI_BOOTSTRAP_FAILURE_CLASS = "rsi.bootstrap-failure-class" as const;
export const RSI_ORPHANED_PARKED_OWNER_JOB = "rsi.orphaned-parked-owner-job" as const;
/** D13: a site fills the slow-operation log with spans that are under the slow threshold. */
export const RSI_SLOW_OP_SUBTHRESHOLD_FLOOD = "rsi.slow-op-subthreshold-flood" as const;
// Stage A2b detectors (D5-D10, D12, D14).
export const RSI_COMPACTION_STORM = "rsi.compaction-storm" as const; // D5
export const RSI_CONTEXT_HIGH_WATER = "rsi.context-high-water" as const; // D6
export const RSI_PROVIDER_WEEKLY_WINDOW = "rsi.provider-weekly-window" as const; // D7
export const RSI_OUTBOX_UNSETTLED = "rsi.outbox-unsettled" as const; // D8
export const RSI_PERMISSION_STALL = "rsi.permission-stall" as const; // D9
export const RSI_RETENTION_LAG = "rsi.retention-lag" as const; // D10
export const RSI_WATCHDOG_DELIVERY_FAILURE = "rsi.watchdog-delivery-failure" as const; // D12
export const RSI_PROJECT_REPORT = "rsi.project-report" as const; // D14
export const RSI_A2B_DETECTORS = [
  RSI_COMPACTION_STORM, RSI_CONTEXT_HIGH_WATER, RSI_PROVIDER_WEEKLY_WINDOW, RSI_OUTBOX_UNSETTLED,
  RSI_PERMISSION_STALL, RSI_RETENTION_LAG, RSI_WATCHDOG_DELIVERY_FAILURE, RSI_PROJECT_REPORT,
] as const;
export const RSI_DETECTORS = [
  RSI_ARCHIVED_RIG_LIVE_SESSION,
  RSI_STARTUP_FAILURE_CLASS,
  RSI_BOOTSTRAP_FAILURE_CLASS,
  RSI_ORPHANED_PARKED_OWNER_JOB,
  RSI_SLOW_OP_SUBTHRESHOLD_FLOOD,
  ...RSI_A2B_DETECTORS,
] as const;

/**
 * Category and severity of every RSI finding. `info` is load-bearing: routes/attention.ts
 * lists every health record whose severity is not `info` in Jim's Attention view, and RSI
 * findings reach Jim only through the proposal gate. Raising this value puts every RSI
 * finding in Attention.
 */
export const RSI_FINDING_CATEGORY = "process" as const;
export const RSI_FINDING_SEVERITY = "info" as const;
