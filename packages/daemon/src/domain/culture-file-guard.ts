import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import { OPENRIG_HOME, readOpenRigEnv } from "../openrig-compat.js";

/**
 * A rig's culture file is injected into every seat's startup context, so "any file the daemon can read"
 * is a way to load ~/.ssh/id_rsa into an agent. A culture file must therefore (1) resolve, symlinks
 * followed, into one of an enumerated set of roots, (2) be a regular file, and (3) be small.
 *
 * Largest culture file in real use, measured 2026-10-14: 19,385 bytes (the jims-team release CULTURE.md);
 * the next is 17,053 (shared-docs/rigs/eztrack). 256 KiB is ~13x the largest and still far below any
 * credential bundle or log a caller could point at.
 */
export const CULTURE_FILE_MAX_BYTES = 256 * 1024;

export type CultureFileCheck =
  | { ok: true; realPath: string; bytes: number; content: string }
  | { ok: false; reason: "not_found" | "outside_roots" | "not_regular_file" | "too_large" | "unreadable" | "changed"; message: string };

/**
 * The roots that hold for every rig: the deployed ~/.agents release (rig-here add-seat passes
 * ~/.agents-release/<sha>/rigs/jims-team/CULTURE.md; any release sha is allowed because a running
 * rig-here may predate `current`), the operator's OpenRig shared docs where rig specs live
 * ($OPENRIG_HOME/shared-docs/rigs), and operator additions in OPENRIG_CULTURE_ROOTS (path-delimited;
 * env is the same configuration plane as OPENRIG_HOME, which already locates the rigs).
 */
export function standingCultureRoots(opts?: { home?: string; openrigHome?: string; extra?: string | undefined }): string[] {
  const home = opts?.home ?? homedir();
  const openrigHome = opts?.openrigHome ?? OPENRIG_HOME;
  const extra = opts && "extra" in opts ? opts.extra : readOpenRigEnv("OPENRIG_CULTURE_ROOTS");
  const roots = [nodePath.join(home, ".agents-release"), nodePath.join(openrigHome, "shared-docs", "rigs")];
  for (const e of (extra ?? "").split(nodePath.delimiter)) {
    if (e.trim() !== "" && nodePath.isAbsolute(e)) roots.push(e);
  }
  return roots;
}

/**
 * The directories a running rig is known to work in, from what the daemon persisted: each seat's cwd,
 * and for a seat under `<run dir>/.workspaces/<seat>` the run dir itself. A caller-supplied rigRoot is
 * deliberately NOT a root here (`--rig-root /` would admit everything). A derived root that is the
 * filesystem root or the home directory is dropped as too broad to be "the rig's folder".
 */
export function rigWorkRoots(nodeCwds: ReadonlyArray<string | null | undefined>, extra: ReadonlyArray<string | undefined> = [], home: string = homedir()): string[] {
  const out = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (!p || !nodePath.isAbsolute(p)) return;
    const resolved = nodePath.resolve(p);
    const parts = resolved.split(nodePath.sep);
    const ws = parts.indexOf(".workspaces");
    const root = ws > 0 ? parts.slice(0, ws).join(nodePath.sep) || nodePath.sep : resolved;
    if (root === nodePath.parse(root).root) return;
    if (canon(root) === canon(home)) return;
    out.add(root);
  };
  for (const c of nodeCwds) add(c);
  for (const c of extra) add(c);
  return [...out];
}

function canon(p: string): string {
  try { return realpathSync(p); } catch { return nodePath.resolve(p); }
}

function within(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + nodePath.sep) && !nodePath.isAbsolute(rel));
}

/**
 * Check and read a culture file. Order: realpath (follows every symlink) -> containment in a realpath'd
 * root -> open ONCE with O_NOFOLLOW|O_NONBLOCK (a swapped-in symlink at the leaf fails; a swapped-in FIFO
 * opens instead of hanging) -> fstat that descriptor (regular file, size) -> read from that same
 * descriptor (never past the cap) -> re-resolve the path and require the same file (device+inode) at the
 * same real path, which catches a parent directory swapped for a symlink during the window.
 * `requested` is only for messages. Nothing here creates anything: a refusal is a pure return.
 */
export function checkCultureFile(
  requested: string,
  resolvedPath: string,
  roots: ReadonlyArray<string>,
  /** Test seams only: run exactly in the race windows (after the containment check / after the read) so the
   *  swap defences can be exercised deterministically. Production callers pass nothing. */
  hooks?: { beforeOpen?: () => void; afterRead?: () => void },
): CultureFileCheck {
  const expected = `inside one of: ${roots.length > 0 ? roots.join(", ") : "(no allowed roots)"} (the rig's own folders, the deployed ~/.agents-release, $OPENRIG_HOME/shared-docs/rigs, or OPENRIG_CULTURE_ROOTS)`;
  let realPath: string;
  try { realPath = realpathSync(resolvedPath); } catch {
    return { ok: false, reason: "not_found", message: `culture file "${requested}" not found (looked at ${resolvedPath}); pass a path relative to the rig root (--rig-root) or an absolute path` };
  }
  const realRoots = roots.map(canon);
  if (!realRoots.some((r) => within(r, realPath))) {
    const via = realPath !== nodePath.join(canon(nodePath.dirname(resolvedPath)), nodePath.basename(resolvedPath)) ?` (resolves through a symlink or alias to ${realPath})` : "";
    return { ok: false, reason: "outside_roots", message: `culture file "${requested}" is refused: ${resolvedPath}${via} is outside every allowed root; a culture file must be ${expected}` };
  }
  let fd: number | undefined;
  try {
    hooks?.beforeOpen?.();
    try { fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch {
      return { ok: false, reason: "unreadable", message: `culture file "${requested}" (${realPath}) is not readable by the daemon (it could not be opened; a symlink swapped in at the last moment is refused too); fix its permissions or pass another path` };
    }
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, reason: "not_regular_file", message: `culture file "${requested}" (${realPath}) is not a regular file (a directory, pipe, device or socket); pass the path of the rig's culture file` };
    }
    if (st.size > CULTURE_FILE_MAX_BYTES) {
      return { ok: false, reason: "too_large", message: `culture file "${requested}" (${realPath}) is ${st.size} bytes, over the ${CULTURE_FILE_MAX_BYTES}-byte limit for a culture file` };
    }
    const buf = Buffer.alloc(CULTURE_FILE_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > CULTURE_FILE_MAX_BYTES) {
        return { ok: false, reason: "too_large", message: `culture file "${requested}" (${realPath}) grew past the ${CULTURE_FILE_MAX_BYTES}-byte limit while being read` };
      }
    }
    hooks?.afterRead?.();
    let again: string;
    let same = false;
    try { again = realpathSync(resolvedPath); const l = lstatSync(again); same = again === realPath && l.ino === st.ino && l.dev === st.dev; } catch { same = false; }
    if (!same) {
      return { ok: false, reason: "changed", message: `culture file "${requested}" changed while it was being checked (${realPath}); refusing, retry once the file is stable` };
    }
    return { ok: true, realPath, bytes: n, content: buf.subarray(0, n).toString("utf-8") };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
