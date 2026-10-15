import { realpathSync } from "node:fs";
import nodePath from "node:path";
import { checkGuardedFile, type GuardedFileCheck, type GuardedFileKind } from "./culture-file-guard.js";

/**
 * TRUST BOUNDARY (read this before changing anything here). Same decision as culture-file-guard.ts and
 * agent-ref-guard.ts.
 *
 * The caller of `/api/bundles/create` is TRUSTED, so there is no folder allowlist and none is added here.
 * These checks guard against ACCIDENTS and SWAPS while bundle create copies files out of a folder the author
 * pointed it at (a persona folder, a docs or startup file, a skill/plugin/context-pack/agent-image tree):
 * a symlink that leads out of the folder, a FIFO or device that would stall the daemon's synchronous read, a
 * runaway file, a hard link that aliases some other file.
 *
 * Every file that goes into a bundle from such a folder is read through checkGuardedFile (one descriptor opened
 * with O_NOFOLLOW|O_NONBLOCK: a regular file, one link, at most VENDORED_FILE_MAX_BYTES), and its real path
 * must be inside the folder's real root. A symlink that stays inside the folder is followed and bundled as the
 * regular file it points to (the same as a docs/startup file, see collectRigFile); one that leaves it is REFUSED,
 * not skipped, exactly as a culture file or a docs file that resolves outside the rig root is refused, so a
 * bundle never silently lacks a file the author expected in it. The refusal is a caller-correctable 400.
 * Each folder's files together may not exceed VENDORED_TREE_MAX_BYTES.
 *
 * RESIDUAL: a CONTENT swap of a regular, single-link, in-root, under-cap file between the check and the copy
 * still goes through, and trees copied with cpSync (author-bundle skills/plugins) are re-read by cpSync after
 * the guarded pass; a FIFO swapped in at that moment makes cpSync throw, it does not hang, but its bytes are not
 * re-capped. A legacy tree with no guard seam (an in-memory test filesystem) is read with a plain read.
 *
 * Caps, measured 2026-10-15 (read-only): the persona folders of the deployed release (8 folders) and OpenRig's
 * built-ins (19 folders), the jims-team and demo folders: the largest single file is 61,540 bytes (a built-in
 * migration script) and the largest folder is 457,700 bytes in 56 files (the built-in `shared` persona); the
 * release's largest file is 34,570 bytes. The largest docs/startup file declared by any of the 11 rig specs is
 * 6,586 bytes. 1 MiB per file is ~17x the largest file and 8 MiB per folder is ~18x the largest folder, both far
 * below a credential bundle, a database or a log, and the 1 MiB matches the per-file limit bundle inspect
 * already applies.
 */
export const VENDORED_FILE_MAX_BYTES = 1024 * 1024;
export const VENDORED_TREE_MAX_BYTES = 8 * 1024 * 1024;

export const VENDORED_FILE_KIND: GuardedFileKind = {
  label: "bundled file",
  maxBytes: VENDORED_FILE_MAX_BYTES,
  notFoundHint: "a listed file could not be resolved (a broken symlink?); remove it or fix the link",
  notRegularHint: "a bundled folder may hold only regular files and symlinks to regular files inside it (no directories-as-files, pipes, devices or sockets)",
  article: "a bundled file",
};

/** A file or folder bundle create will not copy. A caller-correctable input error (route: 400). */
export class VendoredFileRefused extends Error {}

/**
 * A file that is missing or unreadable (a broken symlink, a removed file, a permission error). NOT a policy
 * refusal: it keeps the errno `code` so the assembler's recovery path (a declared skill that is missing or
 * inaccessible becomes a warning) still sees ENOENT / EACCES, and, as before the guard, it is an ordinary
 * failure (route: 500) when nothing recovers it.
 */
export class VendoredFileUnavailable extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export function checkVendoredFile(
  requested: string,
  resolvedPath: string,
  hooks?: { beforeOpen?: () => void; afterRead?: () => void },
): GuardedFileCheck {
  return checkGuardedFile(VENDORED_FILE_KIND, requested, resolvedPath, hooks);
}

export function isInsideRoot(root: string, target: string): boolean {
  const rel = nodePath.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${nodePath.sep}`) && rel !== ".." && !nodePath.isAbsolute(rel));
}

/** The two filesystem operations the contained read needs. Production passes {@link productionVendoredReadDeps}. */
export interface VendoredReadDeps {
  realpath(path: string): string;
  check(requested: string, resolvedPath: string): GuardedFileCheck;
}

export const productionVendoredReadDeps: VendoredReadDeps = {
  realpath: (p) => realpathSync(p),
  check: (requested, resolved) => checkVendoredFile(requested, resolved),
};

/**
 * Read one file that is about to be copied into a bundle. `realRoot` is the REAL path of the folder it must
 * stay inside (null when only the guard applies, e.g. a docs file whose rig-root containment is checked by the
 * caller). The real location is checked BEFORE the read, so an outside file is never opened, and again on the
 * path the guarded read actually opened, which covers a link retargeted between the two. Throws
 * {@link VendoredFileRefused} for a policy refusal, {@link VendoredFileUnavailable} (code ENOENT / EACCES) for a missing or unreadable file.
 */
export function readContainedVendoredFile(deps: VendoredReadDeps, realRoot: string | null, requested: string, path: string): Uint8Array {
  let real: string;
  try { real = deps.realpath(path); } catch (error) {
    const code = (error as { code?: string })?.code;
    throw new VendoredFileUnavailable(`bundled file "${requested}" could not be resolved (${code ?? "unreadable"}); a broken symlink or a removed file`, code);
  }
  if (realRoot !== null && !isInsideRoot(realRoot, real)) {
    throw new VendoredFileRefused(`bundled file "${requested}" resolves to ${real}, outside its folder ${realRoot}, through a symlink; copy the file into the folder to bundle it`);
  }
  const checked = deps.check(requested, path);
  if (!checked.ok) {
    if (checked.reason === "not_found" || checked.reason === "unreadable") {
      throw new VendoredFileUnavailable(checked.message, checked.reason === "not_found" ? "ENOENT" : "EACCES");
    }
    throw new VendoredFileRefused(checked.message);
  }
  if (realRoot !== null && !isInsideRoot(realRoot, checked.realPath)) {
    throw new VendoredFileRefused(`bundled file "${requested}" resolves to ${checked.realPath}, outside its folder ${realRoot}, through a symlink; copy the file into the folder to bundle it`);
  }
  return checked.raw;
}

/** Running total of the bytes one folder contributes; refuses past VENDORED_TREE_MAX_BYTES. */
export class VendoredTreeBudget {
  private total = 0;
  constructor(private readonly label: string, private readonly maxBytes: number = VENDORED_TREE_MAX_BYTES) {}
  take(bytes: number): void {
    this.total += bytes;
    if (this.total > this.maxBytes) {
      throw new VendoredFileRefused(`${this.label} holds more than ${this.maxBytes} bytes of files; bundle create copies at most that much from one folder`);
    }
  }
}
