// workspaces-o9o.25: a seat's plugin copy (.claude/plugins/<id>, .codex/plugins/<id>) must follow its source, so a file
// the source dropped is removed from the copy. Deleting inside a seat folder cannot be undone, so this removes only what
// OpenRig's own projection manifest says it wrote there, only while the file still holds exactly those bytes (an
// operator's edit is kept and reported), never through a link (every component below the seat folder must be a real
// directory and the file a regular file), and never a file another seat still projects: seats can share a cwd, and so a
// plugin folder (verify-sec review). Pure policy over three ports: the filesystem, the manifest and the claims.
import nodePath from "node:path";
import { hashContent } from "./conflict-detector.js";

/** What OpenRig recorded writing (projection_manifest, through ProjectionManifestStore). */
export interface ProjectionLedger {
  lastHash(targetPath: string): string | null;
  forget(targetPath: string): void;
}

/** Which seats' projections still want each file in a plugin copy (plugin_copy_claims; adapters/sqlite-plugin-copy-claims). */
export interface PluginCopyClaims {
  /** The files `owner` claims strictly inside `dir`. */
  claimedUnder(dir: string, owner: string): string[];
  /** Every seat that claims `targetPath`. */
  claimants(targetPath: string): string[];
  /** Make `owner`'s claims inside `dir` exactly `targets`. */
  setClaims(dir: string, owner: string, targets: ReadonlySet<string>, at: string): void;
  /** Drop `owner`'s claim on a file, never another seat's (o9o.25 review r2). */
  forgetClaim(targetPath: string, owner: string): void;
  /**
   * Run `fn` holding the lock for one plugin target, so a projection's copy, its claims, the check and the unlink are one
   * unit against any other projection of the same target (o9o.25 review r2). The SQLite adapter takes the database's
   * write lock (BEGIN IMMEDIATE), which also serializes another process using the same database.
   */
  withTargetLock<T>(dir: string, fn: () => T): T;
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
 * Record that `owner` (the seat's node id) projects exactly `wanted` (absolute paths) into `targetDir` (its plugin copy,
 * inside `cwd`), then remove each file `owner` claimed before and no longer projects, when no other seat claims it, the
 * manifest records OpenRig writing it, it still holds those bytes, and no component below the seat folder is a link.
 * Files nobody claimed (written before claims existed) are never removed. Returns warnings for what it kept and why.
 * Residuals, both outside the threat model: (1) the one o9o.17 accepted on 2026-11-16 by OpenRig's 15-minute
 * auto-answer (its Recommended option, queue record qa-f5c084b1679e94516e44aff1e88a8361; under Jim's 2026-11-08 rule
 * that is his go): a component swapped for a link between the lstat walk and the unlink; (2) a manifest or claims row
 * hand-edited to authorize a delete (verify-sec review, declined by the CoS 2026-11-17). Both need a concurrent process
 * running as the same user, writing inside the seat folder or OpenRig's own database.
 */
export function pruneDroppedPluginFiles(input: {
  cwd: string;
  targetDir: string;
  wanted: ReadonlySet<string>;
  owner?: string;
  ledger?: ProjectionLedger;
  claims?: PluginCopyClaims;
  fs: PluginCopyPruneFs;
  now?: () => string;
}): string[] {
  const { cwd, targetDir, wanted, owner, ledger, claims, fs } = input;
  if (!owner || !ledger || !claims || !fs.lstat || !fs.removeFile || !inside(cwd, targetDir)) return [];
  const previous = claims.claimedUnder(targetDir, owner);
  claims.setClaims(targetDir, owner, wanted, (input.now ?? (() => new Date().toISOString()))());
  const warnings: string[] = [];
  for (const targetPath of previous) {
    if (wanted.has(targetPath) || !inside(targetDir, targetPath)) continue;
    if (claims.claimants(targetPath).length > 0) continue; // another seat sharing this folder still projects it
    const lastHash = ledger.lastHash(targetPath);
    if (lastHash === null) continue; // OpenRig has no record of writing it
    // Walk every component below the seat folder: a link anywhere refuses, a missing one means the file is gone.
    let current = cwd;
    let verdict = "file";
    const parts = nodePath.relative(cwd, targetPath).split(nodePath.sep);
    for (const [index, part] of parts.entries()) {
      current = nodePath.join(current, part);
      const kind = fs.lstat(current);
      if (kind === null) { verdict = "gone"; break; }
      if (kind === "symlink") { verdict = `${current} is a symlink`; break; }
      const last = index === parts.length - 1;
      if (last ? kind !== "file" : kind !== "directory") { verdict = `${current} is not a ${last ? "regular file" : "directory"}`; break; }
    }
    if (verdict === "gone") { ledger.forget(targetPath); claims.forgetClaim(targetPath, owner); continue; }
    if (verdict !== "file") {
      warnings.push(`plugin_copy_prune_skipped: ${targetPath}: ${verdict}; nothing was removed through it`);
      continue;
    }
    if (hashContent(fs.readFile(targetPath)) !== lastHash) {
      warnings.push(`plugin_copy_prune_kept: ${targetPath} is no longer in the plugin's source but was changed since OpenRig wrote it, so it was kept`);
      continue;
    }
    // Re-check right before the unlink: a claim made since the first check keeps the file (o9o.25 review r2).
    if (claims.claimants(targetPath).length > 0) continue;
    fs.removeFile(targetPath);
    ledger.forget(targetPath);
    claims.forgetClaim(targetPath, owner);
  }
  return warnings;
}
