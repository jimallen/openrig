import { shellQuote } from "./shell-quote.js";

/**
 * Claude Code Remote Control for a seat that declares `remote_control: true` (claude 2.1.296:
 * `--remote-control [name]`). The value is optional in claude's grammar, so the seat's session name is
 * ALWAYS passed explicitly, and in the `--remote-control=<name>` form: a bare flag could swallow the flag
 * that follows it, and a separate-argument name that starts with `-` (legal: pod ids only reject dots)
 * is not taken as the value, so commander reports the name as an unknown option. The `=` form binds the
 * value to the flag whatever it looks like. Every claude launch
 * builder (fresh, resume, fork, restore; managed argv and shell string) takes its text from here so the
 * spelling, quoting and placement cannot drift between them.
 */

/** The argv fragment: ONE argument `["--remote-control=<name>"]`, or nothing when the seat did not declare it. */
export function claudeRemoteControlArgs(enabled: boolean | undefined, sessionName: string): string[] {
  return enabled ? ["--remote-control=" + sessionName.trim()] : [];
}

/** The shell-string fragment, with its leading space: ` '--remote-control=<name>'` (the whole token quoted), or "". */
export function claudeRemoteControlArg(enabled: boolean | undefined, sessionName: string): string {
  return enabled ? ` ${shellQuote(`--remote-control=${sessionName.trim()}`)}` : "";
}

/** A declared flag with no name to pass would be silently dropped; callers refuse the launch instead. */
export function claudeRemoteControlNameMissing(enabled: boolean | undefined, sessionName: string): boolean {
  return enabled === true && sessionName.trim() === "";
}
