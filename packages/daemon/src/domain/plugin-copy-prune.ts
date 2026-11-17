// workspaces-o9o.25: a seat's plugin copy (.claude/plugins/<id>, .codex/plugins/<id>) must follow its source, so a file
// the source dropped is removed from the copy. Deleting inside a seat folder cannot be undone, so this removes only what
// OpenRig's own projection manifest says it wrote there, only while the file still holds exactly those bytes (an
// operator's edit is kept and reported), and never through a link: every component below the seat folder must be a
// real directory and the file a regular file. Pure policy over two ports (the filesystem and the manifest).
import nodePath from "node:path";
import { hashContent } from "./conflict-detector.js";

/** What OpenRig recorded writing (projection_manifest, through ProjectionManifestStore). */
export interface ProjectionLedger {
  listUnder(dir: string): Array<{ targetPath: string; lastHash: string }>;
  forget(targetPath: string): void;
}

/** The filesystem the prune needs. Without lstat or removeFile nothing is removed. */
export interface PluginCopyPruneFs {
  readFile(path: string): string;
  lstat?(path: string): "file" | "directory" | "symlink" | "other" | null;
  removeFile?(path: string): void;
}

const inside = (outer: string, inner: string): boolean => {
  const rel = nodePath.relative(outer, inner);
  return !!rel && rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel);
};

/**
 * Remove from `targetDir` (a seat's plugin copy, inside `cwd`) every file OpenRig recorded writing there that is not in
 * `wanted` (the absolute paths this projection just wrote or confirmed). Returns warnings for what it kept and why.
 * Residual (as in o9o.17, accepted by Jim 2026-11-16): a component swapped for a link between the lstat walk and the
 * unlink; that needs a concurrent same-user writer inside the seat folder.
 */
export function pruneDroppedPluginFiles(input: {
  cwd: string;
  targetDir: string;
  wanted: ReadonlySet<string>;
  ledger?: ProjectionLedger;
  fs: PluginCopyPruneFs;
}): string[] {
  const { cwd, targetDir, wanted, ledger, fs } = input;
  if (!ledger || !fs.lstat || !fs.removeFile || !inside(cwd, targetDir)) return [];
  const warnings: string[] = [];
  for (const { targetPath, lastHash } of ledger.listUnder(targetDir)) {
    if (wanted.has(targetPath) || !inside(targetDir, targetPath)) continue;
    // Walk every component below the seat folder: a link anywhere refuses, a missing one means the file is gone.
    let current = cwd;
    let verdict: "file" | "gone" | string = "file";
    const parts = nodePath.relative(cwd, targetPath).split(nodePath.sep);
    for (const [index, part] of parts.entries()) {
      current = nodePath.join(current, part);
      const kind = fs.lstat(current);
      if (kind === null) { verdict = "gone"; break; }
      if (kind === "symlink") { verdict = `${current} is a symlink`; break; }
      const last = index === parts.length - 1;
      if (last ? kind !== "file" : kind !== "directory") { verdict = `${current} is not a ${last ? "regular file" : "directory"}`; break; }
    }
    if (verdict === "gone") { ledger.forget(targetPath); continue; }
    if (verdict !== "file") {
      warnings.push(`plugin_copy_prune_skipped: ${targetPath}: ${verdict}; nothing was removed through it`);
      continue;
    }
    if (hashContent(fs.readFile(targetPath)) !== lastHash) {
      warnings.push(`plugin_copy_prune_kept: ${targetPath} is no longer in the plugin's source but was changed since OpenRig wrote it, so it was kept`);
      continue;
    }
    fs.removeFile(targetPath);
    ledger.forget(targetPath);
  }
  return warnings;
}
