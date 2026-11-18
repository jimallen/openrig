// node-credential-file-reader.ts — the filesystem side of the CredentialFileReader port (domain/credential-file.ts,
// workspaces-o9o.151). One open, one fstat, one read, all on the same descriptor, so the file judged is the file read.
import fs from "node:fs";
import {
  credentialFileRefusal, judgeOpenedCredentialFile,
  type CredentialFilePolicy, type CredentialFileProblem, type CredentialFileRead, type CredentialFileReader,
} from "../domain/credential-file.js";

export interface CredentialFileReadOptions {
  /** The uid the file must belong to; the process's own by default (a test seam for a foreign owner). */
  currentUid?: number;
}

function refuse(path: string, policy: CredentialFilePolicy, problem: CredentialFileProblem): CredentialFileRead {
  return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
}

/** Read `path` under `policy`. Never throws for a file problem: a refusal names the file and the fix. */
export function readCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): CredentialFileRead {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let target = path;
  if (policy.followLinkToCheckedTarget) {
    // The named exception: a link at the file is followed ONCE, to its real path, and that target is opened with
    // O_NOFOLLOW below, so it is held to the whole rule (a link to a link, or to a file someone else owns, is refused).
    try {
      if (fs.lstatSync(path).isSymbolicLink()) target = fs.realpathSync(path);
    } catch (err) {
      return refuse(path, policy, (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable");
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP (Linux) / EMLINK (macOS) is O_NOFOLLOW meeting a symlink.
    return refuse(path, policy, code === "ENOENT" ? "missing" : code === "ELOOP" || code === "EMLINK" ? "symlink" : "unreadable");
  }
  try {
    const st = fs.fstatSync(fd);
    const problem = judgeOpenedCredentialFile({ isFile: st.isFile(), uid: st.uid, mode: st.mode, size: st.size }, policy, currentUid);
    if (problem) return refuse(path, policy, problem);
    const buf = Buffer.alloc(policy.maxBytes + 1);
    let n = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > policy.maxBytes) return refuse(path, policy, "too_large");
    }
    return { ok: true, content: buf.subarray(0, n).toString("utf8") };
  } catch {
    return refuse(path, policy, "unreadable");
  } finally {
    fs.closeSync(fd);
  }
}

/** The port's production implementation. */
export const nodeCredentialFileReader: CredentialFileReader = { read: (path, policy) => readCredentialFile(path, policy) };

/**
 * For a secret file the daemon itself owns and writes (the terminal token, the activity-hook token): the o9o.78 precedent. A link,
 * a non-file or another user's file is refused; a plain file of ours that group or others can access is narrowed to 0600 on the
 * opened descriptor (fchmod, so the file narrowed is the file checked, never one swapped in by name). Null when it is now fit to be
 * read under the rule; the refusal otherwise. Call readCredentialFile after it.
 */
export function narrowOwnSecretFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): (CredentialFileRead & { ok: false }) | null {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const problem: CredentialFileProblem = code === "ENOENT" ? "missing" : code === "ELOOP" || code === "EMLINK" ? "symlink" : "unreadable";
    return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
  }
  try {
    const st = fs.fstatSync(fd);
    const problem: CredentialFileProblem | null = !st.isFile() ? "not_regular_file" : st.uid !== currentUid ? "wrong_owner" : null;
    if (problem) return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
    if ((st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
