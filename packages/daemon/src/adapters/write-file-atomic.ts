import fs from "node:fs";
import nodePath from "node:path";

/**
 * workspaces-o9o.76: write `content` to `path` through an exclusively created sibling temp file (mode `mode` from its creation) renamed over
 * it, so a reader sees the old file or the whole new one, never a partial one. The temp file is removed if anything fails before the rename.
 */
export function writeFileAtomicWithMode(path: string, content: string, mode: number): void {
  const tmp = nodePath.join(nodePath.dirname(path), `.${nodePath.basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let renamed = false;
  try {
    fs.writeFileSync(tmp, content, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);   // an umask must not loosen it
    fs.renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } }
  }
}
