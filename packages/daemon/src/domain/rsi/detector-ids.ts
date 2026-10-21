/**
 * Ubiquitous language of the RSI (recursive self-improvement) telemetry context.
 *
 * RSI detector ids live in their own list so they stay separate from the
 * behavioural-health detectors: a policy may disable an RSI detector, but an RSI
 * detector is never a valid HealthDiagnosisService target (health-policy.ts).
 */
export const RSI_ARCHIVED_RIG_LIVE_SESSION = "rsi.archived-rig-live-session" as const;
export const RSI_STARTUP_FAILURE_CLASS = "rsi.startup-failure-class" as const;
export const RSI_BOOTSTRAP_FAILURE_CLASS = "rsi.bootstrap-failure-class" as const;
export const RSI_ORPHANED_PARKED_OWNER_JOB = "rsi.orphaned-parked-owner-job" as const;
export const RSI_DETECTORS = [
  RSI_ARCHIVED_RIG_LIVE_SESSION,
  RSI_STARTUP_FAILURE_CLASS,
  RSI_BOOTSTRAP_FAILURE_CLASS,
  RSI_ORPHANED_PARKED_OWNER_JOB,
] as const;

/**
 * Category and severity of every RSI finding. `info` is load-bearing: routes/attention.ts
 * lists every health record whose severity is not `info` in Jim's Attention view, and RSI
 * findings reach Jim only through the proposal gate. Raising this value puts every RSI
 * finding in Attention.
 */
export const RSI_FINDING_CATEGORY = "process" as const;
export const RSI_FINDING_SEVERITY = "info" as const;
