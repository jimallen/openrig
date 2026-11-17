// culture-file-ref.ts — the `shipped:` culture_file reference (workspaces-o9o.52): its shape, and its confinement to the running OpenRig
// install's specs folder. Pure: no filesystem. The one thing it needs from the world, a path's real path, comes in through the
// CulturePathIo port (the realpath half of codex-mcp-servers.ts PathJudgeIo); culture-file-guard.ts supplies the filesystem's.
//
// The rig spec validator imports only the shape check from here, so validating a spec never loads a module that reads files.

import nodePath from "node:path";

/** A culture_file that names a file in the RUNNING OpenRig install's own specs folder. */
export const SHIPPED_CULTURE_PREFIX = "shipped:";

/** Whether a culture_file (or a stored startup file's logical path) is a shipped: reference. */
export function isShippedCulture(path: string): boolean {
  return path.startsWith(SHIPPED_CULTURE_PREFIX);
}

/** The outbound port: the real path of a path (symlinks followed). Throws when there is none (a missing file). */
export interface CulturePathIo {
  realpath(p: string): string;
}

/** Where a shipped: culture_file points, and how it is recorded; or why it is refused. */
export type ShippedCultureTarget =
  | { ok: true; absolutePath: string; ownerRoot: string }
  | { ok: false; message: string };

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep);
}

function realOrSame(io: CulturePathIo, p: string): string {
  try { return io.realpath(p); } catch { return p; }
}

/**
 * The shape of a `shipped:` culture_file: a non-empty relative path that does not climb out (`..`). Null when it is well formed.
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
 * A shipped: culture_file confined to `specsRoot` (the running install's specs folder): both the lexical and the real target must lie inside
 * the folder's real path (no `..` and no symlink out). Recorded AS TYPED under `specsRoot`, with that folder as its owner, so re-anchoring
 * follows a moved or upgraded install (builtin-startup-files.ts).
 */
export function confineShippedCulture(cultureFile: string, specsRoot: string, io: CulturePathIo): ShippedCultureTarget {
  const shape = shippedCultureShapeProblem(cultureFile);
  if (shape) return { ok: false, message: shape };
  const rel = cultureFile.slice(SHIPPED_CULTURE_PREFIX.length);
  const typedRoot = nodePath.resolve(specsRoot);
  const root = realOrSame(io, typedRoot);
  const lexical = nodePath.resolve(root, rel);
  const target = realOrSame(io, lexical);
  if (!isInside(root, lexical) || !isInside(root, target)) {
    return { ok: false, message: `culture_file "${cultureFile}" resolves to ${target}, outside ${root}, the installed OpenRig's specs folder; a shipped: culture_file must stay inside it` };
  }
  return { ok: true, absolutePath: nodePath.resolve(typedRoot, rel), ownerRoot: typedRoot };
}

/**
 * At delivery: the real path of the file actually read must still lie inside the running install's specs folder (a link retargeted out of
 * it after `rig add` or `rig up` is refused, not read). Null when it does; the refusal otherwise.
 */
export function shippedCultureReadProblem(cultureFile: string, realPathRead: string, specsRoot: string, io: CulturePathIo): string | null {
  const root = realOrSame(io, nodePath.resolve(specsRoot));
  return isInside(root, realPathRead)
    ? null
    : `culture file "${cultureFile}" now resolves to ${realPathRead}, outside ${root}, the installed OpenRig's specs folder; a shipped: culture_file must stay inside it`;
}
