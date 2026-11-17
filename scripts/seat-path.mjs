// workspaces-o9o.77 — a seat's PATH head, kept out of every test run.
//
// A seat's processes start their PATH with two OpenRig folders (seat-launch-environment.ts pathHead): the seat's own `rig`,
// <OPENRIG_HOME>/run/seat-bin/<hash>, and the git worktree shim, <OPENRIG_HOME>/rig-bin. A suite run from such a seat found that
// shim's `git` first, and it redirected the fixtures' `git worktree add` into <repo>/.rig-worktrees (verify-qa2, 2026-11-17: 83
// worktree-sweep tests and 2 daemon tests failed). A run from a seat must equal one from a plain shell, so the test setups and
// helpers drop both folders, wherever their OPENRIG_HOME is. This is the one rule; the vitest setup, the daemon test helpers and
// the scripts tests' preload all use it. Plain JS so `node --test` and TypeScript import the same file.
import path from "node:path";

/** Whether `dir` is one of a seat's two PATH-head folders: a `rig-bin` folder, or a folder directly inside a `seat-bin` folder. */
export function isSeatPathEntry(dir) {
  return path.basename(dir) === "rig-bin" || path.basename(path.dirname(dir)) === "seat-bin";
}

/** `value` (a PATH) without a seat's PATH-head folders; every other entry is kept, in order. Undefined stays undefined. */
export function withoutSeatPath(value) {
  if (value === undefined) return undefined;
  return value.split(path.delimiter).filter((dir) => dir === "" || !isSeatPathEntry(dir)).join(path.delimiter);
}
