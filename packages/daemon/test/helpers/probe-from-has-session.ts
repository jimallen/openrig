import type { SessionProbe } from "../../src/adapters/tmux.js";

/**
 * `probeSession` for a hand-built tmux double that was written with `hasSession` alone. Decision sites ask the classified
 * probe (OF-177: a host that does not answer is not a session that is gone), so a double needs one. This reads `this.hasSession`
 * at call time, so a test that replaces `hasSession` after building the double (a `mockImplementation`, a spread override)
 * still steers the answer, and a `hasSession` that rejects or never settles rejects or never settles here too.
 * A test that means to show an unreachable host gives its double its own `probeSession`.
 */
export async function probeSessionFromHasSession(this: { hasSession(name: string): unknown }, name: string): Promise<SessionProbe> {
  return (await this.hasSession(name)) ? { state: "present" } : { state: "absent" };
}
