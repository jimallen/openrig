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
