// OF-225(a). The trusted run root's bookkeeping, in a LEAF module: node builtins only. The daemon suite's setup file imports this
// (not trusted-scaffold.ts), because a setup file's imports are loaded before a test file's `vi.mock`, and a transitive import of
// hermetic-env.js there would hand a file that mocks `node:fs` and then imports hermetic-env.js the cached, unmocked module
// (hermetic-env-setup-failure.test.ts: "expected [Function] to throw an error"). Keep this file free of every other helper.
import { lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The name of the one folder an uncontained run makes for its scaffolds (see `defaultTrustedRunRoot`): `<prefix><pid>-XXXXXX`. The
 * creating process's pid is in the name so that `sweepAbandonedRunRoots` can tell a folder whose run is gone from one still in use.
 * Folders made before the pid was added are `<prefix>XXXXXX` and are never matched by the sweep (see `RUN_ROOT_NAME`).
 */
export const TRUSTED_RUN_ROOT_PREFIX = ".openrig-test-run-";

export const runRoots = new Map<string, string>();

/**
 * Remove every run root this process made. The removal used to hang only on `process.once("exit")`, which does NOT fire in a vitest
 * worker (measured on Sparky, vitest 3.2.4, one passing test that made a root: the forks worker got SIGTERM and ended with no
 * 'exit' event, and the threads worker ended with none either), so every run left one empty root in the account's home. The daemon
 * suite's setup file (`trusted-run-root.setup.ts`) calls this from an `afterAll`, which runs in the worker, like the fixture-home
 * removal in test/hermetic-env.setup.ts (OF-80). Safe to call twice; the root is made again on next use.
 */
export function removeTrustedRunRoots(): void {
  for (const [home, root] of [...runRoots]) {
    runRoots.delete(home);
    rmSync(root, { recursive: true, force: true });
  }
}

/** `<prefix><pid>-XXXXXX` exactly (mkdtemp's six characters are [A-Za-z0-9]); anything else, the old `<prefix>XXXXXX` included, is not ours to sweep. */
const RUN_ROOT_NAME = new RegExp(`^${TRUSTED_RUN_ROOT_PREFIX.replace(/\./g, "\\.")}(\\d+)-[A-Za-z0-9]{6}$`);

const pidIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } // EPERM: it exists, it is not ours: alive
};

/**
 * A SIGKILLed run (or a worker killed before its `afterAll`) cannot remove its root, so the next run sweeps what it left. The sweep
 * removes a folder only when ALL hold: its name is exactly `<prefix><pid>-XXXXXX`; it is a real directory (lstat, not a link) owned by
 * this user; the pid in the name is not a live process; and it is EMPTY. The removal is `rmdir`, which refuses a non-empty folder, so
 * a root that still holds a scaffold is never touched. A root whose creator's pid was reused by a live process is kept (the safe
 * direction). Returns the names removed. `isAlive` is a seam for the test.
 */
export function sweepAbandonedRunRoots(home: string, isAlive: (pid: number) => boolean = pidIsAlive): string[] {
  const removed: string[] = [];
  const uid = process.getuid?.();
  for (const name of readdirSync(home)) {
    const match = RUN_ROOT_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const path = join(home, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      rmdirSync(path); // never recursive: a non-empty root throws ENOTEMPTY and stays
      removed.push(name);
    } catch { /* gone already, or not empty, or not ours: leave it */ }
  }
  return removed;
}

