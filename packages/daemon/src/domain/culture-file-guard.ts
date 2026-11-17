import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import { runningShippedSpecsRoot } from "./builtin-startup-files.js";

/**
 * TRUST BOUNDARY (read this before changing anything here).
 *
 * The caller of the daemon API (`rig add --culture`, MCP `rig_add` cultureFile, a rig spec's culture_file)
 * is TRUSTED: whoever can reach the daemon can already start a seat in any folder, so a folder allowlist
 * cannot be the security boundary and there is none. These checks guard against ACCIDENTS and SWAPS, not a
 * hostile caller: a culture file that is a directory, a FIFO or a device, a runaway file, a file replaced by
 * a symlink or another file between the check and the read, or a hard link that aliases some other file.
 * They do not stop a caller from naming a readable regular file such as ~/.ssh/id_rsa.
 *
 * A culture file's content is injected into every seat's startup context. It must be, after realpath
 * (symlinks followed), a regular file with a single link, at most CULTURE_FILE_MAX_BYTES, read through ONE
 * descriptor. The same reader runs again at delivery (every adapter, fresh start and restore), so a FIFO or
 * an oversize file swapped in after `rig add` is refused there instead of hanging the daemon.
 *
 * Every read of the persisted culture path goes through this reader (census by grep of `absolutePath`,
 * `resolved_files_json`, `resolvedStartupFiles`, `GuidanceItem`/`sourcePath` and `readFile` over daemon/src):
 * the four adapters, the seat-lifecycle reload (keeps the flag), restore-guidance (item flag), the startup
 * orchestrator (auto classification, first send_text file) and the instantiator's plan-time auto hint. The
 * other consumers only stat/exist-check the path. RESIDUAL: a CONTENT swap of a regular, single-link,
 * under-cap file between two reads still goes through (the later read re-checks, so only changed text the
 * trusted caller could have named anyway). A legacy node persisted before the `guardedRead` flag keeps its
 * old plain reads until it is re-added. Other startup files (skills, agent files) are not guarded.
 *
 * Cap: the largest culture file in real use, measured 2026-10-14, is 19,385 bytes (the jims-team release
 * CULTURE.md); the next is 17,053. 256 KiB is ~13x the largest and far below any credential bundle or log.
 */
export const CULTURE_FILE_MAX_BYTES = 256 * 1024;

export type GuardedFileCheck =
  | { ok: true; realPath: string; bytes: number; content: string; raw: Buffer; /** Permission bits of the descriptor that was read (st_mode & 0o777). */ mode: number }
  | { ok: false; reason: "not_found" | "not_regular_file" | "hard_linked" | "too_large" | "unreadable" | "changed"; message: string };
export type CultureFileCheck = GuardedFileCheck;

/** What differs between the files this reader guards: only the words in a refusal and the size cap. */
export interface GuardedFileKind {
  /** "culture file", "persona file": the noun every refusal message starts with. */
  label: string;
  maxBytes: number;
  /** Appended to the not-found refusal. */
  notFoundHint: string;
  /** Appended to the not-a-regular-file refusal. */
  notRegularHint: string;
  /** "a culture file": completes "..., so X must have exactly one" and "over the N-byte limit for X". */
  article: string;
  /** A read-only parse may accept a file with more than one hard link (a `cp -al` or pnpm-style tree). Default: refused. */
  allowHardLinks?: boolean;
}

export const CULTURE_FILE_KIND: GuardedFileKind = {
  label: "culture file",
  maxBytes: CULTURE_FILE_MAX_BYTES,
  notFoundHint: "pass a path relative to the rig root (--rig-root) or an absolute path",
  notRegularHint: "pass the path of the rig's culture file",
  article: "a culture file",
};

/**
 * Spec-sized cap for the library scans (spec-library-service, plugin-discovery agent.yaml walk). The largest
 * rig/agent/workflow spec tracked in this repo, measured 2026-10-26 at 18f46db6, is 7,073 bytes. 256 KiB is
 * ~37x that and far below any credential bundle or log. A scan skips (and logs) a file the guard refuses.
 */
export const SPEC_FILE_MAX_BYTES = 256 * 1024;

export const SPEC_FILE_KIND: GuardedFileKind = {
  label: "spec file",
  maxBytes: SPEC_FILE_MAX_BYTES,
  notFoundHint: "it vanished during the scan",
  notRegularHint: "a spec must be a plain file",
  article: "a spec file",
};

