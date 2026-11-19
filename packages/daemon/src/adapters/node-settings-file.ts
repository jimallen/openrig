// node-settings-file.ts — config.json for SettingsStore (workspaces-6ul): the read under the credential rule (o9o.160) and the
// link-following atomic write, moved here unchanged from domain/user-settings/settings-store.ts, plus the instance home the path
// defaults derive from. openSettingsStore is how the daemon builds its store.
import {
  chmodSync, chownSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { OPENRIG_CONFIG_POLICY, type CredentialFileRead } from "../domain/credential-file.js";
import type { SettingsFile } from "../domain/user-settings/settings-file.js";
import {
  defaultClaudeCompactionExtraInstructionFilePath, DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT, SettingsStore,
} from "../domain/user-settings/settings-store.js";
import { readOwnFile } from "./node-credential-file-reader.js";

/** The instance home: OPENRIG_HOME, else the legacy RIGGED_HOME, else ~/.openrig. Read once, when this module loads, as the
 *  store's defaults always were. */
export const DEFAULT_OPENRIG_HOME = process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig");
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_OPENRIG_HOME, "config.json");

export class NodeSettingsFile implements SettingsFile {
  constructor(readonly path: string) {}

  read(): CredentialFileRead {
    return readOwnFile(this.path, OPENRIG_CONFIG_POLICY);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  remove(): void {
    try { unlinkSync(this.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  write(content: string): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
    let target = this.path;
    // Follow config-file links just as writeFileSync did; rename the target,
    // never the link. A dangling final target is still created normally.
    for (let depth = 0; ; depth++) {
      const entry = lstatSync(target, { throwIfNoEntry: false });
      if (!entry?.isSymbolicLink()) break;
      if (depth >= 40) throw Object.assign(new Error("Too many config symlinks"), { code: "ELOOP" });
      target = path.resolve(path.dirname(target), readlinkSync(target));
    }
    const existing = statSync(target, { throwIfNoEntry: false });
    // Match direct writes: a writable directory must not bypass a read-only
    // target. Opening without truncation also checks native ACL permissions.
    if (existing) closeSync(openSync(target, "r+"));
    const temporary = `${target}.tmp-${randomUUID()}`;
    let owned = false;
    let canFallBack = true;
    try {
      // Atomic replacement requires directory create/rename permission. Keep
      // staged bytes private until the original ownership and mode are restored.
      const fd = openSync(temporary, "wx", 0o600);
      owned = true;
      // A failed data write must never retry against the original file.
      canFallBack = false;
      try { writeFileSync(fd, content, "utf-8"); } finally { closeSync(fd); }
      canFallBack = true;
      if (existing && process.platform !== "win32") {
        const staged = statSync(temporary);
        if (staged.uid !== existing.uid || staged.gid !== existing.gid) {
          try { chownSync(temporary, existing.uid, existing.gid); }
          catch (error) {
            throw Object.assign(new Error(`Cannot preserve config ownership at ${target}: ${(error as Error).message}`),
              { code: (error as NodeJS.ErrnoException).code });
          }
        }
      }
      // chown may clear permission bits, so apply the final mode afterward.
      chmodSync(temporary, existing ? existing.mode & 0o777 : 0o666 & ~process.umask());
      renameSync(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (canFallBack && (code === "EACCES" || code === "EPERM" || code === "EBUSY")) {
        // Preserve setups that permit writing the file but not replacing it,
        // such as an unwritable parent or a single-file bind mount.
        writeFileSync(target, content, "utf-8");
        return;
      }
      throw error;
    } finally {
      if (owned) try { unlinkSync(temporary); } catch { /* Renamed or already removed. */ }
    }
  
  }
}

/** The daemon's settings store: config.json at `configPath` (the instance's own by default), path defaults under the instance home. */
export function openSettingsStore(configPath: string = DEFAULT_CONFIG_PATH): SettingsStore {
  return new SettingsStore(new NodeSettingsFile(configPath), DEFAULT_OPENRIG_HOME);
}

/** Seed the default Claude compaction extra-instruction file under `openrigHome` when it is absent; returns its path. */
export function ensureDefaultClaudeCompactionFiles(openrigHome: string = DEFAULT_OPENRIG_HOME): string {
  const filePath = defaultClaudeCompactionExtraInstructionFilePath(openrigHome);
  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT, "utf-8");
  }
  return filePath;
}
