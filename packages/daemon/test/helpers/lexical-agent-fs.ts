import type { AgentResolverFsOps, GuardedAgentResolverFsOps } from "../../src/domain/agent-resolver.js";

/**
 * An in-memory (or plain node:fs) test filesystem typed as the guarded production one (OF-134).
 *
 * Production must spread `guardedAgentRefFsOps` (agent-ref-guard.ts); `GuardedAgentResolverFsOps` requires its two
 * members so a construction that forgets them fails to compile. Test filesystems leave them out, and the resolver
 * then checks refs lexically and reads agent.yaml with `readFile`. This adds the two members with exactly that
 * behaviour, so nothing a test observes changes:
 *  - `realpath` returns the path unchanged, as the resolver does when `realpath` is absent (agent-resolver.ts
 *    `realpath ? realpath(p) : p`, agent-ref-guard.ts `realOrSame`);
 *  - `readPersonaFile` calls the returned object's own `readFile` at call time, as the resolver does when
 *    `readPersonaFile` is absent, so a test that later replaces `readFile` (or spies on it) sees the same calls.
 * Members the filesystem already has are kept.
 */
export function lexicalAgentFs<T extends AgentResolverFsOps>(fs: T): T & GuardedAgentResolverFsOps {
  const out = {
    ...fs,
    realpath: fs.realpath ?? ((path: string): string => path),
    readPersonaFile: fs.readPersonaFile ?? ((path: string): string => out.readFile(path)),
  };
  return out;
}
