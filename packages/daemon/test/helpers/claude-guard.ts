// OF-250: what every Claude launch now carries. Built from the SHAPE of the guard group (not from the production builder), so a test that
// pins a launch command is an independent statement of what the command must hold.
import { claudeRigBodyGuardScriptPath } from "../../src/adapters/claude-rig-body-guard.js";
import { shellQuote } from "../../src/adapters/shell-quote.js";

export const GUARD_SCRIPT = claudeRigBodyGuardScriptPath();
export const GUARD_GROUP = { matcher: "Bash", hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(GUARD_SCRIPT)}`, timeout: 5 }] };
/** The --settings JSON of a launch that had no settings of its own. */
export const GUARD_JSON = JSON.stringify({ hooks: { PreToolUse: [GUARD_GROUP] } });
/** Classic (shell text) form, after the posture flag. */
export const GUARD_FLAG = `${shellQuote("--settings")} ${shellQuote(GUARD_JSON)}`;
/** Managed (argv) form. */
export const GUARD_ARGV = ["--settings", GUARD_JSON];
