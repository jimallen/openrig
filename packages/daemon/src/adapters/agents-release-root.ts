import os from "node:os";
import nodePath from "node:path";

/**
 * workspaces-o9o.53: the deployed agents release an `agents-release:` agent_ref is relative to, `<home>/.agents-release/current`,
 * home being this daemon's own (os.homedir()). The domain never reads the home itself (hexagonal boundary): every production
 * resolver filesystem is handed this value where it is built (startup.ts, routes/rigspec.ts, routes/bundles.ts).
 */
export function deployedAgentsReleaseRoot(home: string = os.homedir()): string {
  return nodePath.join(home, ".agents-release", "current");
}
