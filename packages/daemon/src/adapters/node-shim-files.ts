import { constants as fsConstants, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import type { ShimEntry, ShimFiles } from "../domain/git-worktree-shim.js";

/**
 * workspaces-o9o.50: the node:fs adapter for the git worktree shim's ShimFiles port (src/domain/git-worktree-shim.ts).
 * Wired in startup.ts for the daemon-start refresh and the NodeLauncher's seat-launch refresh.
 */
export const nodeShimFiles: ShimFiles = {
  async entryAt(p: string): Promise<ShimEntry> {
    try {
      const st = await fs.lstat(p);
      return st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : st.isFile() ? "file" : "other";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw err;
    }
  },

  async makeFolder(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  },

  async readShim(p: string): Promise<{ body: Uint8Array; mode: number }> {
    const fh = await fs.open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return { body: await fh.readFile(), mode: (await fh.stat()).mode & 0o777 };
    } finally {
      await fh.close();
    }
  },

  async writeAtomically(folder: string, file: string, body: string, mode: number): Promise<void> {
    const tmp = path.join(folder, `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const fh = await fs.open(tmp, "wx", mode);
    try {
      try {
        await fh.writeFile(body, "utf8");
        await fh.chmod(mode);
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  },
};
