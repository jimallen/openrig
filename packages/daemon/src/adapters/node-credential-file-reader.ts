// node-credential-file-reader.ts — node:fs bound to the credential rule's procedure (domain/credential-file.ts; workspaces-o9o.151,
// o9o.160). The procedure itself lives in the domain as pure functions over CredentialFileOps; this file only supplies node:fs.
// One open, one fstat, one read, all on the same descriptor, so the file judged is the file read.
import fs from "node:fs";
import {
  credentialFileOpsFrom, inspectCredentialFileWith, narrowOwnFileWith, readCredentialFileWith, readOwnFileWith,
  type CredentialFileOps, type CredentialFilePolicy, type CredentialFileRead, type CredentialFileReader, type CredentialFileWarning,
} from "../domain/credential-file.js";

export interface CredentialFileReadOptions {
  /** The uid the file must belong to; the process's own by default (a test seam for a foreign owner). */
  currentUid?: number;
}

const processUid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);

/** node:fs as CredentialFileOps (the uid a file must belong to is the process's own unless a test gives another). */
export function nodeCredentialFileOps(options: CredentialFileReadOptions = {}): CredentialFileOps {
  return credentialFileOpsFrom(fs, () => options.currentUid ?? processUid());
}

const defaultOps = nodeCredentialFileOps();
const opsFor = (options: CredentialFileReadOptions): CredentialFileOps => (options.currentUid === undefined ? defaultOps : nodeCredentialFileOps(options));

/** Read `path` under `policy`. Never throws for a file problem: a refusal names the file and the fix. */
export function readCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): CredentialFileRead {
  return readCredentialFileWith(opsFor(options), path, policy);
}

/** The port's production implementation. */
export const nodeCredentialFileReader: CredentialFileReader = {
  read: (path, policy) => readCredentialFile(path, policy),
  inspect: (path, policy) => inspectCredentialFile(path, policy),
};

/** For a file OpenRig owns and writes: refuse a link (unless the policy follows it), a non-file or another user's file; narrow a
 *  file of ours (a secret to 0600, a registry's group/other write bits). Null when fit to read. readOwnFile does both steps. */
export function narrowOwnFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): (CredentialFileRead & { ok: false }) | null {
  return narrowOwnFileWith(opsFor(options), path, policy);
}

/** narrowOwnFile then readCredentialFile: the read for a file OpenRig owns. */
export function readOwnFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): CredentialFileRead {
  return readOwnFileWith(opsFor(options), path, policy);
}

/** Judge a credential file WITHOUT reading it (the operator's Pi login before a seat is linked to it). */
export function inspectCredentialFile(path: string, policy: CredentialFilePolicy, options: CredentialFileReadOptions = {}): { ok: true; warning?: CredentialFileWarning } | (CredentialFileRead & { ok: false }) {
  return inspectCredentialFileWith(opsFor(options), path, policy);
}
