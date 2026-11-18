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
