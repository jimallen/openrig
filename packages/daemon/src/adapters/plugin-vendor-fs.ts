// The real-filesystem adapter for PluginVendorService's PluginVendorFs port. startup.ts wires this one; the
// real-fs tests use the same object, so what they prove about symlinks and removal is what the daemon does.
import * as fs from "node:fs";
import nodePath from "node:path";
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

export function nodePluginVendorFs(): PluginVendorFs {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
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
    statMode: (p) => fs.statSync(p).mode,
    chmod: (p, m) => fs.chmodSync(p, m),
  };
}