/**
 * OF-111: the plugin scan's JSON files (a plugin manifest and the hooks registry it names) live inside scanned plugin
 * roots, so the same accidents apply (a FIFO, a runaway file, a hard link that aliases another file). Spec-sized cap.
 */
export const PLUGIN_JSON_KIND: GuardedFileKind = {
  label: "plugin file",
  maxBytes: SPEC_FILE_MAX_BYTES,
  notFoundHint: "it vanished during the scan",
  notRegularHint: "a plugin manifest or hooks registry must be a plain file",
  article: "a plugin file",
  // Plugins are installed with `cp -al` and pnpm-style layouts; the files are only parsed here (the openrig-lab migration
  // rewrites by temp file and rename, which never writes through a link). Regular file, size cap and one descriptor still apply.
  allowHardLinks: true,
};

/**
 * Check and read one guarded file. Order: realpath (follows every symlink) -> open the RESOLVED path once with
 * O_NOFOLLOW|O_NONBLOCK (a symlink swapped in at the leaf fails; a FIFO swapped in opens instead of hanging)
 * -> fstat that descriptor (regular file, one link, size) -> read from that same descriptor, never past the
 * cap -> re-resolve the path and require the same file (device+inode) at the same real path, which catches a
 * parent directory swapped for a symlink during the window.
 * `requested` is only for messages. Nothing here creates anything: a refusal is a pure return.
 */
