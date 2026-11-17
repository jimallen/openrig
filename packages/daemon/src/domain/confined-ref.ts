import nodePath from "node:path";

/**
 * One rule for a reference written relative to a fixed root folder (workspaces-o9o.53): `shipped:` (the running
 * install's specs folder) and `agents-release:` (the deployed agents release) both use it, so the two cannot drift.
 *
 * The target is the relative path joined to the root. It is confined when BOTH its lexical form (so a `..` that climbs
 * out is refused even when nothing exists there) and its real form (so a symlink that points out is refused) lie inside
 * the root's real location. The caller records `typed` (the root as given, joined to the relative path), so a later
 * replay follows a link in the root, such as a release's `current`, to whatever it points at then (OF-99); it checks
 * and reads through `real`. Pure apart from the injected realpath: nothing is created and nothing is read.
 */
export interface ConfineFs {
  realpath?(path: string): string;
}

export type ConfinedRef =
  | { ok: true; /** Where to record it: root as given + relative. */ typed: string; /** Real location of the target. */ real: string; /** Real location of the root. */ root: string }
  | { ok: false; /** Real location of the target (for the refusal message). */ real: string; root: string };

/** The real location of `p`, or `p` itself when it cannot be resolved (missing, or no realpath injected). */
export function realOrSame(fs: ConfineFs, p: string): string {
  try { return fs.realpath ? fs.realpath(p) : p; } catch { return p; }
}

/** Whether `target` is `root` or lies inside it (purely lexical). */
export function isInside(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${nodePath.sep}`) && rel !== ".." && !nodePath.isAbsolute(rel));
}

/** Join `relative` to `typedRoot` and confine it to the root's real location, lexically and really. */
export function confineUnderRoot(typedRoot: string, relative: string, fs: ConfineFs): ConfinedRef {
  const givenRoot = nodePath.resolve(typedRoot);
  const root = realOrSame(fs, givenRoot);
  const lexical = nodePath.resolve(root, relative);
  const real = realOrSame(fs, lexical);
  if (!isInside(root, lexical) || !isInside(root, real)) return { ok: false, real, root };
  return { ok: true, typed: nodePath.resolve(givenRoot, relative), real, root };
}
