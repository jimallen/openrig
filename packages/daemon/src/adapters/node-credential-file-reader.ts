// node-credential-file-reader.ts — the filesystem side of the CredentialFileReader port (domain/credential-file.ts,
// workspaces-o9o.151). One open, one fstat, one read, all on the same descriptor, so the file judged is the file read.
import fs from "node:fs";
import {
  credentialFileRefusal, judgeOpenedCredentialFile,
  type CredentialFilePolicy, type CredentialFileProblem, type CredentialFileRead, type CredentialFileReader, type CredentialFileWarning,
} from "../domain/credential-file.js";

export interface CredentialFileReadOptions {
  /** The uid the file must belong to; the process's own by default (a test seam for a foreign owner). */
  currentUid?: number;
}

function refuse(path: string, policy: CredentialFilePolicy, problem: CredentialFileProblem): CredentialFileRead {
  return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
}

/**
 * Where to open, per the policy's link mode (the open itself is always O_NOFOLLOW, so the file opened is held to the whole rule):
 * - linkTarget (SEAT_CREDENTIAL_LINKS): a link is followed only when it resolves to exactly that file;
 * - followLinks (config.json, a supported dotfiles layout; o9o.160): a link is followed to its real target, wherever it is;
 * - neither: the path itself, so a link is refused by the open.
 */
function resolveLinkedTarget(path: string, policy: CredentialFilePolicy): string | { problem: CredentialFileProblem } {
  if (policy.linkTarget === undefined && !policy.followLinks) return path;
  try {
    if (!fs.lstatSync(path).isSymbolicLink()) return path;
    const real = fs.realpathSync(path);
    if (policy.linkTarget === undefined) return real;
    let expected: string;
    try { expected = fs.realpathSync(policy.linkTarget); } catch { return { problem: "unexpected_link_target" }; }
    return real === expected ? real : { problem: "unexpected_link_target" };
  } catch (err) {
    return { problem: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/** Read `path` under `policy`. Never throws for a file problem: a refusal names the file and the fix. */
export function readCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): CredentialFileRead {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const resolved = resolveLinkedTarget(path, policy);
  if (typeof resolved !== "string") return refuse(path, policy, resolved.problem);
  const target = resolved;
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
    const warning = warnedProblem(path, policy, problem);
    if (problem && !warning) return refuse(path, policy, problem);
    const buf = Buffer.alloc(policy.maxBytes + 1);
    let n = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > policy.maxBytes) return refuse(path, policy, "too_large");
    }
    return warning ? { ok: true, content: buf.subarray(0, n).toString("utf8"), warning } : { ok: true, content: buf.subarray(0, n).toString("utf8") };
  } catch {
    return refuse(path, policy, "unreadable");
  } finally {
    fs.closeSync(fd);
  }
}

/** o9o.160: the one problem a policy may downgrade to a warning (group/other write on a registry OpenRig does not own). */
function warnedProblem(path: string, policy: CredentialFilePolicy, problem: CredentialFileProblem | null): CredentialFileWarning | undefined {
  if (problem !== "group_or_other_write" || policy.groupOrOtherWrite !== "warn") return undefined;
  return { problem, message: credentialFileRefusal(path, policy, problem) };
}

/** The port's production implementation. */
export const nodeCredentialFileReader: CredentialFileReader = {
  read: (path, policy) => readCredentialFile(path, policy),
  inspect: (path, policy) => inspectCredentialFile(path, policy),
};

/**
 * For a file OpenRig itself owns and writes (the terminal and activity-hook tokens, a Pi seat's own credential files; o9o.160: the
 * daemon state file, the OpenRig config, the Slack connector config): the o9o.78 precedent. A link, a non-file or another user's
 * file is refused; a plain file of ours is narrowed on the opened descriptor (fchmod, so the file narrowed is the file checked,
 * never one swapped in by name): a secret to 0600, a registry by clearing its group/other WRITE bits only. Null when it is now fit
 * to be read under the rule; the refusal otherwise. readOwnFile does both steps.
 */
export function narrowOwnFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): (CredentialFileRead & { ok: false }) | null {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const resolved = resolveLinkedTarget(path, policy);
  if (typeof resolved !== "string") return { ok: false, problem: resolved.problem, message: credentialFileRefusal(path, policy, resolved.problem) };
  const target = resolved;
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
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
    if (policy.kind === "secret" && (st.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);
    if (policy.kind === "registry" && (st.mode & 0o022) !== 0) fs.fchmodSync(fd, st.mode & 0o7777 & ~0o022);
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
/** narrowOwnFile then readCredentialFile: the read for a file OpenRig owns. */
export function readOwnFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): CredentialFileRead {
  return narrowOwnFile(path, policy, options) ?? readCredentialFile(path, policy, options);
}

export function inspectCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): { ok: true; warning?: CredentialFileWarning } | (CredentialFileRead & { ok: false }) {
  const currentUid = options.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const resolved = resolveLinkedTarget(path, policy);
  if (typeof resolved !== "string") return { ok: false, problem: resolved.problem, message: credentialFileRefusal(path, policy, resolved.problem) };
  const target = resolved;
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const problem: CredentialFileProblem = code === "ENOENT" ? "missing" : code === "ELOOP" || code === "EMLINK" ? "symlink" : "unreadable";
    return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
  }
  try {
    const st = fs.fstatSync(fd);
    const problem = judgeOpenedCredentialFile({ isFile: st.isFile(), nlink: st.nlink, uid: st.uid, mode: st.mode, size: st.size }, policy, currentUid);
    const warning = warnedProblem(path, policy, problem);
    if (problem && !warning) return { ok: false, problem, message: credentialFileRefusal(path, policy, problem) };
    return warning ? { ok: true, warning } : { ok: true };
  } finally {
    fs.closeSync(fd);
  }
}
