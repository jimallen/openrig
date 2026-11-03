// OF-200 review F3. hc cannot read a terminal's launch env back, and a label may not hold a credential, so a seat's terminal that is respawned after the daemon
// restarted (the daemon's record of what it was made with is gone) has only the identity names its launch wrote as labels. Those are not the seat's whole env:
// the activity-hook token (the seat's reports to the daemon authenticate with it) and the git worktree shim at the head of PATH are set by the daemon at launch
// and lived in the process that has since ended. The daemon holds both again from its own start (the token is persisted across restarts, the shim directory is
// on disk), so the same composition NodeLauncher does at launch is rebuilt here, and the identity the labels kept wins over it.
import { withWorktreeShimPath } from "./git-worktree-shim.js";
import path from "node:path";
import os from "node:os";

export interface SeatRestartEnvSources {
  /** The env every seat is launched with (startup.ts `launchSessionEnv`). */
  sessionEnv: Readonly<Record<string, string | undefined>>;
  /** Extra env per runtime (startup.ts `runtimeSessionEnv`). */
  runtimeSessionEnv: Readonly<Record<string, Readonly<Record<string, string | undefined>>>>;
}

/** The env a seat's respawn is given when only its identity labels survive: the launch composition of NodeLauncher, then the labels' names on top. */
export function seatRestartEnv(identity: Readonly<Record<string, string>>, sources: SeatRestartEnvSources): Record<string, string> {
  const env: Record<string, string> = {};
  const runtime = identity["OPENRIG_RUNTIME"];
  for (const layer of [sources.sessionEnv, runtime ? sources.runtimeSessionEnv[runtime] : undefined]) {
    for (const [key, value] of Object.entries(layer ?? {})) if (value !== undefined && value.trim() !== "") env[key] = value;
  }
  // The same home NodeLauncher gives the shim: the seat's own OPENRIG_HOME, else the daemon's, else the default.
  const home = sources.sessionEnv["OPENRIG_HOME"] ?? process.env["OPENRIG_HOME"] ?? path.join(os.homedir(), ".openrig");
  withWorktreeShimPath(env, home);
  return { ...env, ...identity };
}
