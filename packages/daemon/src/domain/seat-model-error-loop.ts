import { formatHeldAge } from "./seat-messaging/held-messages.js";

// OF-286 — a Pi or OMP seat looping on model errors, as the rest of the daemon reads it. The runner decides (adapters/pi-model-error-loop.ts: 3
// failed model requests within 15 minutes, kept when the runtime gives up, cleared by a turn that completes with no model error) and publishes
// the flag in its sidecar; this is the one reading of that flag for `rig ps`, `rig health` and the notice to the Chief of Staff. It decides
// nothing and gates nothing: a looping seat is still working through its retries, so activity, readiness and send gating are unchanged.

/** The flag as the runner publishes it (PiModelErrorLoop in adapters/pi-runner-protocol.ts), restated because a domain file does not import an adapter. */
export interface PublishedModelErrorLoop { count: number; total: number; since: string; lastAt: string; lastError: string; gaveUpAt?: string }

/** The flag as the node inventory serves it: the published fields and the one human line. */
export interface SeatModelErrorLoop extends PublishedModelErrorLoop {
  /** `looping on model errors: 11 failed requests since 04:29Z (52m), last "terminated" 3m ago; the runtime gave up at 05:06Z` */
  line: string;
}

export const MODEL_ERROR_LOOP_DETECTOR = "seat.model-error-loop";

const clock = (iso: string): string => `${iso.slice(11, 16)}Z`;

export function describeModelErrorLoop(loop: PublishedModelErrorLoop, nowMs: number): SeatModelErrorLoop {
  const sinceMs = Date.parse(loop.since);
  const age = Number.isFinite(sinceMs) ? ` (${formatHeldAge(nowMs - sinceMs)})` : "";
  const error = loop.lastError.length > 60 ? `${loop.lastError.slice(0, 59)}…` : loop.lastError;
  const lastMs = Date.parse(loop.lastAt);
  const lastAge = Number.isFinite(lastMs) ? ` ${formatHeldAge(nowMs - lastMs)} ago` : "";
  const line = `looping on model errors: ${loop.total} failed request${loop.total === 1 ? "" : "s"} since ${clock(loop.since)}${age}, last "${error}"${lastAge}`
    + (loop.gaveUpAt ? `; the runtime gave up at ${clock(loop.gaveUpAt)}` : "");
  return { ...loop, line };
}
