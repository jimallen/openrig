// OF-161 / OF-167: a resumed native runtime is believed only if it is still in its pane after it has had time to exit.
// `claude --resume <id>` and `codex resume <id>` are the pane's foreground for the first moments even when the session
// does not exist, so a one-shot read that finds the runtime up says "resumed" for a runtime that is about to print
// "No conversation found" / "No saved session found" and leave. The process tree, not the foreground name, decides.
import type { TmuxAdapter } from "../adapters/tmux.js";
import { assessNativeResumeProbe } from "./native-resume-probe.js";
import { nativePaneOccupancy, type NativeProcessLister, type NativeRuntime } from "./native-process-lineage.js";
import { isShellForeground } from "./shell-classifier.js";

/** How long a resumed runtime is given to exit. Unmeasured: a heuristic window, so typing also re-checks. */
export const RESUME_SETTLE_MS = 2500;

export type PaneForegroundState = "runtime" | "gone" | "unreadable";

/** R5: how long a positive process-tree answer ("the runtime is under the pane") is reused. A burst of guarded sends
 *  then lists processes once, not once per send. Only `present` is ever remembered: an absent or unreadable answer is
 *  re-read every time, so the window can only delay noticing an exit, never invent one. Unmeasured heuristic. */
export const PRESENT_MEMO_TTL_MS = 2000;
/** One startup's remembered positive answer; mutated by paneForegroundState. */
export interface PresentMemo { presentUntil?: number }

type PaneReader = Pick<TmuxAdapter, "getPaneCommand" | "getPanePid">;

/** Is the resumed runtime still in this pane? A non-shell foreground command is taken as running. A shell-named
 *  foreground is not evidence either way (Claude under a launcher shell shows `zsh`; Codex shows `sh`/`bash` above
 *  `node .../codex`), so the process tree decides: `gone` only when the pane's own pid is listed and no process of the
 *  runtime descends from it. Anything unreadable is `unreadable`, which warns but never fails the node. */
export async function paneForegroundState(runtime: NativeRuntime, input: {
  session: string | null | undefined;
  pane?: string | null;
  tmux: PaneReader;
  listProcesses?: NativeProcessLister;
  memo?: PresentMemo;
  now?: () => number;
}): Promise<PaneForegroundState> {
  if (!input.session) return "unreadable";
  try {
    const command = await input.tmux.getPaneCommand(input.session);
    if (!command) return "unreadable";
    if (!isShellForeground(command.trim().toLowerCase())) return "runtime";
    const clock = input.now ?? Date.now;
    if (input.memo?.presentUntil !== undefined && clock() < input.memo.presentUntil) return "runtime";
    const occupancy = await nativePaneOccupancy(runtime, { target: input.pane ?? input.session, tmux: input.tmux, listProcesses: input.listProcesses });
    if (occupancy === "present" && input.memo) input.memo.presentUntil = clock() + PRESENT_MEMO_TTL_MS;
    return occupancy === "present" ? "runtime" : occupancy === "absent" ? "gone" : "unreadable";
  } catch { return "unreadable"; }
}

/** The probe codes that say a resumed runtime is not there: its own message about a missing session, or a bare shell. */
export function isResumeGoneCode(runtime: NativeRuntime, code: string | undefined): boolean {
  return code === "returned_to_shell" || code === (runtime === "codex" ? "no_saved_session" : "no_conversation_found");
}

export type SettledResume =
  | { outcome: "held" }
  | { outcome: "gone"; code: string; missing: boolean; tail: string }
  | { outcome: "attention"; detail: string; evidence: string }
  | { outcome: "unreadable"; reason: string };

/** The settle read for the adapters that poll the pane themselves (legacy, non-pod-aware resume). Waits, reads the pane
 *  once more, and fails the resume only on positive evidence: the probe says the runtime is gone AND the process tree
 *  agrees. An unreadable pane is `unreadable`, never `gone`. */
export async function settleResume(runtime: NativeRuntime, input: {
  session: string;
  tmux: Pick<TmuxAdapter, "getPaneCommand" | "getPanePid" | "capturePaneContent">;
  listProcesses?: NativeProcessLister;
  sleep: (ms: number) => Promise<void>;
  settleMs?: number;
}): Promise<SettledResume> {
  try {
    await input.sleep(input.settleMs ?? RESUME_SETTLE_MS);
    const paneCommand = await input.tmux.getPaneCommand(input.session);
    const paneContent = (await input.tmux.capturePaneContent(input.session, 40)) ?? "";
    const probe = assessNativeResumeProbe({ runtime, paneCommand, paneContent });
    if (probe.status === "attention_required") {
      return { outcome: "attention", detail: probe.detail, evidence: paneContent.split("\n").slice(-12).join("\n") };
    }
    if (!isResumeGoneCode(runtime, probe.code)) return { outcome: "held" };
    // The phrase also appears in a healthy pane whose repainted history mentions it, so it counts only when the
    // foreground is a shell with no process of the runtime beneath it.
    const state = await paneForegroundState(runtime, { session: input.session, tmux: input.tmux, listProcesses: input.listProcesses });
    if (state === "unreadable") return { outcome: "unreadable", reason: `the pane foreground could not be read at the settle check (${probe.code})` };
    if (state === "runtime") return { outcome: "held" };
    const tail = paneContent.split("\n").map((l) => l.trim()).filter(Boolean).slice(-4).join(" | ").slice(0, 400);
    return { outcome: "gone", code: probe.code, missing: probe.code !== "returned_to_shell", tail };
  } catch (err) {
    return { outcome: "unreadable", reason: `the resumed runtime could not be re-checked after launch: ${(err as Error).message}` };
  }
}

type HeldOk = { ok: true; warnings?: string[] };
type Retracted =
  | { ok: false; code: "retry_fresh"; message: string }
  | { ok: false; code: "attention_required"; message: string; evidence?: string };

/** OF-167: what a legacy adapter returns once its poll has said "resumed". The poll's first read is not trusted alone:
 *  after the settle window the runtime must still be there. `retry_fresh` only on positive evidence (the runtime's own
 *  message or a bare shell, AND no process of the runtime under the pane); an unreadable pane keeps the resume and adds
 *  a warning; a provider prompt that appeared meanwhile is attention_required. */
export async function holdResumedPoll<T extends HeldOk>(runtime: NativeRuntime, result: T, input: Parameters<typeof settleResume>[1]): Promise<T | (HeldOk & Omit<T, "ok">) | Retracted> {
  const settled = await settleResume(runtime, input);
  const who = runtime === "codex" ? "Codex" : "Claude";
  switch (settled.outcome) {
    case "held": return result;
    case "unreadable": return { ...result, warnings: [...(result.warnings ?? []), `${input.session}: ${settled.reason}; the resume was not failed`] };
    case "attention": return { ok: false, code: "attention_required", message: settled.detail, evidence: settled.evidence };
    case "gone": return {
      ok: false, code: "retry_fresh",
      message: settled.missing
        ? `${who} resume failed: no ${runtime === "codex" ? "saved session found for the requested token" : "conversation found for the requested session"}`
        : `${who} resume failed: pane returned to shell instead of entering ${who}`,
    };
  }
}
