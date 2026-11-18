// workspaces-o9o.151: test doubles for the CredentialFileReader port (src/domain/credential-file.ts).
import { credentialFileRefusal, type CredentialFileReader } from "../../src/domain/credential-file.js";

/**
 * A reader with no files at all: every read answers "missing". For a test that builds a service needing the port but never
 * reaches hosts.yaml or a bearer file. It also keeps such a test off the operator's real hosts.yaml, which the default
 * registry path would otherwise read.
 */
export const NO_CREDENTIAL_FILES: CredentialFileReader = {
  read: (path, policy) => ({ ok: false, problem: "missing", message: credentialFileRefusal(path, policy, "missing") }),
};

/** A reader over an in-memory map of path → content; any other path is missing. */
export function credentialFilesFrom(files: Record<string, string>): CredentialFileReader {
  return {
    read: (path, policy) => Object.prototype.hasOwnProperty.call(files, path)
      ? { ok: true, content: files[path]! }
      : { ok: false, problem: "missing", message: credentialFileRefusal(path, policy, "missing") },
  };
}
