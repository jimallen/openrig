// OF-278 — the numbers behind the question auto-answer. No imports: the rig-spec validator reads them.

/** The wait when a rig names none (openrig-66's pick, 2026-11-08; not measured). */
export const DEFAULT_AUTO_ANSWER_MINUTES = 15;
/** The longest wait a rig may name. The seat's hook must outlive it. A fixed bound, not derived per rig: hooks/claude.json is one static
 *  asset for every rig. Measured on Claude Code 2.1.319: a hook with `timeout` 1200 s was honoured at 960 s; nothing longer was run. */
export const MAX_AUTO_ANSWER_MINUTES = 60;
/** Seconds the hook's `timeout` carries: the longest wait plus a margin. hooks/claude.json and question-wait.cjs hold the same number (pinned by test). */
export const QUESTION_HOOK_TIMEOUT_SECONDS = MAX_AUTO_ANSWER_MINUTES * 60 + 300;
/** One daemon reply holds the hook's request open this long, then says `wait`: well under the 300 s a fetch gives a silent response. */
export const QUESTION_POLL_CHUNK_MS = 55_000;

