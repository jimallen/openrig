import type { TmuxResult } from "./tmux.js";
import type { BlockedPolicy } from "./hc-input.js";

/**
 * The input calls of the tmux adapter as the callers that answer a dialog make them. On hc, `terminal.keys` and a staged
 * paste carry no blocked refusal of their own, so HcInput makes one by default and a caller whose job is to answer the
 * dialog says so with `blocked: "allow"`: the audited prompt override, the broker's keys and text for a person typing,
 * and the two runtime adapters' startup steps (Codex's update prompt, Claude's trust prompt).
 *
 * `TmuxAdapter` already fits this shape (its methods take fewer parameters and ignore the option), so a call site that
 * holds a TmuxAdapter and says "allow" compiles today, behaves as before on tmux, and is honoured by whatever replaces
 * the adapter at the switch. Nothing here changes tmux.
 */
export interface DialogInput {
  sendText(target: string, text: string, beforeInput?: () => void, options?: { bracketed?: boolean; blocked?: BlockedPolicy }): Promise<TmuxResult>;
  sendKeys(target: string, keys: string[], beforeInput?: () => void, options?: { blocked?: BlockedPolicy }): Promise<TmuxResult>;
}

/** Press keys that answer a dialog: a trust prompt's Enter, an update prompt's option. */
export function answerDialogKeys(input: Pick<DialogInput, "sendKeys">, target: string, keys: string[]): Promise<TmuxResult> {
  return input.sendKeys(target, keys, undefined, { blocked: "allow" });
}
