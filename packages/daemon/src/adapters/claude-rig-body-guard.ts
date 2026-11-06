// OF-250: the rig-body guard (OF-249) as part of the ONE `--settings` JSON a Claude launch carries.
//
// Measured on Claude Code 2.1.318 (OF-250): a single `--settings` adds its hooks to the user's and the project's; TWO `--settings` flags do NOT merge,
// the last wins and the other is dropped (the guard or the team/kernel permission hook would silently vanish). So the guard is merged INTO the launch's
// one `--settings` JSON as a second PreToolUse group, or is the only content of a `--settings` the launch did not have. Never a second flag, and
// nothing is written to disk (no config file, no state file): it is a launch argument, so the "OpenRig authors no config-file policy" rip-out is untouched.
import nodePath from "node:path";
import { existsSync, statSync } from "node:fs";
import { shellQuote } from "./shell-quote.js";

/** The hook script the settings point at: the plugin asset shipped with this daemon. src/adapters and dist/adapters are the same depth. */
export function claudeRigBodyGuardScriptPath(adaptersDir: string = import.meta.dirname): string {
  return nodePath.resolve(adaptersDir, "../../assets/plugins/openrig-core/hooks/scripts/rig-body-guard.cjs");
}

/** Why a Claude launch must not happen, or null. Checked before anything is typed into a pane. */
export function claudeRigBodyGuardRefusal(scriptPath: string = claudeRigBodyGuardScriptPath(), exists: (file: string) => boolean = (f) => existsSync(f) && statSync(f).isFile()): string | null {
  return exists(scriptPath) ? null : `the rig-body guard hook script is missing (${scriptPath}); not launching Claude without it`;
}

interface HookGroup { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }

/** The guard's PreToolUse group: a blocking command hook on Bash. The interpreter is the daemon's own node (process.execPath, quoted), like the team hook:
 *  a bare `node` fails open on a seat whose PATH has no node (OF-250 review F-1, measured on Claude 2.1.318). */
export function claudeRigBodyGuardGroup(scriptPath: string): { matcher: string; hooks: Array<{ type: string; command: string; timeout: number }> } {
  return { matcher: "Bash", hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`, timeout: 5 }] };
}

const SETTINGS_FLAG = "--settings";
const SETTINGS_EQ = "--settings=";

/** Add the guard to a Claude launch's argv. Exactly one `--settings` (`--settings <json>` or `--settings=<json>`, the form it came in) comes out, whatever went in.
 *  Fail closed (OF-252): a launch is refused, by a thrown Error, rather than started without the guard or with a caller's hook silently dropped, when
 *  more than one settings flag goes in (they do not merge), the flag has no value, the value is not a JSON object (a file path is not read here), `hooks` is not an
 *  object or `hooks.PreToolUse` is not an array. */
export function withRigBodyGuard(args: string[], scriptPath: string = claudeRigBodyGuardScriptPath()): string[] {
  const flagAt: number[] = [];
  args.forEach((a, i) => { if (a === SETTINGS_FLAG || a.startsWith(SETTINGS_EQ)) flagAt.push(i); });
  if (flagAt.length > 1) throw new Error("a Claude launch carries more than one --settings; they do not merge");
  const group = claudeRigBodyGuardGroup(scriptPath);
  if (flagAt.length === 0) return [...args, SETTINGS_FLAG, JSON.stringify({ hooks: { PreToolUse: [group] } })];
  const at = flagAt[0]!;
  const equalsForm = args[at]!.startsWith(SETTINGS_EQ);
  const raw = equalsForm ? args[at]!.slice(SETTINGS_EQ.length) : args[at + 1];
  if (raw === undefined) throw new Error("the --settings of a Claude launch has no value; not launching Claude without the rig-body guard");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`the --settings value of a Claude launch is not valid JSON (${error instanceof Error ? error.message : String(error)}); a file path is not supported; not launching Claude without the rig-body guard`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the --settings value of a Claude launch is not a JSON object; not launching Claude without the rig-body guard");
  const settings = parsed as Record<string, unknown>;
  const rawHooks = settings["hooks"];
  if (rawHooks !== undefined && (rawHooks === null || typeof rawHooks !== "object" || Array.isArray(rawHooks))) throw new Error("the --settings hooks of a Claude launch is not an object; not replacing it, not launching Claude without the rig-body guard");
  const hooks = { ...((rawHooks ?? {}) as Record<string, unknown>) };
  const rawPre = hooks["PreToolUse"];
  if (rawPre !== undefined && !Array.isArray(rawPre)) throw new Error("the --settings hooks.PreToolUse of a Claude launch is not an array; not replacing it, not launching Claude without the rig-body guard");
  const existing = (rawPre ?? []) as HookGroup[];
  const already = existing.some((g) => !!g && typeof g === "object" && Array.isArray(g.hooks) && g.hooks.some((h) => !!h && h.command === group.hooks[0]!.command));
  hooks["PreToolUse"] = already ? existing : [...existing, group];
  const json = JSON.stringify({ ...settings, hooks });
  return equalsForm ? [...args.slice(0, at), `${SETTINGS_EQ}${json}`, ...args.slice(at + 1)] : [...args.slice(0, at + 1), json, ...args.slice(at + 2)];
}
