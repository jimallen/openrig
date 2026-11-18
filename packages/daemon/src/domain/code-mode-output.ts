// code-mode-output.ts — Claude Code's Code Mode reports each code evaluation's output back to the model as a UserPromptSubmit whose source is
// "poll_event" (prompt `<event kind="repl-eval" ...>`), foreground code included (workspaces-o9o.122 report M10, Claude Code 2.1.327).
// Nobody typed it, so it is not a prompt: it opens no turn, answers or abandons no question, and passes no input point (workspaces-o9o.124).
// Pure. The relay (assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs) carries a twin of the constant; a test holds them equal.

/** The UserPromptSubmit `source` (relayed as the hook's subtype) of Code Mode's code output. */
export const CODE_OUTPUT_PROMPT_SOURCE = "poll_event";

/** Whether a relayed hook is Code Mode's code output dressed as a prompt. */
export function isCodeOutputPrompt(hookEvent: string | null | undefined, subtype: string | null | undefined): boolean {
  return hookEvent === "UserPromptSubmit" && subtype === CODE_OUTPUT_PROMPT_SOURCE;
}
