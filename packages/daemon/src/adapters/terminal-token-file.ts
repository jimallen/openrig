// terminal-token-file.ts — the instance's terminal token file, <OPENRIG_HOME>/terminal-token (workspaces-o9o.78): the adapter side of
// terminal-token-policy.ts's readOrCreateFile port. The same host's rig CLI already sends its contents (cli client.ts resolveTerminalToken).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import { TERMINAL_TOKEN_FILE } from "../domain/terminal-token-policy.js";
import { TERMINAL_TOKEN_POLICY } from "../domain/credential-file.js";
import { narrowOwnSecretFile, readCredentialFile } from "./node-credential-file-reader.js";

/**
 * The token in <openrigHome>/terminal-token, made first when absent: 32 random bytes, hex, created with O_EXCL|O_NOFOLLOW and mode 0600
 * so two daemons starting at once cannot both write it. Refused (throws, so the daemon does not start open) when the path is not a
 * regular file (a link is refused, not followed), belongs to another user, is over the cap, or is empty. A file group or others can
 * read is narrowed to 0600 on the opened descriptor (workspaces-o9o.151: the credential rule, as the activity-hook token).
 */
export function readOrCreateTerminalToken(openrigHome: string): string {
  const file = nodePath.join(openrigHome, TERMINAL_TOKEN_FILE);
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, `${randomBytes(32).toString("hex")}\n`); } finally { fs.closeSync(fd); }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const refused = narrowOwnSecretFile(file, TERMINAL_TOKEN_POLICY);
  if (refused) throw new Error(refused.message);
  const read = readCredentialFile(file, TERMINAL_TOKEN_POLICY);
  if (!read.ok) throw new Error(read.message);
  const token = read.content.trim();
  if (!token) throw new Error(`${file} is empty; remove it and restart to make a new terminal token`);
  return token;
}