export function checkGuardedFile(
  kind: GuardedFileKind,
  requested: string,
  resolvedPath: string,
  /** Test seams only: run exactly in the race windows (before the open / after the read) so the swap
   *  defences can be exercised deterministically. Production callers pass nothing. */
  hooks?: { beforeOpen?: () => void; afterRead?: () => void },
): GuardedFileCheck {
  const { label, maxBytes } = kind;
  let realPath: string;
  try { realPath = realpathSync(resolvedPath); } catch {
    return { ok: false, reason: "not_found", message: `${label} "${requested}" not found (looked at ${resolvedPath}); ${kind.notFoundHint}` };
  }
  let fd: number | undefined;
  try {
    hooks?.beforeOpen?.();
    try { fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); } catch {
      return { ok: false, reason: "unreadable", message: `${label} "${requested}" (${realPath}) is not readable by the daemon (it could not be opened; a symlink swapped in at the last moment is refused too); fix its permissions or pass another path` };
    }
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, reason: "not_regular_file", message: `${label} "${requested}" (${realPath}) is not a regular file (a directory, pipe, device or socket); ${kind.notRegularHint}` };
    }
    if (st.nlink > 1 && !kind.allowHardLinks) {
      return { ok: false, reason: "hard_linked", message: `${label} "${requested}" (${realPath}) has ${st.nlink} hard links; a hard link can alias a file from somewhere else, so ${kind.article} must have exactly one` };
    }
    if (st.size > maxBytes) {
      return { ok: false, reason: "too_large", message: `${label} "${requested}" (${realPath}) is ${st.size} bytes, over the ${maxBytes}-byte limit for ${kind.article}` };
    }
    const buf = Buffer.alloc(maxBytes + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > maxBytes) {
        return { ok: false, reason: "too_large", message: `${label} "${requested}" (${realPath}) grew past the ${maxBytes}-byte limit while being read` };
      }
    }
    hooks?.afterRead?.();
    let same = false;
    try { const again = realpathSync(resolvedPath); const l = lstatSync(again); same = again === realPath && l.ino === st.ino && l.dev === st.dev; } catch { same = false; }
    if (!same) {
      return { ok: false, reason: "changed", message: `${label} "${requested}" changed while it was being checked (${realPath}); refusing, retry once the file is stable` };
    }
    // `raw` is the exact guarded bytes, for a caller that copies the file verbatim (bundle create) and must
    // not round-trip them through a UTF-8 string.
    // Buffer.from(view) copies, but a small Buffer may still be a slice of Node's shared buffer pool: use `raw` as a
    // Buffer (length, equals, write it out), never through `raw.buffer`, which is the whole pool.
    const raw = Buffer.from(buf.subarray(0, n));
    return { ok: true, realPath, bytes: n, content: raw.toString("utf-8"), raw, mode: st.mode & 0o777 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The culture-file flavour of {@link checkGuardedFile}: same reader, culture wording and cap. */
export function checkCultureFile(
  requested: string,
  resolvedPath: string,
  hooks?: { beforeOpen?: () => void; afterRead?: () => void },
): CultureFileCheck {
  return checkGuardedFile(CULTURE_FILE_KIND, requested, resolvedPath, hooks);
}

/**
 * The path to persist for a culture file: the RESOLVED real path, so a later symlink retarget cannot change
 * what delivery and restore read. An unresolvable path is returned lexically resolved; the delivery-time
 * guard then refuses it as not found.
 */
export function persistedCulturePath(resolvedPath: string): string {
  try { return realpathSync(resolvedPath); } catch { return nodePath.resolve(resolvedPath); }
}

/** A culture_file that names a file in the RUNNING OpenRig install's own specs folder (workspaces-o9o.52). */
export const SHIPPED_CULTURE_PREFIX = "shipped:";

/** Where a culture_file points, and how it is recorded as a startup file. */
export type CultureFileTarget =
  | { ok: true; absolutePath: string; ownerRoot: string; shipped: boolean }
  | { ok: false; message: string };

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep);
}
function realOrSame(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The shape of a `shipped:` culture_file, with no filesystem: a non-empty relative path that does not climb out (`..`).
 * Null when it is well formed (the rig spec validator's half of resolveCultureFile).
 */
export function shippedCultureShapeProblem(cultureFile: string): string | null {
  const rel = cultureFile.slice(SHIPPED_CULTURE_PREFIX.length);
  if (!rel) return `culture_file: a shipped: culture_file must name a file (got "${cultureFile}")`;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return `culture_file: a shipped: culture_file must be a path relative to the installed OpenRig's specs folder (got "${cultureFile}")`;
  }
  if (normalized.split("/").some((seg) => seg === "..")) {
    return `culture_file: a shipped: culture_file must stay inside the installed OpenRig's specs folder (got "${cultureFile}")`;
  }
  return null;
}

/**
 * Where a rig's culture_file points (workspaces-o9o.52).
 * - `shipped:<relative>`: a file in the RUNNING install's specs folder (runningShippedSpecsRoot: the daemon module's own location, never
 *   caller input), so one kernel spec serves every host whatever its install prefix. Confined like a shipped: agent_ref
 *   (agent-ref-guard.ts): the lexical AND the real target must lie inside that folder (no `..` and no symlink out). Recorded AS TYPED under
 *   the install root, with the install's specs folder as its owner, so a moved or upgraded install is followed by the existing re-anchoring
 *   (builtin-startup-files.ts), never a version-specific real path that an upgrade removes.
 * - anything else: relative to the rig root (or absolute, for `rig add --culture`), recorded by its real path, as before.
 * Existence and the file itself are judged later by the guarded reader (checkCultureFile), at add and at every delivery.
 */
export function resolveCultureFile(cultureFile: string, rigRoot: string, specsRoot: string = runningShippedSpecsRoot()): CultureFileTarget {
  if (!cultureFile.startsWith(SHIPPED_CULTURE_PREFIX)) {
    return { ok: true, absolutePath: persistedCulturePath(nodePath.resolve(rigRoot, cultureFile)), ownerRoot: rigRoot, shipped: false };
  }
  const shape = shippedCultureShapeProblem(cultureFile);
  if (shape) return { ok: false, message: shape };
  const rel = cultureFile.slice(SHIPPED_CULTURE_PREFIX.length);
  const typedRoot = nodePath.resolve(specsRoot);
  const root = realOrSame(typedRoot);
  const lexical = nodePath.resolve(root, rel);
  const target = realOrSame(lexical);
  if (!isInside(root, lexical) || !isInside(root, target)) {
    return { ok: false, message: `culture_file "${cultureFile}" resolves to ${target}, outside ${root}, the installed OpenRig's specs folder; a shipped: culture_file must stay inside it` };
  }
  return { ok: true, absolutePath: nodePath.resolve(typedRoot, rel), ownerRoot: typedRoot, shipped: true };
}

/**
 * The ONE reader every adapter (claude-code, codex, pi, stub) uses for a startup file flagged
 * `guardedRead` (the rig culture overlay): fresh start and restore alike. Throws with the refusal message,
 * which each adapter already records as a failed startup file (a required file then fails the delivery).
 */
export function readGuardedStartupFile(file: { path: string; absolutePath: string }): string {
  const checked = checkCultureFile(file.path, file.absolutePath);
  if (!checked.ok) throw new Error(checked.message);
  return checked.content;
}
