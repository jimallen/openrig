// workspaces-o9o.123: Claude Code's Code Mode for a seat that declares `code_mode: true`.
//
// Measured on Claude Code 2.1.327 (o9o.122): a session started in Code Mode resumes or forks ONLY with this variable set to 1; without
// it claude prints "can't be resumed" and exits 1, leaving the seat's pane at a shell. So every claude launch of such a seat (fresh,
// resume, fork, restore, handover successor) and the resumability probe's throwaway resume set it. A seat that does not declare
// code_mode gets none of this: its launch is byte-identical to before.
//
// The first Code Mode launch in a Claude config home stops at a one-time "turn on Code Mode" picker; Claude keeps the answer in that
// home's .claude.json as the CODE_MODE_ACCEPTED_KEYS, all true. A code_mode seat's launch writes any that is missing, the same way the
// launch already writes hasTrustDialogAccepted and hasCompletedOnboarding.

/** The variable Claude Code reads (code.claude.com/docs/en/code-mode). */
export const CLAUDE_CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";

/** The .claude.json keys that record the one-time Code Mode answer: both are written when it is answered "Yes", and the picker shows
 *  again unless both are true (measured on Claude Code 2.1.327, launch only: either key alone still showed it, the two together did not). */
export const CODE_MODE_ACCEPTED_KEYS: readonly string[] = ["codeModeCaveatsAcceptedV1", "codeModeAutoModeCaveatAcceptedV1"];

/** The launch environment entry for a managed launch (env -i passes only what it is given); {} when the seat does not declare it. */
export function claudeCodeModeEnv(codeMode: boolean | undefined): Record<string, string> {
  return codeMode === true ? { [CLAUDE_CODE_MODE_ENV]: "1" } : {};
}

/** The shell prefix for a typed launch line, with its trailing space; "" when the seat does not declare it. */
export function claudeCodeModePrefix(codeMode: boolean | undefined): string {
  return codeMode === true ? `${CLAUDE_CODE_MODE_ENV}=1 ` : "";
}
