// workspaces-o9o.151: test doubles for the CredentialFileReader port (src/domain/credential-file.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectCredentialFile, readCredentialFile } from "../../src/adapters/node-credential-file-reader.js";
import { credentialFileRefusal, type CredentialFileReader } from "../../src/domain/credential-file.js";

/**
 * A reader with no files at all: every read answers "missing". For a test that builds a service needing the port but never
 * reaches hosts.yaml or a bearer file. It also keeps such a test off the operator's real hosts.yaml, which the default
 * registry path would otherwise read.
 */
export const NO_CREDENTIAL_FILES: CredentialFileReader = {
  read: (path, policy) => ({ ok: false, problem: "missing", message: credentialFileRefusal(path, policy, "missing") }),
  inspect: (path, policy) => ({ ok: false, problem: "missing", message: credentialFileRefusal(path, policy, "missing") }),
};

/** A reader over an in-memory map of path → content; any other path is missing. */
export function credentialFilesFrom(files: Record<string, string>): CredentialFileReader {
  return {
    read: (p, policy) => Object.prototype.hasOwnProperty.call(files, p)
      ? { ok: true, content: files[p]! }
      : { ok: false, problem: "missing", message: credentialFileRefusal(p, policy, "missing") },
    inspect: (p, policy) => Object.prototype.hasOwnProperty.call(files, p)
      ? { ok: true }
      : { ok: false, problem: "missing", message: credentialFileRefusal(p, policy, "missing") },
  };
}

/**
 * The production reader, confined to the OS temp directory: a file a test wrote under its own mkdtemp is read under the real rule;
 * any other path (the operator's ~/.openrig/hosts.yaml above all) answers "missing". For a test that writes a real registry or
 * bearer file and points OPENRIG_HOME at it, without reaching the real one when it does not.
 */
/** True when `p` is under the OS temp directory, in either spelling (on macOS os.tmpdir() is a /var/... link to /private/var/...). */
function underTmp(p: string): boolean {
  const abs = path.resolve(p);
  return [os.tmpdir(), fs.realpathSync(os.tmpdir())].some((t) => abs === t || abs.startsWith(t + path.sep));
}

export const TMP_CREDENTIAL_FILES: CredentialFileReader = {
  read: (p, policy) => (underTmp(p) ? readCredentialFile(p, policy) : { ok: false, problem: "missing", message: credentialFileRefusal(p, policy, "missing") }),
  inspect: (p, policy) => (underTmp(p) ? inspectCredentialFile(p, policy) : { ok: false, problem: "missing", message: credentialFileRefusal(p, policy, "missing") }),
};
