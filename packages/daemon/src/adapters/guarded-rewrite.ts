// guarded-rewrite.ts — node:fs bound to the credential rule's write half (domain/credential-file.ts rewriteGuardedFileWith;
// workspaces-o9o.182). The procedure lives in the domain as a pure function over GuardedFileOps; this file only supplies node:fs.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import {
  guardedFileOpsFrom, rewriteGuardedFileWith, writeReplacingWith,
  type CredentialFilePolicy, type GuardedFileOps, type GuardedRewriteOptions, type GuardedRewriteResult,
} from "../domain/credential-file.js";
import type { CredentialFileReadOptions } from "./node-credential-file-reader.js";

export type { GuardedRewriteOptions, GuardedRewriteResult } from "../domain/credential-file.js";

const processUid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);

/** node:fs as GuardedFileOps (the uid a file must belong to is the process's own unless a test gives another). */
export function nodeGuardedFileOps(options: CredentialFileReadOptions = {}): GuardedFileOps {
  return guardedFileOpsFrom(fs, () => options.currentUid ?? processUid(), () => randomBytes(6).toString("hex"), () => process.pid);
}

/** Read `path` under `policy`, give its content (null when absent) to `mutate`, and write what it returns, under the rule. */
export function rewriteGuardedFile(
  path: string,
  policy: CredentialFilePolicy,
  mutate: (current: string | null) => string | null,
  options: GuardedRewriteOptions & CredentialFileReadOptions = {},
): GuardedRewriteResult {
  return rewriteGuardedFileWith(nodeGuardedFileOps(options), path, policy, mutate, options);
}

/** Write `content` to `target` as a fresh file (mode pinned) renamed over it: never through a link at the target or a temp name. */
export function writeReplacing(target: string, content: string, mode: number): void {
  writeReplacingWith(nodeGuardedFileOps(), target, content, mode);
}
