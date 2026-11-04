// A hand-rolled LifecycleDeps with only the members the command under test touches. LifecycleDeps has
// ~10 members (spawn, kill, writeFile, ...) and a status/health probe uses three; a test that lists
// only those gets the full interface here without a per-site cast. Members the test left out are
// absent, so a command that reaches one fails loudly ("is not a function") rather than seeing a default.
import type { LifecycleDeps } from "../../src/daemon-lifecycle.js";

export function asLifecycleDeps(stubs: Partial<LifecycleDeps>): LifecycleDeps {
  return stubs as LifecycleDeps;
}
