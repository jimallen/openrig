// workspaces-o9o.13: which failed Pi runs the runner recovers on its own, and the words it uses. Read from Pi 1.4.0's Codex provider
// (`@earendil-works/pi-ai` dist/api/openai-codex-responses.js; 1.5.0 has the same logic):
//
//   transport_reset          A WebSocket failure puts the session on HTTP for the rest of the Pi PROCESS (recordWebSocketFailure adds it to
//                            a module-level Set that nothing in normal use clears), and the provider rejected those requests with a 400 that
//                            Pi does not retry (verify-sec@eztrack, verify-sec@cel-identity, 2026-11-13..16). The run that fails that way
//                            carries a `provider_transport_failure` diagnostic, on that turn or on an earlier one of the same process. Only a
//                            new process clears it, and a new process's WebSocket request with the full history is accepted
//                            (workspaces-o9o.22, verify-ops, 2026-11-16). So: restart pi on the same session file, at most once per launch.
//   connection_cap_continue  The provider's 60-minute WebSocket cap hit after the stream started. Pi throws it as a Codex API error, so no
//                            fallback is recorded and the socket is dropped (the next request opens a new one), but it is not retried and
//                            the run ends with the task undone (verify-qa@openrig, 2026-11-16 13:04Z). So: ask the same process to continue.
//
// Both send one continue prompt, labelled as OpenRig's, and neither acts again until a run has answered (Jim, 2026-11-16, via the CoS).
import { isProviderRejection } from "../domain/model-error-loop-rule.js";

/** The one prompt the runner sends after a recovery, word for word (pinned in test/pi-transport-recovery.test.ts). */
export const PI_TRANSPORT_CONTINUE_PROMPT = "[OpenRig] Your last turn ended on a model-provider connection error, not on anything you did. "
  + "OpenRig has reconnected you to the provider. Continue the task you were working on from where it stopped; do not repeat steps that "
  + "already completed.";

/** Pi's diagnostic type for a failed WebSocket attempt (pi-ai createAssistantMessageDiagnostic("provider_transport_failure", ...)). */
const TRANSPORT_FAILURE_DIAGNOSTIC = "provider_transport_failure";

/** Pi 1.4.0's text for the provider's per-connection time cap (CodexApiError code websocket_connection_limit_reached). */
const CONNECTION_CAP_PATTERN = /websocket connection limit reached/i;

export type TransportRecoveryKind = "transport_reset" | "connection_cap_continue";

/** True when a failed assistant message records that its WebSocket attempt failed (and the process has fallen back to HTTP). */
export function hasTransportFailureDiagnostic(diagnostics: unknown): boolean {
  return Array.isArray(diagnostics) && diagnostics.some((d) => d !== null && typeof d === "object" && (d as { type?: unknown }).type === TRANSPORT_FAILURE_DIAGNOSTIC);
}

/** The recovery a run that ended on `errorText` calls for. `transportFailed` says this Pi process has recorded a transport failure. */
export function transportRecoveryFor(errorText: string, transportFailed: boolean): TransportRecoveryKind | null {
  if (transportFailed && isProviderRejection(errorText)) return "transport_reset";
  if (CONNECTION_CAP_PATTERN.test(errorText)) return "connection_cap_continue";
  return null;
}
