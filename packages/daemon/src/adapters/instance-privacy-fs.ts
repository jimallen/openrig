import { chmodSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { InstanceEntryKind, InstancePrivacyPort } from "../domain/instance-privacy.js";

/** The node filesystem behind the instance privacy port (workspaces-o9o.36). lstat only: a symlink is reported as a
 * symlink and never resolved. */
export function nodeInstancePrivacy(opts: { userHome?: string } = {}): InstancePrivacyPort {
  return {
    userHome: opts.userHome ?? homedir(),
    entry(path) {
      try {
        const stat = lstatSync(path);
        const kind: InstanceEntryKind = stat.isSymbolicLink() ? "symlink"
          : stat.isDirectory() ? "directory"
          : stat.isFile() ? "file"
          : "other";
        return { kind, mode: stat.mode & 0o777 };
      } catch {
        return null;
      }
    },
    realPath(path) {
      // Resolve the longest part that exists; the rest does not exist yet, so it holds no symlink.
      let existing = resolve(path);
      const missing: string[] = [];
      for (;;) {
        try {
          return join(realpathSync(existing), ...missing);
        } catch {
          const parent = dirname(existing);
          if (parent === existing) return resolve(path);
          missing.unshift(basename(existing));
          existing = parent;
        }
      }
    },
    list: (dir) => readdirSync(dir),
    chmod: (path, mode) => chmodSync(path, mode),
  };
}
