import { chmodSync, lstatSync, readdirSync } from "node:fs";
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
    list: (dir) => readdirSync(dir),
    chmod: (path, mode) => chmodSync(path, mode),
  };
}
