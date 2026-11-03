// OF-213: a pane-hosted Pi runner names its seat in the terminal's title and on its first pane line.
//
// Why. A Claude seat's terminal title is its session name (`build-arch@eztrack`), so the Herdr pane header and the terminal
// listing say which seat is which. A Pi seat's program is the runner, and the runner set no title: `hc get` showed title "" and
// the pane header read only "pi-runner <cwd>" (measured live by openrig-8f on t37 verify-qa@eztrack).
//
// What hc reads. herdr-core takes `Terminal.title` from OSC 0 and OSC 2 in the program's output, and from nothing else: measured on
// a private core (hc 0.1.17, runner-title.real.test.ts), OSC 0 and OSC 2 each set it, OSC 1 and an hc label `title=` do not, and
// the last title written wins. The write goes through the runner's own status writer (runner-pane-guard.ts): the guard removes
// every escape sequence from text the runner prints, so a title can only be set by this module, from the session name the runner
// was launched with, never from model output or a pasted message.
//
// Only node builtins, so a compiled runner entry stays runnable with no daemon dependencies.

/** Longest title written. A session name is far shorter; the bound keeps a malformed one from filling the record. */
export const MAX_RUNNER_TITLE_CHARS = 128;

/** The OSC 2 record that sets the terminal's title: ESC ] 2 ; <title> ESC \. A title with a control byte, a C1 byte, DEL, or
 *  no characters at all is refused, because a terminal parser would end or reinterpret the record at it. */
export function hcTitleRecord(title: string): string {
  if (title.length === 0 || title.length > MAX_RUNNER_TITLE_CHARS || /[\u0000-\u001f\u007f-\u009f]/.test(title)) {
    throw new Error("hc terminal title must be 1-128 printable characters");
  }
  return `\u001b]2;${title}\u001b\\`;
}

/** Writes the title to a terminal herdr-core hosts (it sets HC_TERMINAL_ID); absent elsewhere. Called once, at runner start: a
 *  restart is a new runner process, so it writes again. */
export type RunnerHcTitleSink = () => void;

export function createRunnerHcTitleSink(
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
  title: string,
): RunnerHcTitleSink | undefined {
  const terminal = env.HC_TERMINAL_ID;
  if (typeof terminal !== "string" || terminal === "") return undefined;
  return () => {
    try { write(hcTitleRecord(title)); } catch { /* a refused title or a closed pane must not stop the runner */ }
  };
}

/** The one-line banner the runner prints first: `── verify-qa@eztrack · pi · openai-codex/gpt-6-luna:medium ──`. It names the seat
 *  and the runtime on the pane itself, where the title (a header, not pane text) is not seen. It carries none of the runner's
 *  protocol markers (`[pi-runner] READY`, `ERROR`, `EXITED`, `[openrig-msg ...]`) that the daemon looks for on the screen. */
export function seatBannerLine(parts: { sessionName: string; runtime: string; model?: string }): string {
  const fields = [parts.sessionName, parts.runtime];
  if (parts.model) fields.push(parts.model);
  return `── ${fields.join(" · ")} ──`;
}
