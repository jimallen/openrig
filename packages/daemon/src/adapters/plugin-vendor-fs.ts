// The real-filesystem adapter for PluginVendorService's PluginVendorFs port. startup.ts wires this one; the
// real-fs tests use the same object, so what they prove about symlinks and removal is what the daemon does.
import * as fs from "node:fs";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";
import type { PluginVendorFs } from "../domain/plugin-vendor-service.js";

/** List every non-directory entry under `dir` as a relative path. A symlink is listed as itself and never followed. */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(nodePath.join(current, entry.name), nodePath.join(prefix, entry.name));
      else files.push(prefix ? nodePath.join(prefix, entry.name) : entry.name);
    }
  };
  walk(dir, "");
  return files;
}

/** The top of the git work tree holding `path` (or its nearest existing parent), symlinks resolved; null if none. */
function gitWorkTreeOf(path: string): string | null {
  let current = nodePath.resolve(path);
  while (!fs.existsSync(current)) {
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  current = fs.realpathSync(current);
  for (;;) {
    // A work tree's .git is a directory, or a file in a linked worktree or a submodule.
    if (fs.lstatSync(nodePath.join(current, ".git"), { throwIfNoEntry: false })) return current;
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Replace `path` atomically: write a temp file in the same directory, created exclusively (O_EXCL, so it never opens
 * through a link planted at its name), set its mode, then rename it over `path` (rename replaces a link at `path`
 * itself, never its target). On any failure the temp this call created is removed and the old file is untouched.
 */
function writeFileAtomic(path: string, content: string, mode?: number): void {
  const temp = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.openrig-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temp, "wx", mode ?? 0o644);
    created = true;
    try { fs.writeFileSync(fd, content, "utf-8"); } finally { fs.closeSync(fd); }
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, path);
    created = false;
  } catch (err) {
    if (created) { try { fs.unlinkSync(temp); } catch { /* best effort: the original error is the one to report */ } }
    throw err;
  }
}

export function nodePluginVendorFs(): PluginVendorFs {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: writeFileAtomic,
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    listFiles,
    lstat: (p) => {
      const stat = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!stat) return null;
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isDirectory()) return "directory";
      return stat.isFile() ? "file" : "other";
    },
    removeFile: (p) => fs.unlinkSync(p),
    gitWorkTreeOf,
    statMode: (p) => fs.statSync(p).mode,
    chmod: (p, m) => fs.chmodSync(p, m),
  };
}
