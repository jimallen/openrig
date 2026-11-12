import { execFileSync } from "node:child_process";

/** The words a POSIX shell hands to a command for this text: the text is run through `sh` as the arguments of printf, so a
 *  command printed for an operator to paste is read exactly as their shell would read it. Nothing in the text is executed. */
export function shellArgv(commandText: string): string[] {
  const out = execFileSync("sh", ["-c", `printf '%s\\0' ${commandText}`], { encoding: "utf8" });
  return out.split("\0").slice(0, -1);
}

/** The command a line of advice tells the operator to run, from `start` (e.g. "rig up <bundle>") through `end` (e.g. " --on-existing fresh"). */
export function commandIn(line: string, start: string, end: string): string {
  const from = line.indexOf(start);
  if (from < 0) throw new Error(`no "${start}" in: ${line}`);
  const to = line.indexOf(end, from);
  if (to < 0) throw new Error(`no "${end}" after "${start}" in: ${line}`);
  return line.slice(from, to + end.length);
}

/** Every command a refusal text sets off, as the text delimits it: each '...' or `...` span, or a Markdown fence (a run of two or more
 *  backticks, a space, the command, a space, the same run) that `setOff` uses for a command holding a backtick, that begins with "rig ".
 *  A text that sets none off yields none, so a test that expects a command fails on an undelimited one. Whether only punctuation follows
 *  the closing mark is `closesCleanly`'s check. */
export function setOffCommands(text: string): string[] {
  return [...text.matchAll(/(``+) (.+?) \1(?!`)|'([^']*)'|`([^`]*)`/g)].map((m) => m[2] ?? m[3] ?? m[4]!).filter((c) => c.startsWith("rig "));
}

/** True when `command` sits right inside its marks (a quote, a backtick or a fence's space) and, after its closing mark, a comma, a full
 *  stop, a closing bracket, whitespace or the end follows at once. Whitespace may be followed by more of the sentence (so "'rig ps' or
 *  'rig send'" passes); what this rules out is the mark running straight into ";" or other text. */
export function closesCleanly(text: string, command: string): boolean {
  const at = text.indexOf(command);
  if (at <= 0) return false;
  const before = text.slice(0, at), after = text.slice(at + command.length);
  const opened = /['`]$/.test(before) || /``+ $/.test(before);
  return opened && /^(?: ``+|['`])(?:[.,)]|\s|$)/.test(after);
}

/** The words a shell hands to `rig` for a set-off command: "rig up x --existing" is ["up", "x", "--existing"]. */
export function rigWords(command: string): string[] {
  return shellArgv(command.slice("rig ".length));
}
