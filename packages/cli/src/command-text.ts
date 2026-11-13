import { shellQuote } from "./cross-host-executor.js";

/**
 * OF-288: commands the CLI prints for an operator to paste, written the way the daemon writes them (OF-287 nits).
 *
 * The CLI's copies of the daemon's `shellWord` and `setOff` (packages/daemon/src/domain/active-occupant.ts) and of its
 * module-private `shellPath` (packages/daemon/src/domain/running-name-guard.ts). The CLI reaches daemon code only through the
 * daemon package's built `@openrig/daemon/*` surfaces, and none of the three is on one. The CLI's own `shellQuote` quotes every
 * word (a plain name would print as 'workshop' where the daemon prints workshop), and add.ts's `shellArg` leaves a leading `=`
 * bare, which zsh rewrites to a command's path. packages/cli/test/of288-command-delimiting.test.ts runs each through sh, beside
 * the daemon's copies.
 */

/** A name or id as one word of a pasted command: bare while it is only `A-Z a-z 0-9 . _ @ : -`, else single-quoted. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._@:-]+$/.test(value) ? value : shellQuote(value);
}

/** A file or folder as one word of a pasted command: bare while it is only path characters, else single-quoted; a leading `=` is
 *  quoted (zsh rewrites a bare `=word`). The daemon's `shellPath` (running-name-guard.ts), so a path keeps its slashes unquoted. */
export function shellPath(value: string): string {
  return /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(value) ? value : shellQuote(value);
}

/** A command set off inside a sentence: in single quotes, unless the command holds a single quote (a quoted name does), then in
 *  backticks; a command that also holds a backtick is fenced as Markdown does, with a run of backticks one longer than any inside
 *  it and a space each side. Whatever follows the closing mark is the sentence's, so a paste of the set-off text is the command. */
export function setOff(command: string): string {
  if (!command.includes("'")) return `'${command}'`;
  const longest = Math.max(0, ...(command.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return `\`${command}\``;
  const fence = "`".repeat(longest + 1);
  return `${fence} ${command} ${fence}`;
}
