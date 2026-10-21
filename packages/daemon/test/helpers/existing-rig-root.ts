import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterAll } from "vitest";

/**
 * A rig root that exists on disk. Preflight refuses a seat whose resolved cwd is not an existing directory (OF-63), and
 * a spec's `cwd: .` resolves to the rig root, so a fixture that only needs the agent files in a mocked file system
 * (agent.yaml under "/project/rigs/x") still needs the directory itself to exist for the seat's launch folder.
 *
 * One scratch folder per importing test file (each file imports this module afresh), removed when that file's tests
 * finish. Import it at the top of the test file, as the removal hook registers at import.
 */
let scratch: string | null = null;

afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

export function existingRigRoot(name: string): string {
  scratch ??= fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), "openrig-test-rig-roots-"));
  const dir = nodePath.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
