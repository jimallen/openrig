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
/** Both rules in words, for the notice to the Chief of Staff. */
export const MODEL_ERROR_LOOP_RULE_TEXT = `flagged at ${MODEL_ERROR_LOOP_THRESHOLD} within ${MODEL_ERROR_LOOP_WINDOW_MS / 60_000} minutes, or at ${MODEL_ERROR_FAILED_TURNS_THRESHOLD} turns in a row that end on a model error`;
