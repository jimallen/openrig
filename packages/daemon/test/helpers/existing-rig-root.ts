import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/**
 * A rig root that exists on disk. Preflight refuses a seat whose resolved cwd is not an existing directory (OF-63), and
 * a spec's `cwd: .` resolves to the rig root, so a fixture that only needs the agent files in a mocked file system
 * (agent.yaml under "/project/rigs/x") still needs the directory itself to exist for the seat's launch folder.
 * One directory per name per process, under the real temp dir.
 */
export function existingRigRoot(name: string): string {
  const dir = nodePath.join(fs.realpathSync(os.tmpdir()), `openrig-test-rig-roots-${process.pid}`, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
