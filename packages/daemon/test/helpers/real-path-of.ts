import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The path with every symlink in its existing part resolved, and the part that does not exist yet kept as written.
 *
 * Why tests need it. On macOS `os.tmpdir()` is `/var/folders/...`, a symlink to `/private/var/folders/...`, and the hermetic setup
 * (test/hermetic-env.setup.ts) makes the fixture home and the short state dir under the first spelling, then hands out the second
 * through TMPDIR. A test that asks "is this path inside the temp folder" with `startsWith(tmpdir())` is then true on Linux and
 * false on macOS for the same directory. Resolve both sides with this before comparing; a path that is not yet created (a core's
 * socket, a state dir) resolves through its deepest existing parent.
 */
export function realPathOf(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}
