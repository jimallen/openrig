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

/** Add the guard to a Claude launch's argv. Exactly one `--settings` comes out, whatever went in (more than one going in is a bug in the caller). */
export function withRigBodyGuard(args: string[], scriptPath: string = claudeRigBodyGuardScriptPath()): string[] {
  const at = args.indexOf("--settings");
  if (args.indexOf("--settings", at + 1) !== -1 && at !== -1) throw new Error("a Claude launch carries more than one --settings; they do not merge");
  const group = claudeRigBodyGuardGroup(scriptPath);
  if (at === -1) return [...args, "--settings", JSON.stringify({ hooks: { PreToolUse: [group] } })];
  const settings = JSON.parse(args[at + 1]!) as Record<string, unknown>;
  const hooks = (settings["hooks"] && typeof settings["hooks"] === "object" ? { ...(settings["hooks"] as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks["PreToolUse"]) ? (hooks["PreToolUse"] as HookGroup[]) : [];
  const already = existing.some((g) => g.hooks?.some((h) => h.command === group.hooks[0]!.command));
  hooks["PreToolUse"] = already ? existing : [...existing, group];
  return [...args.slice(0, at + 1), JSON.stringify({ ...settings, hooks }), ...args.slice(at + 2)];
}
