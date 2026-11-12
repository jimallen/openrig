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

/** Every command a refusal text sets off, as the text delimits it: each '...' or `...` span that begins with "rig ". A text that sets none
 *  off yields none, so a test that expects a command fails on an undelimited one. Each is followed by its closing mark and then only a
 *  comma, a full stop or the end (checked by `followedOnlyByPunctuation`), so nothing of the sentence is pasted with it. */
export function setOffCommands(text: string): string[] {
  return [...text.matchAll(/'([^']*)'|`([^`]*)`/g)].map((m) => m[1] ?? m[2]!).filter((c) => c.startsWith("rig "));
}

/** True when, after the closing mark of `command` in `text`, only a comma, a full stop, a closing bracket or the end follows at once (never ";" or other text). */
export function closesCleanly(text: string, command: string): boolean {
  const at = text.indexOf(command);
  return at > 0 && /['`]/.test(text[at - 1]!) && /^['`](?:[.,)]|\s|$)/.test(text.slice(at + command.length));
}

/** The words a shell hands to `rig` for a set-off command: "rig up x --existing" is ["up", "x", "--existing"]. */
export function rigWords(command: string): string[] {
  return shellArgv(command.slice("rig ".length));
}
