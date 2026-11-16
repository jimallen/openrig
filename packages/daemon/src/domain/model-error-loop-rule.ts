// OF-286: the numbers of the rule, in a file with no imports so the pane-hosted runner, the daemon's health text and the notice can all read them.
// N failed model requests within W flag a Pi or OMP seat. Measured on every recorded Pi session of this machine (11-10): the 10 bad turns crossed
// 0-4.2 min after their first failure; 2 would flag a pair of transient errors, 4 crossed up to 21 min in, 5 never crossed in 2 of the 10.
export const MODEL_ERROR_LOOP_THRESHOLD = 3;
export const MODEL_ERROR_LOOP_WINDOW_MS = 15 * 60_000;
// T turns in a row that END on a model error (the runtime gave up, nothing answered in between) also flag the seat, however far apart they are.
// verify-sec@cel-identity, 11-13/14: after a WebSocket failure Pi's Codex provider stayed on HTTP and every turn ended on one 400, 14-15 min or
// hours apart, so the window rule never saw 3 in 15 min and the seat sat stuck for 19 hours. One such turn can be a one-off (a request the
// provider refused once); a second in a row, with no answered turn between, means each prompt the seat is given fails. 3 would wait one more
// prompt, which on that seat was up to hours.
export const MODEL_ERROR_FAILED_TURNS_THRESHOLD = 2;
// One turn that ENDS on the provider refusing the request itself (a non-retryable 4xx: 400 Bad Request, 413, 422, an invalid_request_error) also
// flags the seat, at once. verify-sec@eztrack, 2026-11-16: after pi-ai switched to its HTTP fallback every turn ended on `{"detail":"Bad Request"}`
// until a relaunch; Pi does not retry a 400, and the next prompt sends the same history again, so waiting for a second turn only loses a prompt.
// A status code matches only as a whole number (not inside a request id, a byte count or "400ms"). 401/403/404 (credentials, access, a missing
// model) are not a refusal of the history and do not match; 408 and 429 are retried by the runtime.
const PROVIDER_REJECTION_PATTERN = /(?<![a-z0-9.])(?:400|413|422)(?![a-z0-9])|bad.?request|unprocessable.?entity|invalid_request_error/i;
/** True when a model error's text is the provider refusing the request (a non-retryable 4xx), not a cut, a timeout or an overload. */
export function isProviderRejection(errorText: string): boolean {
  return PROVIDER_REJECTION_PATTERN.test(errorText);
}
/** The published flag's `reason` when the turn that raised or last kept it ended on such a refusal. */
export const PROVIDER_REJECTED_REASON = "provider-rejected";
/** That reason in words, with the command that clears it, for `rig ps`, `rig health` and the notice. `seat` is the seat's session (shell-quoted
 *  by the caller) or a placeholder such as `<seat>`. */
export function providerRejectedText(seat: string): string {
  return "the provider is rejecting this conversation's history (a non-retryable 4xx such as 400 Bad Request), so every turn fails the same way; "
    + `a fresh relaunch clears it: rig seat launch ${seat} --fresh --stop --reason "provider rejects the conversation history"`;
}
/** The rules in words, for the notice to the Chief of Staff. */
export const MODEL_ERROR_LOOP_RULE_TEXT = `flagged at ${MODEL_ERROR_LOOP_THRESHOLD} within ${MODEL_ERROR_LOOP_WINDOW_MS / 60_000} minutes, at ${MODEL_ERROR_FAILED_TURNS_THRESHOLD} turns in a row that end on a model error, or at one turn that ends on the provider rejecting the request (a 4xx)`;
