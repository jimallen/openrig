// terminal-token-file.ts — the instance's terminal token file, <OPENRIG_HOME>/terminal-token (workspaces-o9o.78): the adapter side of
// terminal-token-policy.ts's readOrCreateFile port. The same host's rig CLI already sends its contents (cli client.ts resolveTerminalToken).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { TERMINAL_TOKEN_FILE } from "../domain/terminal-token-policy.js";

/**
 * The token in <openrigHome>/terminal-token, made first when absent: 32 random bytes, hex, created with O_EXCL and mode 0600 so two daemons
 * starting at once cannot both write it. Refused (throws, so the daemon does not start open) when the path is not a regular file (a link is
 * refused, not followed), belongs to another user, or is empty. A file group or others can read is narrowed to 0600.
 */
export function readOrCreateTerminalToken(openrigHome: string): string {
  const file = nodePath.join(openrigHome, TERMINAL_TOKEN_FILE);
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeSync(fd, `${randomBytes(32).toString("hex")}\n`); } finally { fs.closeSync(fd); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a regular file; the terminal token must be a plain file (remove it and restart to make a new one)`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) throw new Error(`${file} belongs to another user; the terminal token must be this user's`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  const token = fs.readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`${file} is empty; remove it and restart to make a new terminal token`);
  return token;
}
