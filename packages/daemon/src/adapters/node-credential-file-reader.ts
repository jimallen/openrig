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

/**
 * Where to open, per the policy (the open never follows a link, so the file opened is held to the whole rule): with a linkTarget (one of
 * SEAT_CREDENTIAL_LINKS) a link is followed only when it resolves to exactly that file; without one, the path itself, so a link is
 * refused by the open. Shared by read and inspect (o9o.151 fix: inspect had skipped it, refusing the correct seat link).
 */
function resolveLinkTarget(path: string, policy: CredentialFilePolicy): { target: string } | { problem: CredentialFileProblem } {
  if (policy.linkTarget === undefined) return { target: path };
  try {
    if (!fs.lstatSync(path).isSymbolicLink()) return { target: path };
    const real = fs.realpathSync(path);
    let expected: string;
    try { expected = fs.realpathSync(policy.linkTarget); } catch { return { problem: "unexpected_link_target" }; }
    return real === expected ? { target: real } : { problem: "unexpected_link_target" };
  } catch (err) {
    return { problem: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/** Read `path` under `policy`. Never throws for a file problem: a refusal names the file and the fix. */
export function readCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): CredentialFileRead {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const resolved = resolveLinkTarget(path, policy);
  if ("problem" in resolved) return refuse(path, policy, resolved.problem);
  const target = resolved.target;
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
    const problem = judgeOpenedCredentialFile({ isFile: st.isFile(), nlink: st.nlink, uid: st.uid, mode: st.mode, size: st.size }, policy, currentUid);
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
export const nodeCredentialFileReader: CredentialFileReader = {
  read: (path, policy) => readCredentialFile(path, policy),
  inspect: (path, policy) => inspectCredentialFile(path, policy),
};

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
    // Before any chmod (ruling (c)): a hard-linked name would let the fchmod change another name's file.
    const problem: CredentialFileProblem | null = !st.isFile() ? "not_regular_file" : st.nlink > 1 ? "hard_linked" : st.uid !== currentUid ? "wrong_owner" : null;
    if (problem) return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
    if ((st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Judge a credential file WITHOUT reading it: one O_NOFOLLOW|O_NONBLOCK open, fstat, the same verdict as readCredentialFile, close.
 * For a file OpenRig must vouch for but has no business reading: the operator's Pi login before a seat is linked to it (OF-279's
 * rule that the operator's files are never read). The result carries no content.
 */
export function inspectCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): { ok: true } | (CredentialFileRead & { ok: false }) {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const resolved = resolveLinkTarget(path, policy);
  if ("problem" in resolved) return { ok: false, problem: resolved.problem, message: credentialFileRefusal(path, policy, resolved.problem) };
  let fd: number;
  try {
    fd = fs.openSync(resolved.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const problem: CredentialFileProblem = code === "ENOENT" ? "missing" : code === "ELOOP" || code === "EMLINK" ? "symlink" : "unreadable";
    return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
  }
  try {
    const st = fs.fstatSync(fd);
    const problem = judgeOpenedCredentialFile({ isFile: st.isFile(), nlink: st.nlink, uid: st.uid, mode: st.mode, size: st.size }, policy, currentUid);
    return problem ? { ok: false, problem, message: credentialFileRefusal(path, policy, problem) } : { ok: true };
  } finally {
    fs.closeSync(fd);
  }
}
