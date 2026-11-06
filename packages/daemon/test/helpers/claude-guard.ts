// OF-250: what every Claude launch now carries. Built from the SHAPE of the guard group (not from the production builder), so a test that
// pins a launch command is an independent statement of what the command must hold.
import { RIG_BODY_GUARD_WRAPPER, claudeRigBodyGuardScriptPath } from "../../src/adapters/claude-rig-body-guard.js";
import { shellQuote } from "../../src/adapters/shell-quote.js";

export const GUARD_SCRIPT = claudeRigBodyGuardScriptPath();
// OF-253: the hook is an inline `sh -c` wrapper (the script text itself is pinned by the behaviour rows of claude-rig-body-guard-launch.test.ts), then node, the guard script and the watchdog seconds.
export const GUARD_GROUP = { matcher: "Bash", hooks: [{ type: "command", command: `/bin/sh -c ${shellQuote(RIG_BODY_GUARD_WRAPPER)} sh ${shellQuote(process.execPath)} ${shellQuote(GUARD_SCRIPT)} 3`, timeout: 5 }] };
/** The --settings JSON of a launch that had no settings of its own. */
export const GUARD_JSON = JSON.stringify({ hooks: { PreToolUse: [GUARD_GROUP] } });
/** Classic (shell text) form, after the posture flag. */
export const GUARD_FLAG = `${shellQuote("--settings")} ${shellQuote(GUARD_JSON)}`;
/** Managed (argv) form. */
export const GUARD_ARGV = ["--settings", GUARD_JSON];
