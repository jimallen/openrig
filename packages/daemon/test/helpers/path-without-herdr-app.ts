import { lstatSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";

/** The program the daemon drives the Herdr desktop app through (`rig terminal open`, and OF-281's renames after a relaunch). */
export const HERDR_APP = "herdr-app";

const holdsHerdrApp = (dir: string): boolean => {
  try { lstatSync(join(dir, HERDR_APP)); return true; } catch { return false; }
};

const inside = (root: string, dir: string): boolean => {
  const rel = relative(root, dir);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * `basePath` with `herdr-app` hidden and every other program still found, in the same order. A scaffold daemon is started with the host's
 * PATH, and on a Mac that runs the Herdr app (stu: `herdr-app` beside `hc` in ~/.local/bin) the daemon would otherwise find the REAL app:
 * `rig terminal open` opens panes in the person's own window, and a relaunch's name restorer (hc-placement-names.ts) renames the space and tab
 * it finds the terminal's address in.
 *
 * A folder that holds `herdr-app` is replaced by a copy made under `shimRoot`: one symlink per entry of the folder, `herdr-app` left out.
 * Dropping the folder instead would drop everything beside it (with `herdr-app` in /usr/bin: node, sh). A folder inside `keepUnder` is the
 * test's own (a fake app a test put on PATH on purpose) and stays. Empty and relative entries are dropped: they resolve against the
 * daemon's working folder, which nobody checked. A folder that cannot be read is dropped, since what it holds is unknown.
 *
 * The copy is taken when this runs: a program installed in the host folder later is not seen. Linux and macOS alike (symlinks, no
 * platform paths).
 */
export function pathWithoutHerdrApp(basePath: string | undefined, shimRoot: string, keepUnder?: string): string {
  const out: string[] = [];
  for (const dir of (basePath ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    if ((keepUnder !== undefined && inside(keepUnder, dir)) || !holdsHerdrApp(dir)) { out.push(dir); continue; }
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    const copy = mkdtempSync(join(shimRoot, "path-"));
    for (const name of entries) if (name !== HERDR_APP) symlinkSync(join(dir, name), join(copy, name));
    out.push(copy);
  }
  return out.join(delimiter);
}

/** The folders on `pathEnv` that hold a `herdr-app`, for a positive control. */
export function herdrAppDirsOn(pathEnv: string | undefined): string[] {
  return (pathEnv ?? "").split(delimiter).filter((dir) => dir !== "" && holdsHerdrApp(dir));
}
